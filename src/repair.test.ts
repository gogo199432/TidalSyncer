import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.ts";
import { backfillTags, pruneOrphanFolders } from "./repair.ts";
import { isUntagged, readTags } from "./tags.ts";

/**
 * The one-off pass over a library filled before downloads were tagged.
 *
 * Both halves rewrite or delete files somebody already has, so what is under test is mostly
 * restraint: which files it refuses to touch, and which folders it refuses to remove.
 */

const hasFfmpeg = Boolean(Bun.which("ffmpeg") && Bun.which("ffprobe"));

let root: string;
let libraryDir: string;
// biome-ignore lint/suspicious/noExplicitAny: the loaded config, shaped by env
let config: any;

/** A second of tone at `path`, with whatever tags the arguments carry. */
function encode(path: string, args: string[] = []): void {
  const result = spawnSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    ...args, path,
  ]);
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr}`);
}

async function seed(tracks: Record<string, unknown>): Promise<void> {
  root = await mkdtemp(join(tmpdir(), "repair-"));
  libraryDir = join(root, "library");
  await mkdir(join(root, "data", "export"), { recursive: true });
  await mkdir(libraryDir, { recursive: true });

  await writeFile(
    join(root, "data", "export", "export.json"),
    JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      countryCode: "NL",
      playlists: [],
      favoriteIds: Object.keys(tracks),
      tracks,
      stats: { playlists: 0, favorites: 0, uniqueTracks: 0, unresolved: 0, withIsrc: 0 },
    }),
  );

  Object.assign(process.env, {
    LISTENBRAINZ_USER: "tester",
    TIDAL_CLIENT_ID: "test-client",
    TIDAL_CLIENT_SECRET: "test-secret",
    DATA_DIR: join(root, "data"),
    LIBRARY_DIR: libraryDir,
    // Deliberately inside the library, which is what the k3s deployment does and what the
    // config permits with a warning.
    TIDAL_REPLACED_DIR: join(libraryDir, ".replaced"),
    LOG_LEVEL: "error",
  });
  config = loadConfig();
}

/** Writes an untagged file at a library-relative path. */
function bare(relativePath: string): string {
  const path = join(libraryDir, relativePath);
  spawnSync("mkdir", ["-p", dirname(path)]);
  encode(path, ["-c:a", "flac"]);
  return path;
}

const GLORY_BOX = {
  tidalId: "3",
  title: "Glory Box",
  artists: ["Portishead", "Beth Gibbons"],
  album: "Dummy",
  releaseDate: "1994-08-22",
  isrc: "GBAAA9400123",
  path: "Portishead/Dummy/Glory Box.flac",
};

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe.if(hasFfmpeg)("backfillTags", () => {
  const run = (dryRun = false) => backfillTags(config, { dryRun, tags: true, orphans: false });

  beforeEach(async () => {
    await seed({ "3": GLORY_BOX });
  });

  test("writes the snapshot's metadata into a file that has none", async () => {
    const path = bare("Portishead/Dummy/Glory Box.flac");

    const report = await run();
    expect(report.untagged).toBe(1);
    expect(report.tagged).toBe(1);

    const tags = (await readTags(path))!;
    expect(isUntagged(tags)).toBe(false);
    expect(tags.tags.title).toBe("Glory Box");
    expect(tags.tags.artist).toBe("Portishead");
    expect(tags.tags.album).toBe("Dummy");
    expect(tags.tags.date).toBe("1994-08-22");
  });

  test("leaves a file that already says something about itself alone", async () => {
    const path = join(libraryDir, "Portishead", "Dummy", "Glory Box.flac");
    await mkdir(dirname(path), { recursive: true });
    // Somebody else's tagging, with their spelling of the album. Not ours to overrule.
    encode(path, ["-c:a", "flac", "-metadata", "title=Glory Box", "-metadata", "album=Dummy (Remastered)"]);

    const report = await run();
    expect(report.untagged).toBe(0);
    expect(report.tagged).toBe(0);
    expect((await readTags(path))!.tags.album).toBe("Dummy (Remastered)");
  });

  test("matches a file filed under a different album", async () => {
    // What a Soulseek rescue leaves: the right recording, under the release MusicBrainz named.
    const path = bare("Portishead/Glory Box (Single)/Glory Box.flac");

    expect((await run()).tagged).toBe(1);
    expect((await readTags(path))!.tags.title).toBe("Glory Box");
  });

  test("matches through a track number on the filename", async () => {
    const path = bare("Portishead/Dummy/05 - Glory Box.flac");

    expect((await run()).tagged).toBe(1);
    expect((await readTags(path))!.tags.artist).toBe("Portishead");
  });

  test("leaves an untagged file the snapshot cannot name", async () => {
    const path = bare("Some Bootleg/Live 1997/Track 04.flac");

    const report = await run();
    expect(report.untagged).toBe(1);
    expect(report.unmatched).toBe(1);
    expect(report.tagged).toBe(0);
    expect(isUntagged((await readTags(path))!)).toBe(true);
  });

  test("never looks inside the retired-files directory", async () => {
    const retired = bare(".replaced/Portishead/Dummy/Glory Box.flac");

    const report = await run();
    expect(report.files).toBe(0);
    // A retired file is not in the library any more, whatever the filesystem says.
    expect(isUntagged((await readTags(retired))!)).toBe(true);
  });

  test("a dry run reports what it would do and writes nothing", async () => {
    const path = bare("Portishead/Dummy/Glory Box.flac");

    expect((await run(true)).tagged).toBe(1);
    expect(isUntagged((await readTags(path))!)).toBe(true);
  });

  test("a file that is not audio is reported as unreadable, not rewritten", async () => {
    const path = join(libraryDir, "Portishead", "Dummy", "Glory Box.flac");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "not a flac");

    const report = await run();
    expect(report.failed).toBe(1);
    expect(report.tagged).toBe(0);
    expect(await Bun.file(path).text()).toBe("not a flac");
  });
});

describe("pruneOrphanFolders", () => {
  const run = (dryRun = false) => pruneOrphanFolders(config, { dryRun, tags: false, orphans: true });

  const write = async (relativePath: string, contents = "x") => {
    const path = join(libraryDir, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
    return path;
  };

  const remaining = async (): Promise<string[]> => (await readdir(libraryDir)).sort();

  beforeEach(async () => {
    await seed({});
  });

  test("removes an album folder left with only a cover and lyrics", async () => {
    await write("Tennessee Ernie Ford/Sixteen Tons/cover.jpg");
    await write("Tennessee Ernie Ford/Sixteen Tons/01 - 16 Tons.lrc");
    await write("Tennessee Ernie Ford/16 Tons/16 Tons.flac");

    const report = await run();
    expect(report.removed).toBe(1);
    expect(report.files).toBe(2);
    expect(await readdir(join(libraryDir, "Tennessee Ernie Ford"))).toEqual(["16 Tons"]);
  });

  test("keeps a folder that still holds audio", async () => {
    await write("Portishead/Dummy/cover.jpg");
    await write("Portishead/Dummy/Glory Box.flac");

    expect((await run()).removed).toBe(0);
    expect(await remaining()).toEqual(["Portishead"]);
  });

  test("takes a whole abandoned artist as one folder, not one per album", async () => {
    await write("Gone/Album One/cover.jpg");
    await write("Gone/Album Two/cover.jpg");

    const report = await run();
    expect(report.removed).toBe(1);
    expect(report.examples).toEqual(["Gone"]);
    expect(await remaining()).toEqual([]);
  });

  test("keeps a folder holding something it does not recognise", async () => {
    await write("Portishead/Dummy/cover.jpg");
    await write("Portishead/Dummy/live-set.mkv");

    expect((await run()).removed).toBe(0);
    expect(await remaining()).toEqual(["Portishead"]);
  });

  test("keeps a folder somebody has told a scanner to ignore", async () => {
    await write("LE SSERAFIM/.ndignore");
    await write("LE SSERAFIM/cover.jpg");

    expect((await run()).removed).toBe(0);
    expect(await remaining()).toEqual(["LE SSERAFIM"]);
  });

  test("leaves the retired-files directory alone", async () => {
    await write(".replaced/Kavinsky/Nightcall/cover.jpg");

    expect((await run()).removed).toBe(0);
    expect(await remaining()).toEqual([".replaced"]);
  });

  test("removes an empty folder", async () => {
    await mkdir(join(libraryDir, "Empty", "Album"), { recursive: true });

    expect((await run()).removed).toBe(1);
    expect(await remaining()).toEqual([]);
  });

  test("never removes the library root", async () => {
    expect((await run()).removed).toBe(0);
    expect(await readdir(libraryDir)).toEqual([]);
  });

  test("a dry run reports what it would remove and removes nothing", async () => {
    await write("Tennessee Ernie Ford/Sixteen Tons/cover.jpg");

    const report = await run(true);
    expect(report.removed).toBe(1);
    expect(report.files).toBe(1);
    expect(await remaining()).toEqual(["Tennessee Ernie Ford"]);
  });
});
