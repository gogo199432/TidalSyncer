import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { SETTINGS, SettingsService, SettingsStore } from "./settings.ts";

/**
 * The point of the overlay is that a value set in the browser outranks the one the container
 * was started with, and that it is checked as hard as the environment is before it can.
 */

let root: string;
let saved: NodeJS.ProcessEnv;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "settings-"));

  // Bun loads the repo's own .env, so start from an environment this file controls entirely —
  // otherwise "is this refused with no token?" depends on whoever is running the tests.
  saved = { ...process.env };
  for (const group of SETTINGS) {
    for (const field of group.fields) delete process.env[field.key];
  }

  Object.assign(process.env, {
    LISTENBRAINZ_USER: "tester",
    TIDAL_CLIENT_ID: "client-id",
    TIDAL_CLIENT_SECRET: "client-secret",
    SYNC_SCHEDULE: "0 */6 * * *",
    TIDAL_DOWNLOAD_QUALITY: "lossless",
    LOG_LEVEL: "error",
    DATA_DIR: root,
  });
});

afterAll(async () => {
  process.env = saved;
  await rm(root, { recursive: true, force: true });
});

let store: SettingsStore;
let config: Config;
let settings: SettingsService;
let rescheduled: string[];

beforeEach(async () => {
  await rm(join(root, "settings.json"), { force: true });
  store = await SettingsStore.open(root);
  config = loadConfig(store.values());
  rescheduled = [];
  settings = new SettingsService(store, config, (next, previous) => {
    if (next.schedule !== previous.schedule) rescheduled.push(next.schedule);
  });
});

const field = (key: string) =>
  settings
    .snapshot()
    .groups.flatMap((group) => group.fields)
    .find((entry) => entry.key === key);

describe("precedence", () => {
  test("starts from the environment when nothing has been saved", () => {
    expect(config.schedule).toBe("0 */6 * * *");
    expect(field("SYNC_SCHEDULE")?.source).toBe("env");
  });

  test("a saved value outranks the environment, in the live config and on reload", async () => {
    await settings.update({ SYNC_SCHEDULE: "15 3 * * *" });

    expect(config.schedule).toBe("15 3 * * *");
    expect(field("SYNC_SCHEDULE")?.source).toBe("file");
    // The environment still says something else, and still would after a restart — which is
    // exactly the case the overlay exists for.
    expect(process.env.SYNC_SCHEDULE).toBe("0 */6 * * *");
    expect(loadConfig((await SettingsStore.open(root)).values()).schedule).toBe("15 3 * * *");
  });

  test("the daemon is told when the schedule moved, so it can re-arm the cron job", async () => {
    await settings.update({ TIDAL_DOWNLOAD_QUALITY: "high" });
    expect(rescheduled).toEqual([]);

    await settings.update({ SYNC_SCHEDULE: "0 4 * * *" });
    expect(rescheduled).toEqual(["0 4 * * *"]);
  });

  test("resetting hands the setting back to the environment", async () => {
    await settings.update({ SYNC_SCHEDULE: "15 3 * * *" });
    await settings.update({ SYNC_SCHEDULE: null });

    expect(config.schedule).toBe("0 */6 * * *");
    expect(field("SYNC_SCHEDULE")?.overridden).toBe(false);
  });

  test("a change reaches the nested settings the download run reads", async () => {
    await settings.update({ TIDAL_DOWNLOAD_DELAY_MS: "250", SLSKD_LOSSLESS_ONLY: "true" });

    // The same object every runner already holds, not a copy they would never see.
    expect(config.tidal.downloadDelayMs).toBe(250);
    expect(config.slskd.losslessOnly).toBe(true);
  });
});

describe("validation", () => {
  test("refuses a setting nothing reads, rather than storing a typo for ever", async () => {
    await expect(settings.update({ SYNC_SCHEDULEE: "0 4 * * *" })).rejects.toThrow(/Unknown setting/);
  });

  test("refuses a cron expression croner would throw on at the next tick", async () => {
    await expect(settings.update({ SYNC_SCHEDULE: "every thursday" })).rejects.toThrow(/SYNC_SCHEDULE/);
    expect(config.schedule).toBe("0 */6 * * *");
  });

  test("refuses a timezone that only fails when a date is worked out in it", async () => {
    await expect(settings.update({ TZ: "Mars/Olympus" })).rejects.toThrow(/SYNC_SCHEDULE/);
  });

  test("applies the loader's own rules, in the loader's own words", async () => {
    await expect(settings.update({ TIDAL_REPLACED_RETENTION_DAYS: "1.5" })).rejects.toThrow(/must be an integer/);
    await expect(settings.update({ TIDAL_COUNTRY_CODE: "HUN" })).rejects.toThrow(/alpha-2/);
    await expect(settings.update({ TIDAL_DOWNLOAD_QUALITY: "perfect" })).rejects.toThrow(/must be one of/);
  });

  // Settings constrain each other, so a field that is fine on its own can still be refused.
  test("refuses a combination that could not start the daemon", async () => {
    await expect(settings.update({ SYNC_FAVORITES: "true" })).rejects.toThrow(/LISTENBRAINZ_TOKEN/);
    await expect(settings.update({ SLSKD_URL: "http://slskd:5030" })).rejects.toThrow(/SLSKD_API_KEY/);

    // Both halves together are accepted, which is the pair that has to be settable at once.
    await settings.update({ SLSKD_URL: "http://slskd:5030", SLSKD_API_KEY: "key" });
    expect(config.slskd.url).toBe("http://slskd:5030");
  });

  test("writes nothing when the overlay does not hold up", async () => {
    await settings.update({ SYNC_SCHEDULE: "15 3 * * *" });
    await expect(settings.update({ SYNC_SCHEDULE: "nope" })).rejects.toThrow();

    const saved = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
    expect(saved.values.SYNC_SCHEDULE).toBe("15 3 * * *");
  });

  test("tidies what it stores, so the file reads like something written by hand", async () => {
    await settings.update({
      SYNC_FAVORITES: "yes",
      LISTENBRAINZ_TOKEN: "  token  ",
      LISTENBRAINZ_SOURCE_PATCHES: " weekly-jams , daily-jams ,, ",
      TIDAL_PLAYLIST_ACCESS: "public",
    });

    const saved = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
    expect(saved.values.SYNC_FAVORITES).toBe("true");
    expect(saved.values.LISTENBRAINZ_TOKEN).toBe("token");
    expect(saved.values.LISTENBRAINZ_SOURCE_PATCHES).toBe("weekly-jams,daily-jams");
    expect(saved.values.TIDAL_PLAYLIST_ACCESS).toBe("PUBLIC");
    expect(config.sourcePatchAllowlist).toEqual(["weekly-jams", "daily-jams"]);
  });
});

describe("what the page is told", () => {
  test("never sends a secret back, from either layer", async () => {
    process.env.SLSKD_API_KEY = "from-the-environment";
    await settings.update({ LISTENBRAINZ_TOKEN: "saved-here" });

    expect(JSON.stringify(settings.snapshot())).not.toContain("saved-here");
    expect(JSON.stringify(settings.snapshot())).not.toContain("from-the-environment");

    // What it does say is whether there is one at all, which is all the page needs to draw it.
    expect(field("LISTENBRAINZ_TOKEN")?.set).toBe(true);
    expect(field("SLSKD_API_KEY")?.set).toBe(true);
    delete process.env.SLSKD_API_KEY;
  });

  test("says what a reset would fall back to", async () => {
    await settings.update({ SYNC_SCHEDULE: "15 3 * * *" });

    const view = field("SYNC_SCHEDULE");
    expect(view?.value).toBe("15 3 * * *");
    expect(view?.envValue).toBe("0 */6 * * *");
  });

  // The overlay is stored in DATA_DIR, so a DATA_DIR the overlay could move would be an
  // overlay that loses itself.
  test("does not offer to move the directory it lives in", async () => {
    expect(field("DATA_DIR")).toBeUndefined();
    await expect(settings.update({ DATA_DIR: "/elsewhere" })).rejects.toThrow(/Unknown setting/);
  });
});

describe("what the process has already bound", () => {
  test("keeps serving on the port it is actually listening on", async () => {
    const port = config.dashboard.port;
    await settings.update({ DASHBOARD_PORT: "9000" });

    // Saved for the next start — the page marks it "needs a restart" — but the live config
    // must go on describing the server that exists.
    expect(config.dashboard.port).toBe(port);
    expect(field("DASHBOARD_PORT")?.value).toBe("9000");
    expect(loadConfig(store.values()).dashboard.port).toBe(9000);
  });
});
