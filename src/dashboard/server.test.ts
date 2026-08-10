import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackupRunner } from "../backup.ts";
import { loadConfig, type Config } from "../config.ts";
import { setLogLevel } from "../logger.ts";
import { SyncRunner } from "../runner.ts";
import { SETTINGS, SettingsService, SettingsStore } from "../settings.ts";
import { SyncStore } from "../store.ts";
import { startDashboard } from "./server.ts";

/**
 * Drives the backup endpoints the way the page does, against a real server over a temporary
 * data directory. A dry-run download needs no TIDAL session, so the whole
 * export → plan → report path is exercisable without credentials.
 */

let root: string;
let config: Config;
let server: Bun.Server<undefined>;
let base: string;
let settings: SettingsService;

const TRACKS = {
  "1": { tidalId: "1", title: "Karma Police", artists: ["Radiohead"], album: "OK Computer", path: "Radiohead/OK Computer/Karma Police.flac" },
  "2": { tidalId: "2", title: "Avril 14th", artists: ["Aphex Twin"], album: "Drukqs", path: "Aphex Twin/Drukqs/Avril 14th.flac" },
  "3": { tidalId: "3", title: "Glory Box", artists: ["Portishead"], album: "Dummy", path: "Portishead/Dummy/Glory Box.flac", mediaTags: ["LOSSLESS"] },
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dashboard-backup-"));

  // One of the three is already on disk, as a lossy file from some other tool. Real audio
  // rather than an empty file, so the upgrade path has something to probe.
  const existing = join(root, "library", "Portishead", "Dummy");
  await mkdir(existing, { recursive: true });
  const encoded = spawnSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:a", "libmp3lame", join(existing, "Glory Box.mp3"),
  ]);
  // Without ffmpeg it stays a zero-byte placeholder: still matched by the index, but the
  // upgrade tests below skip themselves.
  if (encoded.status !== 0) await writeFile(join(existing, "Glory Box.mp3"), "");

  await mkdir(join(root, "data", "export"), { recursive: true });
  await writeFile(
    join(root, "data", "export", "export.json"),
    JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      countryCode: "NL",
      playlists: [{ tidalId: "p1", name: "Weekly Jams (ListenBrainz)", trackIds: ["1", "2"] }],
      favoriteIds: ["1", "2", "3"],
      tracks: TRACKS,
      stats: { playlists: 1, favorites: 3, uniqueTracks: 3, unresolved: 0, withIsrc: 2 },
    }),
  );

  // Bun loads the repo's own .env, which would otherwise decide half of these tests — a
  // developer with TIDAL_DEVICE_CLIENT_ID set would see the backup panel configured.
  for (const group of SETTINGS) {
    for (const field of group.fields) delete process.env[field.key];
  }

  Object.assign(process.env, {
    LISTENBRAINZ_USER: "tester",
    TIDAL_CLIENT_ID: "test-client",
    TIDAL_CLIENT_SECRET: "test-secret",
    DATA_DIR: join(root, "data"),
    LIBRARY_DIR: join(root, "library"),
    // Left unset on purpose: the panel must say downloading is switched off rather than
    // offering a button that cannot work.
    TIDAL_DEVICE_CLIENT_ID: "",
    TIDAL_DOWNLOAD_DELAY_MS: "0",
    LOG_LEVEL: "info",
  });

  config = loadConfig();
  // Pinned rather than left to whatever ran before: the level is process-wide and a settings
  // save applies it, so a suite that asserts on the log buffer has to set its own.
  setLogLevel(config.logLevel);
  // Port 0 lets the OS pick a free one, which config validation will not accept but a test
  // running alongside a real daemon needs.
  config.dashboard.port = 0;
  config.dashboard.host = "127.0.0.1";

  const store = await SyncStore.open(config.dataDir);
  const backup = await BackupRunner.create(config);
  settings = new SettingsService(await SettingsStore.open(config.dataDir), config);
  server = startDashboard({
    config,
    store,
    runner: new SyncRunner(config, store),
    backup,
    settings,
    nextRun: () => null,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
  await rm(root, { recursive: true, force: true });
});

const get = (path: string) => fetch(`${base}${path}`);
const post = (path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Loosely typed on purpose: these tests assert on the payload's shape, not on its types. */
// biome-ignore lint/suspicious/noExplicitAny: test-only view of the JSON payload
type Snapshot = Record<string, any>;

async function backupStatus(): Promise<Snapshot> {
  return ((await (await get("/api/status")).json()) as Snapshot).backup;
}

async function body(response: Response): Promise<Snapshot> {
  return (await response.json()) as Snapshot;
}

/** Polls until the runner is idle, so a test asserts on a finished run, not a pending one. */
async function settle(): Promise<Snapshot> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const backup = await backupStatus();
    if (!backup.running) return backup;
    await Bun.sleep(50);
  }
  throw new Error("backup job never finished");
}

describe("backup status", () => {
  test("reports downloading as switched off when no device client id is set", async () => {
    const backup = await backupStatus();
    expect(backup.auth.state).toBe("unconfigured");
    expect(backup.libraryDir).toBe(config.libraryDir);
  });

  test("says whether the daemon will back up on its own", async () => {
    // Defaulted on, so an install that has downloading set up gets it without opting in —
    // and the page has to be able to say so, because nothing else would.
    expect((await backupStatus()).defaults.onSchedule).toBe(true);
  });

  test("summarises the export already on disk, without shipping the whole manifest", async () => {
    const exported = (await backupStatus()).export;
    expect(exported.summary.stats.uniqueTracks).toBe(3);
    expect(exported.summary.playlists).toEqual([
      { name: "Weekly Jams (ListenBrainz)", trackCount: 2 },
    ]);
    // The per-track metadata is what makes export.json megabytes; it must not be in here.
    expect(JSON.stringify(exported)).not.toContain("Karma Police");
  });

  test("never exposes a token", async () => {
    const body = await (await get("/api/status")).text();
    expect(body).not.toContain("accessToken");
    expect(body).not.toContain("refreshToken");
  });
});

describe("backup endpoints", () => {
  test("rejects a GET", async () => {
    expect((await get("/api/backup/download")).status).toBe(405);
  });

  test("404s an unknown action", async () => {
    expect((await post("/api/backup/nonsense")).status).toBe(404);
  });

  // Exporting is a phase of the download now, not something to press separately.
  test("no longer offers an export of its own", async () => {
    expect((await post("/api/backup/export")).status).toBe(404);
  });

  test("refuses login while downloading is unconfigured", async () => {
    const response = await post("/api/backup/login");
    expect(response.status).toBe(409);
    expect((await body(response)).error).toContain("TIDAL_DEVICE_CLIENT_ID");
  });

  test("refuses to stop when nothing is running", async () => {
    expect((await post("/api/backup/stop")).status).toBe(409);
  });

  test("validates the download form", async () => {
    for (const payload of [{ quality: "perfect" }, { skipTier: "vibes" }, { limit: 0 }, { limit: 2.5 }]) {
      const response = await post("/api/backup/download", payload);
      expect(response.status).toBe(400);
      expect((await body(response)).error).toBeString();
    }
  });

  test("refuses a real download without a playback session", async () => {
    const response = await post("/api/backup/download", { dryRun: false });
    expect(response.status).toBe(409);
    expect((await body(response)).error).toContain("Authorise");
  });

  test("runs a dry run against the collection and reports what it would fetch", async () => {
    expect((await post("/api/backup/download", { dryRun: true })).status).toBe(202);

    const backup = await settle();
    expect(backup.download.report.total).toBe(3);
    // Glory Box.mp3 is already there under a different extension.
    expect(backup.download.report.skipped).toBe(1);
    // On a dry run the counts are the plan, so the other two read as "would download".
    expect(backup.download.report.downloaded).toBe(2);
    expect(backup.download.report.upgraded).toBe(0);
    expect(backup.download.report.stopped).toBe(false);
  });

  test("a dry run leaves the snapshot alone, having promised to contact nothing", async () => {
    const before = (await backupStatus()).export.summary.exportedAt;

    expect((await post("/api/backup/download", { dryRun: true })).status).toBe(202);
    const backup = await settle();

    // A real run would have re-snapshotted first, which is the whole point of there being no
    // export button — but that reaches TIDAL, and a dry run must not.
    expect(backup.export.summary.exportedAt).toBe(before);
    expect(backup.export.lastRunAt).toBeNull();
  });

  test("scopes a dry run to one exported playlist", async () => {
    const response = await post("/api/backup/download", {
      dryRun: true,
      playlist: "Weekly Jams (ListenBrainz)",
    });
    expect(response.status).toBe(202);

    const backup = await settle();
    expect(backup.download.report.total).toBe(2);
  });

  test("honours a limit", async () => {
    expect((await post("/api/backup/download", { dryRun: true, limit: 1 })).status).toBe(202);
    const backup = await settle();
    expect(backup.download.report.total).toBe(1);
  });

  test("names a playlist that is not in the export", async () => {
    expect((await post("/api/backup/download", { dryRun: true, playlist: "Nope" })).status).toBe(202);
    const backup = await settle();
    expect(backup.download.error).toContain("No exported playlist");
  });
});

/**
 * The log page tails this endpoint, so what matters is that it can ask for only what it has
 * not seen and be told how far it now is.
 */
describe("the log endpoint", () => {
  test("serves the daemon's own lines, newest last", async () => {
    const payload = await body(await get("/api/logs"));

    expect(payload.entries.length).toBeGreaterThan(0);
    expect(payload.entries.at(-1).seq).toBe(payload.nextSeq);
    // Enough for the page to say why a level looks empty and how much is kept.
    expect(payload.level).toBe(config.logLevel);
    expect(payload.capacity).toBeGreaterThan(0);
  });

  test("`since` returns only what came after it", async () => {
    const { nextSeq } = await body(await get("/api/logs"));
    expect((await body(await get(`/api/logs?since=${nextSeq}`))).entries).toEqual([]);

    // Saving a setting is one of the things the daemon logs, so it is a line to tail.
    await post("/api/settings", { values: { TIDAL_SKIP_TIER: "loose" } });
    const tail = await body(await get(`/api/logs?since=${nextSeq}`));

    expect(tail.entries.map((entry: Snapshot) => entry.text).join("\n")).toContain("Settings saved");
    expect(tail.entries.every((entry: Snapshot) => entry.seq > nextSeq)).toBe(true);
    expect(tail.dropped).toBe(0);
    await post("/api/settings", { values: { TIDAL_SKIP_TIER: null } });
  });

  test("a nonsense cursor reads as “from the beginning” rather than an error", async () => {
    const payload = await body(await get("/api/logs?since=nonsense"));
    expect(payload.entries.length).toBeGreaterThan(0);
  });

  test("rejects a POST", async () => {
    expect((await post("/api/logs")).status).toBe(405);
  });
});

/**
 * The settings page is a form over the same `Config` every runner holds, so what matters here
 * is that a save reaches it — and that a refused one changes nothing.
 */
describe("settings endpoints", () => {
  const put = (values: Record<string, string | null>) => post("/api/settings", { values });

  test("serves every setting with where its value came from", async () => {
    const snapshot = await body(await get("/api/settings"));
    const fields = snapshot.groups.flatMap((group: Snapshot) => group.fields);

    // Unset in both layers, so the box is empty and the built-in default is what the page
    // shows as its placeholder — typing nothing has to keep meaning "leave it to the daemon".
    const schedule = fields.find((field: Snapshot) => field.key === "SYNC_SCHEDULE");
    expect(schedule.value).toBe("");
    expect(schedule.fallback).toBe("0 */6 * * *");
    expect(schedule.source).toBe("default");

    // Set in this suite's environment, so the page can say so and offer nothing to reset.
    const library = fields.find((field: Snapshot) => field.key === "LIBRARY_DIR");
    expect(library.source).toBe("env");
    expect(library.overridden).toBe(false);
  });

  test("rejects a GET-shaped body and an unknown setting", async () => {
    expect((await post("/api/settings", { SYNC_SCHEDULE: "0 4 * * *" })).status).toBe(400);
    expect((await put({ NONSENSE: "1" })).status).toBe(400);
  });

  test("a save reaches the config the daemon is running on", async () => {
    const response = await put({ TIDAL_SKIP_TIER: "loose" });
    expect(response.status).toBe(200);

    expect(config.skipTier).toBe("loose");
    // And the status page's own defaults follow it, since they read the same object.
    expect((await backupStatus()).defaults.skipTier).toBe("loose");

    await put({ TIDAL_SKIP_TIER: null });
    expect(config.skipTier).toBe("album-agnostic");
  });

  test("says why a refused save was refused, and changes nothing", async () => {
    const response = await put({ SYNC_SCHEDULE: "every thursday" });

    expect(response.status).toBe(400);
    expect((await body(response)).error).toContain("SYNC_SCHEDULE");
    expect(config.schedule).toBe("0 */6 * * *");
  });

  test("never sends a secret back to the page", async () => {
    expect((await put({ LISTENBRAINZ_TOKEN: "shh" })).status).toBe(200);

    expect(await (await get("/api/settings")).text()).not.toContain("shh");
    await put({ LISTENBRAINZ_TOKEN: null });
  });
});

/**
 * Upgrading is the one mode that touches files the user already has, so the decision needs
 * to be visible before it acts: a dry run must say what it would replace and what with.
 */
const hasFfmpeg = Boolean(Bun.which("ffmpeg") && Bun.which("ffprobe"));

describe.if(hasFfmpeg)("upgrade mode", () => {
  test("leaves the existing file alone when upgrading is off", async () => {
    expect((await post("/api/backup/download", { dryRun: true, upgrade: false })).status).toBe(202);

    const backup = await settle();
    expect(backup.download.report.upgraded).toBe(0);
    expect(backup.download.report.skipped).toBe(1);
  });

  test("plans a replacement for a lossy file TIDAL has lossless", async () => {
    expect((await post("/api/backup/download", { dryRun: true, upgrade: true })).status).toBe(202);

    const backup = await settle();
    // Glory Box.mp3 is lossy and TIDAL tags the track LOSSLESS, so it becomes an upgrade
    // rather than a skip.
    expect(backup.download.report.upgraded).toBe(1);
    expect(backup.download.report.upgradedFrom.lossy).toBe(1);
    expect(backup.download.report.skipped).toBe(0);
    expect(backup.download.report.alreadyBest).toBe(0);
  });

  test("does not plan a replacement a lossless run could not deliver", async () => {
    // The AAC tiers are lossy, so nothing a `high` run downloads beats an existing mp3.
    expect((await post("/api/backup/download", { dryRun: true, upgrade: true, quality: "high" })).status).toBe(202);

    const backup = await settle();
    expect(backup.download.report.upgraded).toBe(0);
    expect(backup.download.report.alreadyBest).toBe(1);
    expect(backup.download.report.skipped).toBe(1);
  });

  test("carries the flag through to the report's request", async () => {
    expect((await post("/api/backup/download", { dryRun: true, upgrade: true })).status).toBe(202);
    expect((await settle()).download.request.upgrade).toBe(true);
  });
});

describe.if(hasFfmpeg)("per-track events", () => {
  test("a dry run lists every track and what would happen to it", async () => {
    expect((await post("/api/backup/download", { dryRun: true, upgrade: true })).status).toBe(202);
    const { download } = await settle();

    // One row per track considered, in run order — this is what the page lists.
    expect(download.events).toHaveLength(3);
    expect(download.events.map((event: Snapshot) => event.index)).toEqual([1, 2, 3]);

    const outcomes = Object.fromEntries(
      download.events.map((event: Snapshot) => [event.track, event.outcome]),
    );
    expect(outcomes["Radiohead - Karma Police"]).toBe("downloaded");
    expect(outcomes["Aphex Twin - Avril 14th"]).toBe("downloaded");
    expect(outcomes["Portishead - Glory Box"]).toBe("upgraded");
  });

  test("an upgrade row says what it is replacing and with what", async () => {
    expect((await post("/api/backup/download", { dryRun: true, upgrade: true })).status).toBe(202);
    const { download } = await settle();

    const upgrade = download.events.find((event: Snapshot) => event.outcome === "upgraded");
    // "mp3 44.1kHz → lossless" — enough to judge the swap without opening the file.
    expect(upgrade.detail).toContain("mp3");
    expect(upgrade.detail).toContain("→ lossless");
    expect(upgrade.path).toBe("Portishead/Dummy/Glory Box.mp3");
  });

  test("a skip says which tier matched it", async () => {
    expect((await post("/api/backup/download", { dryRun: true })).status).toBe(202);
    const { download } = await settle();

    const skip = download.events.find((event: Snapshot) => event.outcome === "skipped");
    expect(skip.detail).toBe("exact");
    expect(skip.path).toBe("Portishead/Dummy/Glory Box.mp3");
  });

  test("events reset between runs rather than accumulating", async () => {
    expect((await post("/api/backup/download", { dryRun: true, limit: 1 })).status).toBe(202);
    expect((await settle()).download.events).toHaveLength(1);
  });
});
