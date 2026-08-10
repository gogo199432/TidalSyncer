import { isAbsolute, relative, resolve } from "node:path";
import { log, type LogLevel } from "./logger.ts";

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
   * Soulseek, via a self-hosted slskd, as the fallback for tracks TIDAL will not serve —
   * the ones the account is not entitled to, and the ones delisted out of the catalogue.
   *
   * Empty `url` switches the whole thing off, and that is the default: this reaches a
   * peer-to-peer network on your behalf, which is not something to start doing by accident.
   */
  slskd: {
    /** Base URL of slskd's web API, e.g. http://slskd:5030. Empty disables the fallback. */
    url: string;
    /** Needs slskd's `readwrite` role — searching and enqueueing both change state. */
    apiKey: string;
    /**
     * Where *TidalSyncer* sees slskd's downloads directory. Defaults to `libraryDir`, which
     * is right when both point at the same share: a finished download is then already in the
     * library and only needs renaming into place.
     */
    downloadsDir: string;
    /** How long slskd holds a search open. Soulseek searches expire rather than finish. */
    searchTimeoutMs: number;
    /** Ceiling on one API call, so a service that stops answering cannot hang a run. */
    requestTimeoutMs: number;
    /**
     * How long to wait on a queued transfer before leaving it for the next run. Soulseek
     * queues are measured in hours and a download run must not be.
     */
    transferTimeoutMs: number;
    /** Refuse lossy candidates outright rather than taking one when nothing better is up. */
    losslessOnly: boolean;
  };
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

/**
 * The environment, with the settings page's saved overlay on top. The overlay wins, so a
 * value changed in the browser survives the compose file continuing to say something else —
 * see src/settings.ts. The same parsing and validation applies to either layer, since they
 * hold the same strings.
 *
 * `process.env` is read a key at a time rather than copied: under Bun it is a live object
 * with special cases behind it — `{ ...process.env }` loses a `TZ` that was assigned by the
 * process itself — and a config layer that quietly disagrees with the environment about the
 * timezone is a schedule that fires at the wrong hour.
 */
class Env {
  constructor(private readonly overrides: Record<string, string>) {}

  /** The untrimmed entry, for the one setting where "" and absent mean different things. */
  raw(key: string): string | undefined {
    return Object.hasOwn(this.overrides, key) ? this.overrides[key] : process.env[key];
  }

  required(key: string): string {
    const value = this.raw(key)?.trim();
    if (!value) throw new ConfigError(`Missing required environment variable ${key}`);
    return value;
  }

  optional(key: string, fallback: string): string {
    const value = this.raw(key)?.trim();
    return value ? value : fallback;
  }

  boolean(key: string, fallback: boolean): boolean {
    const value = this.raw(key)?.trim().toLowerCase();
    if (value === undefined || value === "") return fallback;
    return value === "1" || value === "true" || value === "yes";
  }

  integer(key: string, fallback: number, min: number, max: number): number {
    const value = this.raw(key)?.trim();
    if (!value) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new ConfigError(`${key} must be an integer between ${min} and ${max} (got "${value}")`);
    }
    return parsed;
  }

  list(key: string, fallback: string[]): string[] {
    const value = this.raw(key)?.trim();
    if (!value) return fallback;
    // `*` opts back in to every family `createdfor` returns, historical lists included.
    if (value === "*") return [];
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
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

/**
 * Where the settings overlay, the sync state and the caches live.
 *
 * Read from the environment alone, deliberately: it is the directory the overlay itself is
 * stored in, so letting the overlay move it would leave the settings behind in the old one.
 */
export function envDataDir(): string {
  return resolve(process.env.DATA_DIR?.trim() || "./data");
}

/**
 * `overrides` is the settings page's saved overlay. It is applied on top of the environment
 * rather than parsed separately, so everything below — the defaults, the validation, the
 * relationships between settings — holds however a value arrived.
 */
export function loadConfig(overrides: Record<string, string> = {}): Config {
  const env = new Env(overrides);

  const logLevel = env.optional("LOG_LEVEL", "info");
  if (!LOG_LEVELS.has(logLevel)) {
    throw new ConfigError(`LOG_LEVEL must be one of debug, info, warn, error (got "${logLevel}")`);
  }

  const access = env.optional("TIDAL_PLAYLIST_ACCESS", "PRIVATE").toUpperCase();
  // The TIDAL API models "private" playlists as UNLISTED; accept the friendlier word too.
  const playlistAccess = access === "PUBLIC" ? "PUBLIC" : "UNLISTED";

  const countryCode = env.optional("TIDAL_COUNTRY_CODE", "US").toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw new ConfigError(`TIDAL_COUNTRY_CODE must be an ISO 3166-1 alpha-2 code (got "${countryCode}")`);
  }

  const redirectUri = env.optional("TIDAL_REDIRECT_URI", "http://localhost:8080/callback");
  try {
    new URL(redirectUri);
  } catch {
    throw new ConfigError(`TIDAL_REDIRECT_URI must be an absolute URL (got "${redirectUri}")`);
  }

  const downloadQuality = env.optional("TIDAL_DOWNLOAD_QUALITY", "lossless").toLowerCase();
  if (!DOWNLOAD_QUALITIES.has(downloadQuality)) {
    throw new ConfigError(
      `TIDAL_DOWNLOAD_QUALITY must be one of ${[...DOWNLOAD_QUALITIES].join(", ")} (got "${downloadQuality}")`,
    );
  }

  const skipTier = env.optional("TIDAL_SKIP_TIER", "album-agnostic").toLowerCase();
  if (!SKIP_TIERS.has(skipTier)) {
    throw new ConfigError(`TIDAL_SKIP_TIER must be one of ${[...SKIP_TIERS].join(", ")} (got "${skipTier}")`);
  }

  const syncFavorites = env.boolean("SYNC_FAVORITES", false);
  const listenBrainzToken = env.optional("LISTENBRAINZ_TOKEN", "");
  if (syncFavorites && !listenBrainzToken) {
    throw new ConfigError(
      "SYNC_FAVORITES needs LISTENBRAINZ_TOKEN — writing loved recordings to your account " +
        "requires a user token from https://listenbrainz.org/settings/",
    );
  }

  const libraryDir = resolve(env.optional("LIBRARY_DIR", "./library"));
  // Resolved only when set, so "" stays "" and means delete rather than resolving to cwd.
  const retireTo = env.raw("TIDAL_REPLACED_DIR");
  const replacedDir = retireTo?.trim()
    ? resolve(retireTo.trim())
    : retireTo === ""
      ? ""
      : resolve(envDataDir(), "replaced");

  const slskdUrl = env.optional("SLSKD_URL", "");
  if (slskdUrl) {
    try {
      new URL(slskdUrl);
    } catch {
      throw new ConfigError(`SLSKD_URL must be an absolute URL (got "${slskdUrl}")`);
    }
    if (!env.raw("SLSKD_API_KEY")?.trim()) {
      throw new ConfigError(
        "SLSKD_URL is set but SLSKD_API_KEY is empty. slskd's API needs a key with the " +
          "`readwrite` role — searching and enqueueing both change state, and a read-only " +
          "key is rejected.",
      );
    }
  }

  // Retiring a file *into* the library is the one way an upgrade leaves you with two copies
  // of a track: the replacement under its own name, and the file it replaced still sitting
  // where a scanner will index it.
  //
  // A warning rather than a refusal, because it is a perfectly reasonable thing to do on
  // purpose — the music share is often the only mount with room for several gigabytes of
  // retired files — and every scanner has a way to be told to ignore a directory
  // (Navidrome's is a `.ndignore` file inside it). Refusing would stop a working daemon over
  // something the operator may well have already handled.
  if (replacedDir && !isOutside(replacedDir, libraryDir)) {
    log.warn(
      "TIDAL_REPLACED_DIR is inside LIBRARY_DIR, so replaced files stay where your music " +
        "server can see them — it will show both the new copy and the one it replaced. Make " +
        "sure that directory is excluded from scanning (Navidrome: a .ndignore file in it), " +
        "or point TIDAL_REPLACED_DIR somewhere outside the library.",
      { replacedDir, libraryDir },
    );
  }

  return {
    listenBrainzUser: env.required("LISTENBRAINZ_USER"),
    listenBrainzApiUrl: env.optional("LISTENBRAINZ_API_URL", "https://api.listenbrainz.org"),
    listenBrainzToken,
    musicBrainzApiUrl: env.optional("MUSICBRAINZ_API_URL", "https://musicbrainz.org"),
    sourcePatchAllowlist: env.list("LISTENBRAINZ_SOURCE_PATCHES", RECOMMENDATION_SOURCE_PATCHES),
    tidal: {
      clientId: env.required("TIDAL_CLIENT_ID"),
      clientSecret: env.required("TIDAL_CLIENT_SECRET"),
      redirectUri,
      countryCode,
      skipCollectionFor: env.list("TIDAL_SKIP_COLLECTION_FOR", []),
      playlistNameTemplate: env.optional("TIDAL_PLAYLIST_NAME_TEMPLATE", "{title} (ListenBrainz)"),
      playlistAccess,
      deviceClientId: env.optional("TIDAL_DEVICE_CLIENT_ID", ""),
      deviceClientSecret: env.optional("TIDAL_DEVICE_CLIENT_SECRET", ""),
      downloadDelayMs: env.integer("TIDAL_DOWNLOAD_DELAY_MS", 3000, 0, 600_000),
    },
    libraryDir,
    downloadQuality: downloadQuality as Config["downloadQuality"],
    skipTier: skipTier as Config["skipTier"],
    upgrade: env.boolean("TIDAL_UPGRADE", false),
    replacedDir,
    replacedRetentionDays: env.integer("TIDAL_REPLACED_RETENTION_DAYS", 7, 0, 3650),
    slskd: {
      url: slskdUrl,
      apiKey: env.optional("SLSKD_API_KEY", ""),
      // Same share by default, which is the arrangement that lets a finished download be
      // renamed into place rather than copied across a filesystem boundary.
      downloadsDir: resolve(env.optional("SLSKD_DOWNLOADS_DIR", libraryDir)),
      searchTimeoutMs: env.integer("SLSKD_SEARCH_TIMEOUT_MS", 20_000, 5_000, 120_000),
      requestTimeoutMs: env.integer("SLSKD_REQUEST_TIMEOUT_MS", 30_000, 1_000, 300_000),
      transferTimeoutMs: env.integer("SLSKD_TRANSFER_TIMEOUT_MS", 600_000, 0, 86_400_000),
      losslessOnly: env.boolean("SLSKD_LOSSLESS_ONLY", false),
    },
    syncFavorites,
    dataDir: envDataDir(),
    schedule: env.optional("SYNC_SCHEDULE", "0 */6 * * *"),
    backupOnSchedule: env.boolean("BACKUP_ON_SCHEDULE", true),
    timezone: env.optional("TZ", "UTC"),
    dashboard: {
      enabled: env.boolean("DASHBOARD_ENABLED", true),
      host: env.optional("DASHBOARD_HOST", "0.0.0.0"),
      port: env.integer("DASHBOARD_PORT", 8081, 1, 65535),
    },
    contactEmail: env.optional("CONTACT_EMAIL", "listenbrainz-tidal-sync@localhost"),
    logLevel: logLevel as LogLevel,
    dryRun: env.boolean("DRY_RUN", false),
  };
}

export { ConfigError };
