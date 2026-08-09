import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectoryNames } from "./directories.ts";

/**
 * The bug this closes, observed on a real library: 30 duplicated artist folders, each a pair
 * like `Nero` (the user's rip, with lyrics and artwork) next to `NERO` (one .flac this tool
 * wrote). TIDAL's spelling is not the library's, and on a case-sensitive filesystem the
 * difference is a second artist in whatever serves the music.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "directories-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const existing = (path: string) => mkdir(join(root, path), { recursive: true });

describe("preferring the spelling already on disk", () => {
  test("writes into the artist folder that is there, not TIDAL's casing of it", async () => {
    await existing("Nero/Welcome Reality");

    const names = new DirectoryNames(root);
    expect(await names.resolve("NERO/Welcome Reality/Promises.flac")).toBe(
      "Nero/Welcome Reality/Promises.flac",
    );
  });

  test("reconciles the album as well as the artist", async () => {
    await existing("Griz/Say It Loud");
    const names = new DirectoryNames(root);
    expect(await names.resolve("GRiZ/SAY IT LOUD/Smash the Funk.flac")).toBe(
      "Griz/Say It Loud/Smash the Funk.flac",
    );
  });

  test("matches across the punctuation a sanitised name loses", async () => {
    // `sanitize("AC/DC")` strips the slash and produces `ACDC`, which is how a real library
    // ended up with that next to its own `AC_DC`.
    await existing("AC_DC/Back in Black");
    const names = new DirectoryNames(root);
    expect(await names.resolve("ACDC/Back in Black/Hells Bells.flac")).toBe(
      "AC_DC/Back in Black/Hells Bells.flac",
    );
  });

  test("finds a folder holding no audio at all", async () => {
    // Several of the real duplicates were folders with only a .lrc and a .jpg in them, which
    // the library index never sees — so this cannot be built from the index's file list.
    await existing("deadmau5");
    const names = new DirectoryNames(root);
    expect(await names.resolve("Deadmau5/4x4=12/Ghosts n Stuff.flac")).toBe(
      "deadmau5/4x4=12/Ghosts n Stuff.flac",
    );
  });

  test("leaves an artist it has never seen exactly as TIDAL spelled them", async () => {
    const names = new DirectoryNames(root);
    expect(await names.resolve("MYRNE/Softer/Afterthought.flac")).toBe(
      "MYRNE/Softer/Afterthought.flac",
    );
  });

  test("keeps one run self-consistent about a folder it is creating", async () => {
    const names = new DirectoryNames(root);

    // Nothing on disk, so the first track picks the spelling — and every track after it in
    // the same run has to agree, or one run alone would produce the duplicate.
    expect(await names.resolve("MYRNE/Softer/One.flac")).toBe("MYRNE/Softer/One.flac");
    expect(await names.resolve("Myrne/softer/Two.flac")).toBe("MYRNE/Softer/Two.flac");
  });

  test("does not touch the filename, only the directories", async () => {
    await existing("Nero");
    const names = new DirectoryNames(root);
    // Two tracks whose titles differ only in case are still two tracks.
    expect(await names.resolve("NERO/Album/PROMISES.flac")).toBe("Nero/Album/PROMISES.flac");
  });

  test("survives a library directory that does not exist yet", async () => {
    const names = new DirectoryNames(join(root, "nothing-here"));
    expect(await names.resolve("Artist/Album/Track.flac")).toBe("Artist/Album/Track.flac");
  });
});
