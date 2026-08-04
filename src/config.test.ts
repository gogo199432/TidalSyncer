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
