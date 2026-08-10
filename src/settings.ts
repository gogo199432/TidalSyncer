import { Cron } from "croner";
import { join } from "node:path";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { readJson, writeAtomic } from "./json-file.ts";
import { log, setLogLevel } from "./logger.ts";

/**
 * Settings as something you can change from the browser, rather than only by editing
 * `docker-compose.yml` and restarting.
 *
 * The environment stays the base layer — an install that never opens the settings page
 * behaves exactly as it did. What the page saves goes into `DATA_DIR/settings.json` as an
 * overlay of raw strings keyed by environment-variable name, and that overlay wins. Storing
 * the strings rather than a parsed shape is what keeps the two layers honest: whichever one a
 * value comes from, `loadConfig` does the same parsing and the same validation on it, so
 * there is no second definition of what `SYNC_SCHEDULE` means that can drift from the first.
 *
 * A saved change takes effect in the live `Config` object the daemon already holds — see
 * `SettingsService.update` — so the next scheduled tick uses it. The handful of settings that
 * are read once while starting up are marked `restart` and say so on the page.
 */

export type SettingKind = "text" | "secret" | "number" | "boolean" | "select" | "list";

export type SettingField = {
  /** The environment variable this setting *is*. Also its key in the overlay. */
  key: string;
  label: string;
  kind: SettingKind;
  /** For `select`, the accepted values in the order the page should offer them. */
  options?: string[];
  /** What the loader falls back to when neither layer sets it, written as the page shows it. */
  fallback: string;
  help: string;
  /**
   * Read once while starting up — an OAuth scope, a bound port, an opened session. Saving one
   * of these is still worth doing (it survives the restart), but nothing changes until then.
   */
  restart?: boolean;
};

export type SettingGroup = { name: string; note: string; fields: SettingField[] };

const QUALITIES = ["hires", "lossless", "high", "low"];
const SKIP_TIERS = ["exact", "album-agnostic", "loose"];

/**
 * Every setting `loadConfig` reads, except `DATA_DIR` — that one says where this overlay
 * lives, so an overlay that moved it would leave itself behind.
 */
export const SETTINGS: SettingGroup[] = [
  {
    name: "ListenBrainz",
    note: "Where the playlists come from, and where loves go back to",
    fields: [
      {
        key: "LISTENBRAINZ_USER",
        label: "Username",
        kind: "text",
        fallback: "",
        help: "Whose “Created for you” playlists get mirrored. Required.",
      },
      {
        key: "LISTENBRAINZ_TOKEN",
        label: "User token",
        kind: "secret",
        fallback: "",
        help: "From listenbrainz.org/settings. Only needed to write loves back — reading playlists needs none.",
      },
      {
        key: "LISTENBRAINZ_SOURCE_PATCHES",
        label: "Playlist families",
        kind: "list",
        fallback: "weekly-jams, weekly-exploration, daily-jams",
        help: "Comma-separated. `*` mirrors every family ListenBrainz offers, including the one-off year-in-review lists.",
      },
      {
        key: "SYNC_FAVORITES",
        label: "Mirror favourites back",
        kind: "boolean",
        fallback: "false",
        restart: true,
        help: "TIDAL collection → ListenBrainz loves. Needs a token, and adds the collection.read scope — so run `login` again after switching it on.",
      },
      {
        key: "LISTENBRAINZ_API_URL",
        label: "API URL",
        kind: "text",
        fallback: "https://api.listenbrainz.org",
        help: "Only worth changing to point at your own instance.",
      },
      {
        key: "MUSICBRAINZ_API_URL",
        label: "MusicBrainz API URL",
        kind: "text",
        fallback: "https://musicbrainz.org",
        help: "Used to turn ISRCs into recording MBIDs when mirroring favourites back.",
      },
      {
        key: "CONTACT_EMAIL",
        label: "Contact address",
        kind: "text",
        fallback: "listenbrainz-tidal-sync@localhost",
        help: "Embedded in the User-Agent, as the MusicBrainz guidelines ask for.",
      },
    ],
  },
  {
    name: "TIDAL",
    note: "The account, and how the mirrored playlists look",
    fields: [
      {
        key: "TIDAL_CLIENT_ID",
        label: "Client id",
        kind: "text",
        fallback: "",
        restart: true,
        help: "From developer.tidal.com. Required.",
      },
      {
        key: "TIDAL_CLIENT_SECRET",
        label: "Client secret",
        kind: "secret",
        fallback: "",
        restart: true,
        help: "Its secret. Required.",
      },
      {
        key: "TIDAL_REDIRECT_URI",
        label: "Redirect URI",
        kind: "text",
        fallback: "http://localhost:8080/callback",
        help: "Must match a redirect URI registered on the app, verbatim.",
      },
      {
        key: "TIDAL_COUNTRY_CODE",
        label: "Country",
        kind: "text",
        fallback: "US",
        help: "ISO 3166-1 alpha-2. Decides what the catalogue will serve you.",
      },
      {
        key: "TIDAL_PLAYLIST_NAME_TEMPLATE",
        label: "Playlist name",
        kind: "text",
        fallback: "{title} (ListenBrainz)",
        help: "{title} is the humanised family name, e.g. “Weekly Jams”.",
      },
      {
        key: "TIDAL_PLAYLIST_ACCESS",
        label: "Playlist visibility",
        kind: "select",
        options: ["PRIVATE", "PUBLIC"],
        fallback: "PRIVATE",
        help: "PRIVATE shows as “unlisted” in the TIDAL API.",
      },
      {
        key: "TIDAL_SKIP_COLLECTION_FOR",
        label: "Skip owned tracks for",
        kind: "list",
        fallback: "(off)",
        restart: true,
        help: "Families to filter against your collection; `*` for all. Adds the collection.read scope, so run `login` again after changing it.",
      },
    ],
  },
  {
    name: "Downloads",
    note: "What `download` fetches, and where it puts it",
    fields: [
      {
        key: "TIDAL_DEVICE_CLIENT_ID",
        label: "Playback client id",
        kind: "text",
        fallback: "(off)",
        restart: true,
        help: "Not the developer-portal id above — that one only ever gets 30-second previews. Empty switches downloading off.",
      },
      {
        key: "TIDAL_DEVICE_CLIENT_SECRET",
        label: "Playback client secret",
        kind: "secret",
        fallback: "",
        restart: true,
        help: "Only some player clients need one alongside the id.",
      },
      {
        key: "LIBRARY_DIR",
        label: "Library directory",
        kind: "text",
        fallback: "./library",
        help: "Where audio is written, as Artist/Album/Title.flac.",
      },
      {
        key: "TIDAL_DOWNLOAD_QUALITY",
        label: "Quality",
        kind: "select",
        options: QUALITIES,
        fallback: "lossless",
        help: "The tier asked for first; a run walks down from here when the account is not entitled.",
      },
      {
        key: "TIDAL_SKIP_TIER",
        label: "Skip what matches",
        kind: "select",
        options: SKIP_TIERS,
        fallback: "album-agnostic",
        help: "How closely a file already on disk must match before the track is skipped.",
      },
      {
        key: "TIDAL_UPGRADE",
        label: "Upgrade by default",
        kind: "boolean",
        fallback: "false",
        help: "Replace files TIDAL has a better copy of. The only mode that touches files you already have.",
      },
      {
        key: "TIDAL_REPLACED_DIR",
        label: "Retire replaced files to",
        kind: "text",
        fallback: "DATA_DIR/replaced",
        help: "Empty deletes them instead. Keep it outside the library, or your music server will index both copies.",
      },
      {
        key: "TIDAL_REPLACED_RETENTION_DAYS",
        label: "Keep replaced files for",
        kind: "number",
        fallback: "7",
        help: "Days before a download prunes them. 0 keeps them for ever.",
      },
      {
        key: "TIDAL_DOWNLOAD_DELAY_MS",
        label: "Pause between tracks",
        kind: "number",
        fallback: "3000",
        help: "Milliseconds. TIDAL answers a burst with 429s and eventually a captcha that signs the session out — do not lower this casually.",
      },
    ],
  },
  {
    name: "Soulseek",
    note: "The fallback for tracks TIDAL will not serve. Off unless a URL is set",
    fields: [
      {
        key: "SLSKD_URL",
        label: "slskd URL",
        kind: "text",
        fallback: "(off)",
        help: "Base URL of slskd's web API, e.g. http://slskd:5030. Empty leaves the whole fallback off.",
      },
      {
        key: "SLSKD_API_KEY",
        label: "API key",
        kind: "secret",
        fallback: "",
        help: "Needs slskd's `readwrite` role — searching and enqueueing both change state.",
      },
      {
        key: "SLSKD_DOWNLOADS_DIR",
        label: "Downloads directory",
        kind: "text",
        fallback: "the library directory",
        help: "Where this daemon sees slskd's finished downloads.",
      },
      {
        key: "SLSKD_LOSSLESS_ONLY",
        label: "Lossless only",
        kind: "boolean",
        fallback: "false",
        help: "Refuse lossy candidates outright rather than taking one when nothing better is up.",
      },
      {
        key: "SLSKD_SEARCH_TIMEOUT_MS",
        label: "Search timeout",
        kind: "number",
        fallback: "20000",
        help: "Milliseconds slskd holds a search open. Soulseek searches expire rather than finish.",
      },
      {
        key: "SLSKD_REQUEST_TIMEOUT_MS",
        label: "Request timeout",
        kind: "number",
        fallback: "30000",
        help: "Ceiling on one API call, so a service that stops answering cannot hang a run.",
      },
      {
        key: "SLSKD_TRANSFER_TIMEOUT_MS",
        label: "Transfer timeout",
        kind: "number",
        fallback: "600000",
        help: "How long to wait on a queued transfer before leaving it for the next run.",
      },
    ],
  },
  {
    name: "Schedule",
    note: "When the daemon syncs, and whether it backs up on the same tick",
    fields: [
      {
        key: "SYNC_SCHEDULE",
        label: "Cron expression",
        kind: "text",
        fallback: "0 */6 * * *",
        help: "Saving this reschedules the running daemon; no restart needed.",
      },
      {
        key: "TZ",
        label: "Timezone",
        kind: "text",
        fallback: "UTC",
        help: "The zone the cron expression is read in. Log timestamps stay UTC.",
      },
      {
        key: "BACKUP_ON_SCHEDULE",
        label: "Back up on the same tick",
        kind: "boolean",
        fallback: "true",
        help: "Snapshot the catalogue and fill the library, right after the playlist sync. Skipped with a line saying why when downloading is not set up.",
      },
      {
        key: "DRY_RUN",
        label: "Dry run",
        kind: "boolean",
        fallback: "false",
        help: "Resolve and report everything, but never write to TIDAL.",
      },
    ],
  },
  {
    name: "Dashboard & logging",
    note: "This page, and how much the daemon says",
    fields: [
      {
        key: "DASHBOARD_ENABLED",
        label: "Serve the dashboard",
        kind: "boolean",
        fallback: "true",
        restart: true,
        help: "Switching this off means no status page and no settings page — the compose file is the only way back.",
      },
      {
        key: "DASHBOARD_HOST",
        label: "Bind address",
        kind: "text",
        fallback: "0.0.0.0",
        restart: true,
        help: "127.0.0.1 keeps the page on the host it runs on. There is no authentication either way.",
      },
      {
        key: "DASHBOARD_PORT",
        label: "Port",
        kind: "number",
        fallback: "8081",
        restart: true,
        help: "Inside the container. Changing it also means changing the compose file's port mapping.",
      },
      {
        key: "LOG_LEVEL",
        label: "Log level",
        kind: "select",
        options: ["debug", "info", "warn", "error"],
        fallback: "info",
        help: "Applies immediately — turn debug on, watch the log page, turn it back off.",
      },
    ],
  },
];

const FIELDS = new Map(SETTINGS.flatMap((group) => group.fields.map((field) => [field.key, field])));

/** A saved value: a string to set it, `null` to drop back to the environment. */
export type SettingsPatch = Record<string, string | null>;

export class SettingsError extends Error {}

type SettingsFile = {
  version: 1;
  /** Raw strings keyed by environment-variable name. Absent means "not overridden". */
  values: Record<string, string>;
  updatedAt?: string;
};

const EMPTY: SettingsFile = { version: 1, values: {} };

export class SettingsStore {
  private file: SettingsFile = EMPTY;

  private constructor(readonly path: string) {}

  static async open(dataDir: string): Promise<SettingsStore> {
    const store = new SettingsStore(join(dataDir, "settings.json"));
    store.file = await readJson(store.path, structuredClone(EMPTY));
    store.file.values ??= {};
    return store;
  }

  /** A copy, so nothing can edit the overlay without going through `write`. */
  values(): Record<string, string> {
    return { ...this.file.values };
  }

  updatedAt(): string | null {
    return this.file.updatedAt ?? null;
  }

  async write(values: Record<string, string>): Promise<void> {
    this.file = { version: 1, values, updatedAt: new Date().toISOString() };
    await writeAtomic(this.path, JSON.stringify(this.file, null, 2));
  }
}

export type SettingView = SettingField & {
  /** The effective value, as text. Always "" for a secret — those are write-only here. */
  value: string;
  /** What the environment says, for showing what dropping the override falls back to. */
  envValue: string;
  /** Whether the overlay sets it, i.e. whether there is anything to reset. */
  overridden: boolean;
  /** Whether it has a value at all. The only thing a secret reports about its own. */
  set: boolean;
  source: "file" | "env" | "default";
};

export type SettingsSnapshot = {
  path: string;
  updatedAt: string | null;
  groups: { name: string; note: string; fields: SettingView[] }[];
};

/**
 * The overlay plus the live `Config` it feeds, as one thing the dashboard can read and write.
 *
 * `onChange` is how the daemon learns that something it acted on at startup — the cron
 * expression, most of all — has moved.
 */
export class SettingsService {
  constructor(
    private readonly store: SettingsStore,
    /**
     * Mutated in place rather than replaced, because every runner, the dashboard and the cron
     * tick already hold this object. A run in flight can therefore pick a change up mid-run;
     * for the settings that would matter that is documented on the page as "next run".
     */
    private readonly live: Config,
    private readonly onChange?: (next: Config, previous: Config) => void,
  ) {}

  snapshot(): SettingsSnapshot {
    const overlay = this.store.values();

    return {
      path: this.store.path,
      updatedAt: this.store.updatedAt(),
      groups: SETTINGS.map((group) => ({
        name: group.name,
        note: group.note,
        fields: group.fields.map((field) => view(field, overlay)),
      })),
    };
  }

  /**
   * Validates the whole overlay as it would be after `patch`, then saves and applies it.
   *
   * Validated as a whole rather than field by field because settings constrain each other —
   * a Soulseek URL needs a key, favourite syncing needs a token — and because building the
   * candidate `Config` is the only check that cannot fall out of step with what the daemon
   * will actually do with these strings.
   */
  async update(patch: SettingsPatch): Promise<Config> {
    const values = this.store.values();

    for (const [key, value] of Object.entries(patch)) {
      const field = FIELDS.get(key);
      if (!field) throw new SettingsError(`Unknown setting "${key}"`);

      if (value === null) {
        delete values[key];
        continue;
      }
      values[key] = normalize(field, value);
    }

    let next: Config;
    try {
      next = loadConfig(values);
    } catch (error) {
      // A ConfigError already says which variable and why, in the words the CLI uses.
      if (error instanceof ConfigError) throw new SettingsError(error.message);
      throw error;
    }

    // croner is the only judge of a cron expression that matters, and an expression it
    // refuses would otherwise throw on the next reschedule — inside the daemon, with the old
    // job already stopped. `nextRun` rather than the constructor alone: a timezone croner
    // cannot resolve only fails when it comes to work out a date in it.
    try {
      const candidate = new Cron(next.schedule, { timezone: next.timezone });
      candidate.nextRun();
      candidate.stop();
    } catch (error) {
      throw new SettingsError(
        `SYNC_SCHEDULE "${next.schedule}" in ${next.timezone} is not a schedule croner accepts: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }

    // Persist first: a live config that disagrees with the file would come back on restart.
    await this.store.write(values);

    const previous = structuredClone(this.live);
    apply(this.live, next);
    setLogLevel(this.live.logLevel);
    log.info("Settings saved", { path: this.store.path, changed: Object.keys(patch).join(",") });
    this.onChange?.(this.live, previous);

    return this.live;
  }
}

function view(field: SettingField, overlay: Record<string, string>): SettingView {
  const secret = field.kind === "secret";
  const fromEnv = process.env[field.key];
  const overridden = Object.hasOwn(overlay, field.key);
  const effective = (overridden ? overlay[field.key] : fromEnv) ?? "";

  return {
    ...field,
    // Never sent, from either layer: this page has no authentication, and a token that can be
    // read back is a token anyone who can reach the port has.
    value: secret ? "" : effective,
    envValue: secret ? "" : (fromEnv ?? ""),
    overridden,
    set: Boolean(effective),
    source: overridden ? "file" : fromEnv ? "env" : "default",
  };
}

/** Tidies what the form posts, so the stored overlay reads like something written by hand. */
function normalize(field: SettingField, value: string): string {
  const trimmed = String(value).trim();

  switch (field.kind) {
    case "boolean":
      return ["1", "true", "yes"].includes(trimmed.toLowerCase()) ? "true" : "false";
    case "list":
      return trimmed
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .join(",");
    case "select": {
      const match = field.options?.find((option) => option.toLowerCase() === trimmed.toLowerCase());
      if (!match) {
        throw new SettingsError(`${field.key} must be one of ${field.options?.join(", ")} (got "${trimmed}")`);
      }
      return match;
    }
    default:
      return trimmed;
  }
}

/**
 * Copies `next` over the live config, keeping the object identities every holder captured.
 *
 * What the process bound at startup is kept: the dashboard is already listening on its port
 * and the stores are already open on their directory, so overwriting those would leave the
 * config describing an install that does not exist. Those fields are marked `restart` on the
 * page, and the saved overlay is what the next start reads.
 */
function apply(live: Config, next: Config): void {
  const bound = {
    dataDir: live.dataDir,
    dashboard: { ...live.dashboard },
  };

  assign(live, next);
  live.dataDir = bound.dataDir;
  live.dashboard.enabled = bound.dashboard.enabled;
  live.dashboard.host = bound.dashboard.host;
  live.dashboard.port = bound.dashboard.port;
}

function assign<T extends Record<string, unknown>>(target: T, source: T): void {
  for (const key of Object.keys(source) as (keyof T & string)[]) {
    const value = source[key];
    const current = target[key];

    if (isPlainObject(value) && isPlainObject(current)) {
      assign(current, value);
    } else {
      target[key] = value;
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
