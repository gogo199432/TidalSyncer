import { isAbsolute, relative, resolve } from "node:path";
import type { LogLevel } from "./logger.ts";

export type Config = {
  listenBrainzUser: string;
  listenBrainzApiUrl: string;
  /**
   * User token from listenbrainz.org/settings. Reading playlists needs no token, so this
   * stays empty unless `syncFavorites` is on — that direction writes to the account.
   */
  listenBrainzToken: string;
  musicBrainzApiUrl: string;
  /**
   * Only sync playlists whose `source_patch` is in this list. Empty means no filter,
   * which mirrors every family `createdfor` returns — including the one-off year-in-review
   * lists that never change again.
   */
  sourcePatchAllowlist: string[];
  tidal: {
    clientId: string;
    clientSecret: string;
    /** Must exactly match a redirect URI registered on the app at developer.tidal.com. */
    redirectUri: string;
    countryCode: string;
    /**
     * Source patches whose tracks should be dropped when they are already in the user's
     * TIDAL collection. Empty disables the feature entirely — which also keeps the
     * `collection.read` scope off the token, so no re-authorisation is needed.
     */
    skipCollectionFor: string[];
    /** Name template for the mirrored playlist. `{title}` is the humanised source patch. */
    playlistNameTemplate: string;
    playlistAccess: "PUBLIC" | "UNLISTED";
    /**
     * Client id used by `download` only, and necessarily *not* the developer-portal one
     * above: TIDAL grants playback to its own players, so a developer-portal token gets a
     * 30-second preview no matter whose subscription is behind it. Empty disables
     * downloading entirely; see src/tidal/device-auth.ts.
     */
    deviceClientId: string;
    /** Only some player clients require a secret alongside the id. */
    deviceClientSecret: string;
    /**
     * Pause between track downloads. TIDAL answers a burst on the manifest endpoint with
     * 429s and eventually a captcha that deauthenticates the session, so the default is
     * deliberately unhurried.
     */
    downloadDelayMs: number;
  };
  /** Where `download` writes audio files, in `Artist/Album/Title.flac` layout. */
  libraryDir: string;
  /** Default tier for `download`; it walks down from here when a track is not entitled. */
  downloadQuality: "hires" | "lossless" | "high" | "low";
  /**
   * How closely a file already in `libraryDir` must match before `download` skips the
   * track. Loosening this avoids redundant downloads into a library another tool built,
   * at the cost of occasionally skipping a version you wanted.
   */
  skipTier: "exact" | "album-agnostic" | "loose";
  /**
   * Default for `download --upgrade`: replace a file already in the library when TIDAL has
   * a better one. Off by default — it is the only mode that touches files you already have.
   */
  upgrade: boolean;
  /**
   * Where `--upgrade` puts the file it replaced. Empty means delete it instead, which is a
   * deliberate choice rather than a default: replacing most of a library can retire several
   * gigabytes, and that has to land somewhere with room for it. Nothing is ever removed
   * until the replacement is written either way.
   */
  replacedDir: string;
  /**
   * How long a retired file is kept in `replacedDir` before a download prunes it. Zero keeps
   * them for ever, which is what you want only if you are pruning by hand.
   *
   * A window rather than a schedule on purpose: "empty it every Sunday" would give a file
   * retired on Saturday night a day of undo, where this gives every file the same week.
   */
  replacedRetentionDays: number;
  /**
   * Mirror the TIDAL collection's tracks back to ListenBrainz as loved recordings.
   * Additive only: a track dropped from the collection keeps its ListenBrainz love.
   */
  syncFavorites: boolean;
  /** Directory holding credentials, sync state and the lookup cache. */
  dataDir: string;
  /** Cron expression used by `daemon`. */
  schedule: string;
  /**
   * Run the backup — snapshot the catalogue, then fill `libraryDir` from it — on the same
   * schedule as the playlist sync, right after it.
   *
   * On by default, but it can only actually do anything once `download` is set up: a daemon
   * with no `deviceClientId` or no stored playback session skips it and says why, so this
   * costs nothing on an install that only mirrors playlists.
   */
  backupOnSchedule: boolean;
  timezone: string;
  /**
   * Status page served by `daemon`: sync stats, the next scheduled run, and a button that
   * triggers one now. Unauthenticated, so it belongs on a trusted network only.
   */
  dashboard: {
    enabled: boolean;
    /** 0.0.0.0 by default so the page is reachable from outside the container. */
    host: string;
    port: number;
  };
  /** Contact address embedded in the MusicBrainz User-Agent, as their API requires. */
  contactEmail: string;
  logLevel: LogLevel;
  dryRun: boolean;
};

const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

const DOWNLOAD_QUALITIES = new Set(["hires", "lossless", "high", "low"]);

const SKIP_TIERS = new Set(["exact", "album-agnostic", "loose"]);

class ConfigError extends Error {}

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new ConfigError(`Missing required environment variable ${key}`);
  return value;
}

function optional(key: string, fallback: string): string {
  const value = process.env[key]?.trim();
  return value ? value : fallback;
}

function boolean(key: string, fallback: boolean): boolean {
  const value = process.env[key]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  return value === "1" || value === "true" || value === "yes";
}

function integer(key: string, fallback: number, min: number, max: number): number {
  const value = process.env[key]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${key} must be an integer between ${min} and ${max} (got "${value}")`);
  }
  return parsed;
}

/**
 * The playlists ListenBrainz actually keeps regenerating. `createdfor` also serves one-off
 * year-in-review lists (top-discoveries-of-2019, ...) that never change again, so mirroring
 * them would just clutter TIDAL with dozens of frozen playlists.
 */
const RECOMMENDATION_SOURCE_PATCHES = ["weekly-jams", "weekly-exploration", "daily-jams"];

/** True when `path` is neither `root` itself nor anywhere beneath it. */
function isOutside(path: string, root: string): boolean {
  const inside = relative(root, path);
  // "" is `root` itself. Anything that has to climb out, or that `relative` could not express
  // as a relative path at all, is elsewhere.
  return inside !== "" && (inside.startsWith("..") || isAbsolute(inside));
}

function list(key: string, fallback: string[]): string[] {
  const value = process.env[key]?.trim();
  if (!value) return fallback;
  // `*` opts back in to every family `createdfor` returns, historical lists included.
  if (value === "*") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  const logLevel = optional("LOG_LEVEL", "info");
  if (!LOG_LEVELS.has(logLevel)) {
    throw new ConfigError(`LOG_LEVEL must be one of debug, info, warn, error (got "${logLevel}")`);
  }

  const access = optional("TIDAL_PLAYLIST_ACCESS", "PRIVATE").toUpperCase();
  // The TIDAL API models "private" playlists as UNLISTED; accept the friendlier word too.
  const playlistAccess = access === "PUBLIC" ? "PUBLIC" : "UNLISTED";

  const countryCode = optional("TIDAL_COUNTRY_CODE", "US").toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw new ConfigError(`TIDAL_COUNTRY_CODE must be an ISO 3166-1 alpha-2 code (got "${countryCode}")`);
  }

  const redirectUri = optional("TIDAL_REDIRECT_URI", "http://localhost:8080/callback");
  try {
    new URL(redirectUri);
  } catch {
    throw new ConfigError(`TIDAL_REDIRECT_URI must be an absolute URL (got "${redirectUri}")`);
  }

  const downloadQuality = optional("TIDAL_DOWNLOAD_QUALITY", "lossless").toLowerCase();
  if (!DOWNLOAD_QUALITIES.has(downloadQuality)) {
    throw new ConfigError(
      `TIDAL_DOWNLOAD_QUALITY must be one of ${[...DOWNLOAD_QUALITIES].join(", ")} (got "${downloadQuality}")`,
    );
  }

  const skipTier = optional("TIDAL_SKIP_TIER", "album-agnostic").toLowerCase();
  if (!SKIP_TIERS.has(skipTier)) {
    throw new ConfigError(`TIDAL_SKIP_TIER must be one of ${[...SKIP_TIERS].join(", ")} (got "${skipTier}")`);
  }

  const syncFavorites = boolean("SYNC_FAVORITES", false);
  const listenBrainzToken = optional("LISTENBRAINZ_TOKEN", "");
  if (syncFavorites && !listenBrainzToken) {
    throw new ConfigError(
      "SYNC_FAVORITES needs LISTENBRAINZ_TOKEN — writing loved recordings to your account " +
        "requires a user token from https://listenbrainz.org/settings/",
    );
  }

  const libraryDir = resolve(optional("LIBRARY_DIR", "./library"));
  // Resolved only when set, so "" stays "" and means delete rather than resolving to cwd.
  const replacedDir = process.env.TIDAL_REPLACED_DIR?.trim()
    ? resolve(process.env.TIDAL_REPLACED_DIR.trim())
    : process.env.TIDAL_REPLACED_DIR === ""
      ? ""
      : resolve(optional("DATA_DIR", "./data"), "replaced");

  // Retiring a file *into* the library is the one way an upgrade leaves you with two copies
  // of a track: the replacement under its own name, and the file it replaced still sitting
  // where a scanner will index it. Nothing downstream can detect that, so refuse it here.
  if (replacedDir && !isOutside(replacedDir, libraryDir)) {
    throw new ConfigError(
      `TIDAL_REPLACED_DIR (${replacedDir}) is inside LIBRARY_DIR (${libraryDir}). Upgraded ` +
        "files are moved there, so your library would end up holding both the new copy and " +
        "the one it replaced. Point it somewhere outside, or set it to an empty string to " +
        "delete replaced files instead.",
    );
  }

  return {
    listenBrainzUser: required("LISTENBRAINZ_USER"),
    listenBrainzApiUrl: optional("LISTENBRAINZ_API_URL", "https://api.listenbrainz.org"),
    listenBrainzToken,
    musicBrainzApiUrl: optional("MUSICBRAINZ_API_URL", "https://musicbrainz.org"),
    sourcePatchAllowlist: list("LISTENBRAINZ_SOURCE_PATCHES", RECOMMENDATION_SOURCE_PATCHES),
    tidal: {
      clientId: required("TIDAL_CLIENT_ID"),
      clientSecret: required("TIDAL_CLIENT_SECRET"),
      redirectUri,
      countryCode,
      skipCollectionFor: list("TIDAL_SKIP_COLLECTION_FOR", []),
      playlistNameTemplate: optional("TIDAL_PLAYLIST_NAME_TEMPLATE", "{title} (ListenBrainz)"),
      playlistAccess,
      deviceClientId: optional("TIDAL_DEVICE_CLIENT_ID", ""),
      deviceClientSecret: optional("TIDAL_DEVICE_CLIENT_SECRET", ""),
      downloadDelayMs: integer("TIDAL_DOWNLOAD_DELAY_MS", 3000, 0, 600_000),
    },
    libraryDir,
    downloadQuality: downloadQuality as Config["downloadQuality"],
    skipTier: skipTier as Config["skipTier"],
    upgrade: boolean("TIDAL_UPGRADE", false),
    replacedDir,
    replacedRetentionDays: integer("TIDAL_REPLACED_RETENTION_DAYS", 7, 0, 3650),
    syncFavorites,
    dataDir: resolve(optional("DATA_DIR", "./data")),
    schedule: optional("SYNC_SCHEDULE", "0 */6 * * *"),
    backupOnSchedule: boolean("BACKUP_ON_SCHEDULE", true),
    timezone: optional("TZ", "UTC"),
    dashboard: {
      enabled: boolean("DASHBOARD_ENABLED", true),
      host: optional("DASHBOARD_HOST", "0.0.0.0"),
      port: integer("DASHBOARD_PORT", 8081, 1, 65535),
    },
    contactEmail: optional("CONTACT_EMAIL", "listenbrainz-tidal-sync@localhost"),
    logLevel: logLevel as LogLevel,
    dryRun: boolean("DRY_RUN", false),
  };
}

export { ConfigError };
