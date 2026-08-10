import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";

const REQUIRED = {
  LISTENBRAINZ_USER: "listener",
  TIDAL_CLIENT_ID: "client-id",
  TIDAL_CLIENT_SECRET: "client-secret",
};

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("LISTENBRAINZ_") || key.startsWith("TIDAL_")) delete process.env[key];
  }
  delete process.env.SYNC_FAVORITES;
  Object.assign(process.env, REQUIRED);
});

afterEach(() => {
  process.env = saved;
});

/**
 * The settings page saves an overlay of the same strings the environment holds, and hands it
 * to the loader — so everything below applies to a value set in the browser too.
 */
describe("the saved overlay", () => {
  afterEach(() => {
    delete process.env.SYNC_SCHEDULE;
    delete process.env.TIDAL_REPLACED_DIR;
  });

  test("outranks the environment", () => {
    process.env.SYNC_SCHEDULE = "0 */6 * * *";
    expect(loadConfig({ SYNC_SCHEDULE: "15 3 * * *" }).schedule).toBe("15 3 * * *");
  });

  test("is validated exactly as the environment is", () => {
    expect(() => loadConfig({ TIDAL_COUNTRY_CODE: "HUN" })).toThrow(/alpha-2/);
    expect(() => loadConfig({ TIDAL_REPLACED_RETENTION_DAYS: "1.5" })).toThrow(/must be an integer/);
  });

  test("can say “delete replaced files” over an environment that names a directory", () => {
    process.env.TIDAL_REPLACED_DIR = "/srv/retired";
    // "" is a decision, not an absent value — the distinction has to survive the overlay.
    expect(loadConfig({ TIDAL_REPLACED_DIR: "" }).replacedDir).toBe("");
    expect(loadConfig({}).replacedDir).toBe("/srv/retired");
  });

  // Bun's process.env is a live object with special cases behind it, and copying it loses
  // some of them — TZ among them, which would leave the cron job an hour or several out.
  test("leaves the environment it does not override alone, TZ included", () => {
    process.env.TZ = "Europe/Budapest";
    expect(loadConfig({ SYNC_SCHEDULE: "15 3 * * *" }).timezone).toBe(process.env.TZ);
  });
});

describe("source patch selection", () => {
  test("defaults to the recommendation playlists only", () => {
    expect(loadConfig().sourcePatchAllowlist).toEqual([
      "weekly-jams",
      "weekly-exploration",
      "daily-jams",
    ]);
  });

  test("an explicit list overrides the default", () => {
    process.env.LISTENBRAINZ_SOURCE_PATCHES = "weekly-jams, daily-jams";
    expect(loadConfig().sourcePatchAllowlist).toEqual(["weekly-jams", "daily-jams"]);
  });

  test("`*` opts in to every family by clearing the filter", () => {
    process.env.LISTENBRAINZ_SOURCE_PATCHES = "*";
    expect(loadConfig().sourcePatchAllowlist).toEqual([]);
  });
});

/**
 * Upgrades move the file they replaced into TIDAL_REPLACED_DIR. Point that inside the
 * library and every upgrade leaves your music server showing two copies of the track — the
 * one thing this tool cannot detect or clean up for you, so it is refused up front.
 */
describe("TIDAL_REPLACED_DIR against LIBRARY_DIR", () => {
  afterEach(() => {
    delete process.env.LIBRARY_DIR;
    delete process.env.TIDAL_REPLACED_DIR;
    delete process.env.DATA_DIR;
  });

  // Warned about rather than refused: the music share is often the only mount with room for
  // gigabytes of retired files, and scanners can be told to skip a directory. Refusing would
  // stop a working daemon over something the operator may already have handled.
  test("allows a retire directory inside the library, since that is a reasonable choice", () => {
    process.env.LIBRARY_DIR = "/srv/music";
    process.env.TIDAL_REPLACED_DIR = "/srv/music/.replaced";
    expect(loadConfig().replacedDir).toBe("/srv/music/.replaced");
  });

  test("still resolves a path that climbs back into the library", () => {
    process.env.LIBRARY_DIR = "/srv/music";
    process.env.TIDAL_REPLACED_DIR = "/srv/music/../music/old";
    expect(loadConfig().replacedDir).toBe("/srv/music/old");
  });

  test("accepts a sibling, which is what the defaults give you", () => {
    process.env.LIBRARY_DIR = "/srv/music";
    process.env.DATA_DIR = "/srv/data";
    expect(loadConfig().replacedDir).toBe("/srv/data/replaced");
  });

  test("accepts a path that merely starts with the library's name", () => {
    process.env.LIBRARY_DIR = "/srv/music";
    process.env.TIDAL_REPLACED_DIR = "/srv/music-replaced";
    expect(loadConfig().replacedDir).toBe("/srv/music-replaced");
  });

  test("has nothing to object to when replaced files are deleted instead", () => {
    process.env.LIBRARY_DIR = "/srv/music";
    process.env.TIDAL_REPLACED_DIR = "";
    expect(loadConfig().replacedDir).toBe("");
  });
});

describe("TIDAL_REPLACED_RETENTION_DAYS", () => {
  afterEach(() => {
    delete process.env.TIDAL_REPLACED_RETENTION_DAYS;
  });

  test("keeps a replaced file for a week by default", () => {
    expect(loadConfig().replacedRetentionDays).toBe(7);
  });

  test("zero keeps them for ever, for pruning by hand", () => {
    process.env.TIDAL_REPLACED_RETENTION_DAYS = "0";
    expect(loadConfig().replacedRetentionDays).toBe(0);
  });

  test("rejects a value that is not a whole number of days", () => {
    process.env.TIDAL_REPLACED_RETENTION_DAYS = "1.5";
    expect(() => loadConfig()).toThrow(/must be an integer/);
    process.env.TIDAL_REPLACED_RETENTION_DAYS = "-1";
    expect(() => loadConfig()).toThrow(/must be an integer/);
  });
});

describe("the Soulseek fallback", () => {
  afterEach(() => {
    delete process.env.SLSKD_URL;
    delete process.env.SLSKD_API_KEY;
    delete process.env.SLSKD_DOWNLOADS_DIR;
    delete process.env.LIBRARY_DIR;
  });

  test("is off unless a URL is set, since it reaches a public network on your behalf", () => {
    expect(loadConfig().slskd.url).toBe("");
  });

  test("refuses a URL with no key rather than failing every search at runtime", () => {
    process.env.SLSKD_URL = "http://slskd:5030";
    expect(() => loadConfig()).toThrow(/SLSKD_API_KEY/);
  });

  test("says the key needs the readwrite role, because a read-only one silently cannot search", () => {
    process.env.SLSKD_URL = "http://slskd:5030";
    expect(() => loadConfig()).toThrow(/readwrite/);
  });

  test("rejects a host with no scheme, which is the easy mistake to make", () => {
    process.env.SLSKD_URL = "slskd.example";
    process.env.SLSKD_API_KEY = "key";
    expect(() => loadConfig()).toThrow(/absolute URL/);
  });

  test("downloads into the library by default, which is the same-share arrangement", () => {
    process.env.LIBRARY_DIR = "/srv/music";
    process.env.SLSKD_URL = "http://slskd:5030";
    process.env.SLSKD_API_KEY = "key";
    expect(loadConfig().slskd.downloadsDir).toBe("/srv/music");
  });

  test("takes a separate downloads directory when slskd writes somewhere else", () => {
    process.env.LIBRARY_DIR = "/srv/music";
    process.env.SLSKD_URL = "http://slskd:5030";
    process.env.SLSKD_API_KEY = "key";
    process.env.SLSKD_DOWNLOADS_DIR = "/srv/slskd";
    expect(loadConfig().slskd.downloadsDir).toBe("/srv/slskd");
  });
});

describe("BACKUP_ON_SCHEDULE", () => {
  afterEach(() => {
    delete process.env.BACKUP_ON_SCHEDULE;
  });

  test("is on by default — the daemon backs up on the same tick it syncs", () => {
    expect(loadConfig().backupOnSchedule).toBe(true);
  });

  test("can be switched off to keep backups something you start by hand", () => {
    process.env.BACKUP_ON_SCHEDULE = "false";
    expect(loadConfig().backupOnSchedule).toBe(false);
  });
});

describe("validation", () => {
  test("requires a ListenBrainz user", () => {
    delete process.env.LISTENBRAINZ_USER;
    expect(() => loadConfig()).toThrow(/LISTENBRAINZ_USER/);
  });

  test("rejects a malformed country code", () => {
    process.env.TIDAL_COUNTRY_CODE = "HUN";
    expect(() => loadConfig()).toThrow(/alpha-2/);
  });

  test("maps PRIVATE onto the API's UNLISTED access type", () => {
    process.env.TIDAL_PLAYLIST_ACCESS = "PRIVATE";
    expect(loadConfig().tidal.playlistAccess).toBe("UNLISTED");

    process.env.TIDAL_PLAYLIST_ACCESS = "PUBLIC";
    expect(loadConfig().tidal.playlistAccess).toBe("PUBLIC");
  });
});

describe("favourite syncing", () => {
  test("is off by default, so no ListenBrainz token is needed", () => {
    const config = loadConfig();
    expect(config.syncFavorites).toBe(false);
    expect(config.listenBrainzToken).toBe("");
  });

  test("refuses to start enabled but tokenless, rather than failing on the first write", () => {
    process.env.SYNC_FAVORITES = "true";
    expect(() => loadConfig()).toThrow(/LISTENBRAINZ_TOKEN/);
  });

  test("is enabled once a token is supplied", () => {
    process.env.SYNC_FAVORITES = "true";
    process.env.LISTENBRAINZ_TOKEN = "token";
    expect(loadConfig().syncFavorites).toBe(true);
  });
});

describe("collection filtering", () => {
  test("is off by default, keeping collection.read off the token", () => {
    expect(loadConfig().tidal.skipCollectionFor).toEqual([]);
  });

  test("accepts a list of families", () => {
    process.env.TIDAL_SKIP_COLLECTION_FOR = "weekly-exploration, daily-jams";
    expect(loadConfig().tidal.skipCollectionFor).toEqual(["weekly-exploration", "daily-jams"]);
  });
});
