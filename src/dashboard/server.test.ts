import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackupRunner } from "../backup.ts";
import { loadConfig, type Config } from "../config.ts";
import { SyncRunner } from "../runner.ts";
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

const TRACKS = {
  "1": { tidalId: "1", title: "Karma Police", artists: ["Radiohead"], album: "OK Computer", path: "Radiohead/OK Computer/Karma Police.flac" },
  "2": { tidalId: "2", title: "Avril 14th", artists: ["Aphex Twin"], album: "Drukqs", path: "Aphex Twin/Drukqs/Avril 14th.flac" },
  "3": { tidalId: "3", title: "Glory Box", artists: ["Portishead"], album: "Dummy", path: "Portishead/Dummy/Glory Box.flac" },
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "dashboard-backup-"));

  // One of the three is already on disk, as an .mp3 from some other tool.
  const existing = join(root, "library", "Portishead", "Dummy");
  await mkdir(existing, { recursive: true });
  await writeFile(join(existing, "Glory Box.mp3"), "");

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
    LOG_LEVEL: "error",
  });

  config = loadConfig();
  // Port 0 lets the OS pick a free one, which config validation will not accept but a test
  // running alongside a real daemon needs.
  config.dashboard.port = 0;
  config.dashboard.host = "127.0.0.1";

  const store = await SyncStore.open(config.dataDir);
  const backup = await BackupRunner.create(config);
  server = startDashboard({
    config,
    store,
    runner: new SyncRunner(config, store),
    backup,
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
    expect((await get("/api/backup/export")).status).toBe(405);
  });

  test("404s an unknown action", async () => {
    expect((await post("/api/backup/nonsense")).status).toBe(404);
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
    expect(backup.download.report.downloaded).toBe(0);
    expect(backup.download.report.stopped).toBe(false);
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
