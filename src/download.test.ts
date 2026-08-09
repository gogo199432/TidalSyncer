import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tidalDownload from "./tidal/download.ts";

/**
 * The upgrade path, end to end, with only the actual fetch replaced.
 *
 * This is the one part of `download` where being wrong costs the user a file they already
 * had, and the failure it guards against is not a crash but an equilibrium: TIDAL lists a
 * track as HIRES_LOSSLESS, the account is only entitled to 16-bit, and the "upgrade" writes
 * exactly what was already on disk — then does it again on the next run, and the next, now
 * unattended on a schedule. `served` below is what the fake TIDAL hands back, so each test
 * says what the catalogue promised and what the subscription actually delivered.
 */

const hasFfmpeg = Boolean(Bun.which("ffmpeg") && Bun.which("ffprobe"));

/** What the stubbed `downloadTrack` will write next, and where it was asked to write it. */
let served: { args: string[]; extension: string } | "preview" | "throws" = "preview";
let calls: { trackId: string; destination: string }[] = [];

mock.module("./tidal/download.ts", () => ({
  ...tidalDownload,
  downloadTrack: async (_session: unknown, trackId: string, destination: string) => {
    calls.push({ trackId, destination });
    if (served === "throws") throw new tidalDownload.DownloadError("segment 3/9 failed (503)");
    if (served === "preview") return undefined;

    const target = `${destination.replace(/\.[^./]*$/, "")}.${served.extension}`;
    await mkdir(join(target, ".."), { recursive: true });
    encode(target, served.args);
    return target;
  },
}));

// Imported after the mock so the stub is what `runDownload` closes over.
const { runDownload } = await import("./download.ts");
const { loadConfig } = await import("./config.ts");

function encode(path: string, args: string[]): void {
  const result = spawnSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    ...args, path,
  ]);
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr}`);
}

const CD_FLAC = { args: ["-c:a", "flac", "-ar", "44100", "-sample_fmt", "s16"], extension: "flac" };
const HIRES_FLAC = { args: ["-c:a", "flac", "-ar", "96000", "-sample_fmt", "s32"], extension: "flac" };

const TRACK_PATH = "Portishead/Dummy/Glory Box.flac";

let root: string;
// biome-ignore lint/suspicious/noExplicitAny: the loaded config, shaped by env
let config: any;

/** One track, which TIDAL's catalogue claims to have in hi-res. */
async function seed(existing: { args: string[]; extension: string }): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "upgrade-loop-"));

  const libraryDir = join(root, "library");
  const existingPath = join(libraryDir, "Portishead", "Dummy", `Glory Box.${existing.extension}`);
  await mkdir(join(libraryDir, "Portishead", "Dummy"), { recursive: true });
  encode(existingPath, existing.args);

  await mkdir(join(root, "data", "export"), { recursive: true });
  await writeFile(
    join(root, "data", "export", "export.json"),
    JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      countryCode: "NL",
      playlists: [],
      favoriteIds: ["3"],
      tracks: {
        "3": {
          tidalId: "3",
          title: "Glory Box",
          artists: ["Portishead"],
          album: "Dummy",
          path: TRACK_PATH,
          mediaTags: ["HIRES_LOSSLESS", "LOSSLESS"],
        },
      },
      stats: { playlists: 0, favorites: 1, uniqueTracks: 1, unresolved: 0, withIsrc: 0 },
    }),
  );

  // A stored session, so `runDownload` gets past its authentication check. The stub never
  // reads it — nothing here talks to TIDAL.
  await writeFile(
    join(root, "data", "tidal-download.session.json"),
    JSON.stringify({ accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }),
  );

  Object.assign(process.env, {
    LISTENBRAINZ_USER: "tester",
    TIDAL_CLIENT_ID: "test-client",
    TIDAL_CLIENT_SECRET: "test-secret",
    TIDAL_DEVICE_CLIENT_ID: "device-client",
    DATA_DIR: join(root, "data"),
    LIBRARY_DIR: libraryDir,
    TIDAL_REPLACED_DIR: join(root, "replaced"),
    // Re-set on every seed, so a test that changes it cannot leak into the next one.
    TIDAL_REPLACED_RETENTION_DAYS: "7",
    TIDAL_DOWNLOAD_DELAY_MS: "0",
    LOG_LEVEL: "error",
  });
  config = loadConfig();

  calls = [];
  return existingPath;
}

const run = (overrides: Record<string, unknown> = {}) =>
  runDownload(config, {
    quality: "hires",
    skipTier: "album-agnostic",
    dryRun: false,
    upgrade: true,
    ...overrides,
  });

/** Everything in the library, library-relative, so a stray `.superseded` shows up. */
async function libraryFiles(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string, prefix: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const next = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), next);
      else found.push(next);
    }
  };
  await walk(config.libraryDir, "");
  return found.sort();
}

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.if(hasFfmpeg)("an upgrade TIDAL cannot actually deliver", () => {
  beforeEach(() => {
    // The catalogue says hi-res; the subscription is served plain CD-quality FLAC. This is
    // not an error and not a preview — just a smaller file than the tags implied.
    served = CD_FLAC;
  });

  test("keeps the file it already had rather than swapping it for an equal one", async () => {
    const existingPath = await seed(CD_FLAC);
    const before = await readFile(existingPath);

    const report = await run();

    expect(report.upgraded).toBe(0);
    expect(report.alreadyBest).toBe(1);
    expect(report.skipped).toBe(1);
    expect(await readFile(existingPath)).toEqual(before);
  });

  test("leaves nothing parked or duplicated behind", async () => {
    await seed(CD_FLAC);
    await run();

    expect(await libraryFiles()).toEqual([`Portishead/Dummy/Glory Box.flac`]);
    // Nothing was replaced, so nothing should have been retired.
    expect(await readdir(config.replacedDir).catch(() => [])).toEqual([]);
  });

  test("does not fetch it again on the next run — the loop this all exists to close", async () => {
    await seed(CD_FLAC);

    await run();
    expect(calls).toHaveLength(1);

    const second = await run();
    // No second fetch: the first run wrote down what TIDAL actually served.
    expect(calls).toHaveLength(1);
    expect(second.alreadyBest).toBe(1);
    expect(second.upgraded).toBe(0);
  });

  test("a dry run plans the same thing the real run would do", async () => {
    await seed(CD_FLAC);
    await run();

    const planned = await run({ dryRun: true });
    // Without the ledger being consulted on dry runs this reads "would upgrade 1", which is
    // a plan the real run has already proved wrong.
    expect(planned.upgraded).toBe(0);
    expect(planned.alreadyBest).toBe(1);
  });

  test("still fetches when a run aims higher than the one that was satisfied", async () => {
    await seed({ args: ["-c:a", "libmp3lame"], extension: "mp3" });

    // A lossless run asked for lossless and got it: a success, recorded as one. It says
    // nothing about hi-res, so the hi-res run below is entitled to its own disappointment.
    expect((await run({ quality: "lossless" })).upgraded).toBe(1);
    expect(calls).toHaveLength(1);

    await run({ quality: "hires" });
    expect(calls).toHaveLength(2);
  });
});

describe.if(hasFfmpeg)("an upgrade TIDAL does deliver", () => {
  beforeEach(() => {
    served = HIRES_FLAC;
  });

  test("replaces the file and retires the old copy", async () => {
    await seed(CD_FLAC);

    const report = await run();

    expect(report.upgraded).toBe(1);
    expect(report.upgradedFrom.lossless).toBe(1);
    expect(await libraryFiles()).toEqual([TRACK_PATH]);
    // The old copy is recoverable, mirroring its path in the library.
    expect(await readdir(join(config.replacedDir, "Portishead", "Dummy"))).toEqual(["Glory Box.flac"]);
  });

  test("settles afterwards rather than upgrading the upgrade", async () => {
    await seed(CD_FLAC);
    await run();

    const second = await run();
    expect(second.upgraded).toBe(0);
    expect(second.skipped).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test("replaces a lossy file that lives under a different extension", async () => {
    await seed({ args: ["-c:a", "libmp3lame"], extension: "mp3" });

    const report = await run();

    expect(report.upgraded).toBe(1);
    expect(report.upgradedFrom.lossy).toBe(1);
    // Exactly one copy: the .mp3 must not survive alongside the .flac that replaced it.
    expect(await libraryFiles()).toEqual([TRACK_PATH]);
  });
});

describe.if(hasFfmpeg)("when TIDAL serves nothing at all", () => {
  beforeEach(() => {
    served = "preview";
  });

  test("puts the existing file back and counts the track unavailable", async () => {
    const existingPath = await seed(CD_FLAC);
    const before = await readFile(existingPath);

    const report = await run();

    expect(report.unavailable).toBe(1);
    expect(report.upgraded).toBe(0);
    expect(await readFile(existingPath)).toEqual(before);
  });

  test("does not write it off — an unentitled track may become entitled later", async () => {
    await seed(CD_FLAC);
    await run();

    served = HIRES_FLAC;
    expect((await run()).upgraded).toBe(1);
  });
});

/**
 * A run killed by SIGKILL — or by the daemon's SIGTERM handler, which exits without waiting
 * for the current track — strands whatever it was part-way through writing. Nothing else
 * would ever remove it, and downloads only became unattended when they went on the schedule.
 */
describe.if(hasFfmpeg)("leftovers from a run that was interrupted", () => {
  const strand = async (name: string) => {
    const path = join(config.libraryDir, "Portishead", "Dummy", name);
    await writeFile(path, "half a track");
    return path;
  };

  const exists = (path: string) => Bun.file(path).exists();

  test("clears them, whichever half of a download they came from", async () => {
    served = "preview";
    await seed(CD_FLAC);

    // The two shapes `downloadTrack` writes, plus the scratch name an upgrade fetches to.
    const raw = await strand("Glory Box.flac.999999.tidalsyncer-raw");
    const part = await strand("Glory Box.flac.999999.tidalsyncer-part");
    const scratch = await strand(".upgrading-999999-Glory Box.flac");

    await run();

    expect(await exists(raw)).toBe(false);
    expect(await exists(part)).toBe(false);
    expect(await exists(scratch)).toBe(false);
    expect(await libraryFiles()).toEqual(["Portishead/Dummy/Glory Box.flac"]);
  });

  test("cannot mistake a real file for one, however it is named", async () => {
    served = "preview";
    await seed(CD_FLAC);

    // The raw segments used to be written as `<name>.<pid>.m4a`, which is indistinguishable
    // from a perfectly ordinary file somebody already had. Deleting one of those would be
    // the worst thing this tool could do.
    const keep = [
      await strand("Live.2001.m4a"),
      await strand("Glory Box.flac.999999.m4a"),
      await strand("Dummy 1994.flac"),
      await strand("tidalsyncer-raw.flac"),
    ];

    await run();

    for (const path of keep) expect(await exists(path)).toBe(true);
  });

  test("leaves a dry run's library exactly as it found it", async () => {
    served = "preview";
    await seed(CD_FLAC);
    const raw = await strand("Glory Box.flac.999999.tidalsyncer-raw");

    await run({ dryRun: true });

    // A dry run promises to change nothing, and that has to include tidying up.
    expect(await exists(raw)).toBe(true);
  });
});

/**
 * `replacedDir` is the undo for the one operation that destroys something the user had, so it
 * is not cleared the moment a replacement lands — but it is also where most of a library ends
 * up if you upgrade most of a library, and nothing else would ever remove any of it.
 */
describe.if(hasFfmpeg)("pruning what an upgrade retired", () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** A file in the retire directory, aged by setting both of the times prune reads. */
  const retired = async (name: string, ageDays: number) => {
    const path = join(config.replacedDir, "Portishead", "Dummy", name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "a retired copy");
    const when = new Date(Date.now() - ageDays * DAY);
    await utimes(path, when, when);
    return path;
  };

  const exists = (path: string) => Bun.file(path).exists();

  beforeEach(() => {
    served = "preview";
  });

  test("removes what is past the window and keeps what is not", async () => {
    await seed(CD_FLAC);
    const stale = await retired("Old.mp3", 9);
    const fresh = await retired("Recent.mp3", 2);

    await run();

    expect(await exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  });

  test("takes the empty folders with it, but never the directory itself", async () => {
    await seed(CD_FLAC);
    await retired("Old.mp3", 9);

    await run();

    // An upgraded library would otherwise leave a skeleton of empty Artist/Album folders.
    expect(await exists(join(config.replacedDir, "Portishead"))).toBe(false);
    // The root stays: the next retire needs somewhere to put things.
    expect(await readdir(config.replacedDir)).toEqual([]);
  });

  test("counts from when the file was retired, not from when it was recorded", async () => {
    // The point of `stamp`. This mp3 was ripped years ago, so its own mtime is ancient —
    // pruning on that would delete the undo the instant the upgrade created it.
    const existingPath = await seed({ args: ["-c:a", "libmp3lame"], extension: "mp3" });
    const ancient = new Date(Date.now() - 400 * DAY);
    await utimes(existingPath, ancient, ancient);

    served = HIRES_FLAC;
    expect((await run()).upgraded).toBe(1);

    // Retired seconds ago, so a second run must not treat it as a year old and bin it.
    await run();
    expect(await exists(join(config.replacedDir, "Portishead", "Dummy", "Glory Box.mp3"))).toBe(true);
  });

  test("keeps everything for ever when the retention is switched off", async () => {
    await seed(CD_FLAC);
    process.env.TIDAL_REPLACED_RETENTION_DAYS = "0";
    config = loadConfig();
    const stale = await retired("Old.mp3", 400);

    await run();

    expect(await exists(stale)).toBe(true);
  });

  test("leaves it alone on a dry run, which changes nothing", async () => {
    await seed(CD_FLAC);
    const stale = await retired("Old.mp3", 9);

    await run({ dryRun: true });

    expect(await exists(stale)).toBe(true);
  });
});

describe.if(hasFfmpeg)("when the fetch goes wrong halfway", () => {
  test("the file being replaced has not moved, because it is never moved first", async () => {
    served = "throws";
    const existingPath = await seed(CD_FLAC);
    const before = await readFile(existingPath);

    const report = await run();

    // The upgrade is a failed *track*, not a lost one: whatever a killed run leaves behind,
    // it is never the library missing something it had before the run started.
    expect(report.failed).toBe(1);
    expect(report.upgraded).toBe(0);
    expect(await readFile(existingPath)).toEqual(before);
    expect(await libraryFiles()).toEqual(["Portishead/Dummy/Glory Box.flac"]);
  });
});

afterAll(() => {
  mock.restore();
});
