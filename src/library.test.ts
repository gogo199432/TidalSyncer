import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LibraryIndex } from "./library.ts";
import { sanitize } from "./export.ts";

let root: string;
let index: LibraryIndex;

const EXISTING = [
  "Radiohead/OK Computer/Karma Police.flac",
  // Same track, but ripped to mp3 by some other tool.
  "Portishead/Dummy/Glory Box.mp3",
  // Filed under the single, not the album TIDAL credits it to.
  "Bonobo/Black Sands/Kiara.m4a",
  // Punctuation this tool would render differently.
  "Kendrick Lamar/DAMN./DUCKWORTH..flac",
  "Bjork/Homogenic/Joga.flac",
  // Has a bracketed suffix the wanted title will not.
  "The Beatles/Abbey Road/Come Together (Remastered 2019).flac",
  // A collaboration filed under the second credited artist.
  "Burial/Untrue/Archangel.flac",
  // Roughly half of a real library looks like this — a track number on the front.
  "Pendulum/Hold Your Colour/02 - Slam.flac",
  "Simon & Garfunkel/Graceland/06 You Can Call Me Al.flac",
  "Kygo/Cloud Nine/01. Stole the Show.flac",
  // A title that genuinely starts with a number must survive intact.
  "Jay-Z/The Black Album/99 Problems.flac",
  // Multi-disc sets put a disc folder between the album and the track.
  "Parliament/Tear The Roof Off/Disc 2/02 - Give Up The Funk.m4a",
  // A flat release folder, with the artist in the filename rather than the directory.
  "Music/F.O.O.L - Destroyer of Speakers.flac",
  "not-music/readme.txt",
];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "library-index-"));
  for (const relative of EXISTING) {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "");
  }
  index = await LibraryIndex.build(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LibraryIndex", () => {
  test("indexes audio files and ignores everything else", () => {
    expect(index.fileCount).toBe(EXISTING.length - 1);
  });

  test("matches on artist, album and title", () => {
    const hit = index.find({ artists: ["Radiohead"], album: "OK Computer", title: "Karma Police" });
    expect(hit?.tier).toBe("exact");
  });

  test("matches regardless of file extension", () => {
    // The whole point: an .mp3 from another tool must count as already present.
    const hit = index.find({ artists: ["Portishead"], album: "Dummy", title: "Glory Box" });
    expect(hit?.tier).toBe("exact");
    expect(hit?.path).toEndWith("Glory Box.mp3");
  });

  test("matches when the album differs", () => {
    const hit = index.find({ artists: ["Bonobo"], album: "Kiara - Single", title: "Kiara" });
    expect(hit?.tier).toBe("album-agnostic");
  });

  test("folds case, accents and punctuation", () => {
    expect(index.find({ artists: ["Björk"], album: "Homogenic", title: "Jóga" })?.tier).toBe("exact");
    expect(index.find({ artists: ["Kendrick Lamar"], album: "DAMN.", title: "DUCKWORTH." })).toBeDefined();
  });

  test("matches once bracketed suffixes are dropped, at the loose tier only", () => {
    const hit = index.find({ artists: ["The Beatles"], album: "Abbey Road", title: "Come Together" });
    expect(hit?.tier).toBe("loose");
  });

  test("tries every credited artist, not just the first", () => {
    // TIDAL credits this to the featured artist first; the library files it under Burial.
    // Every tier scans all credited artists, so this still resolves at the strictest one.
    const hit = index.find({ artists: ["Some Featured Guest", "Burial"], album: "Untrue", title: "Archangel" });
    expect(hit?.tier).toBe("exact");
    expect(hit?.path).toEndWith("Archangel.flac");
  });

  test("looks past a leading track number", () => {
    // The dominant shape in a real library: "02 - Slam.flac" must answer to "Slam".
    expect(index.find({ artists: ["Pendulum"], album: "Hold Your Colour", title: "Slam" })?.tier).toBe("exact");
    expect(index.find({ artists: ["Simon & Garfunkel"], album: "Graceland", title: "You Can Call Me Al" })?.tier).toBe("exact");
    expect(index.find({ artists: ["Kygo"], album: "Cloud Nine", title: "Stole the Show" })?.tier).toBe("exact");
  });

  test("keeps a title that genuinely starts with a number", () => {
    // The stripped form is an alias, never a replacement, so the literal name still wins.
    const hit = index.find({ artists: ["Jay-Z"], album: "The Black Album", title: "99 Problems" });
    expect(hit?.path).toEndWith("99 Problems.flac");
  });

  test("sees through a disc folder to the real album", () => {
    const hit = index.find({
      artists: ["Parliament"],
      album: "Tear The Roof Off",
      title: "Give Up The Funk",
    });
    expect(hit?.tier).toBe("exact");
  });

  test("reads the artist out of the filename when the folder is a release", () => {
    // "Music/F.O.O.L - Destroyer of Speakers.flac" — no artist directory to go on.
    const hit = index.find({ artists: ["F.O.O.L"], album: "Rift", title: "Destroyer of Speakers" });
    expect(hit?.tier).toBe("album-agnostic");
  });

  test("returns undefined for a track that is genuinely absent", () => {
    expect(index.find({ artists: ["Aphex Twin"], album: "Drukqs", title: "Avril 14th" })).toBeUndefined();
  });

  test("an absent library directory yields an empty index rather than throwing", async () => {
    const empty = await LibraryIndex.build(join(root, "does-not-exist"));
    expect(empty.fileCount).toBe(0);
    expect(empty.find({ artists: ["Radiohead"], album: "OK Computer", title: "Karma Police" })).toBeUndefined();
  });
});

describe("sanitize", () => {
  test("keeps spaces and hyphens, so paths match what other taggers write", () => {
    expect(sanitize("Karma Police")).toBe("Karma Police");
    expect(sanitize("Jay-Z")).toBe("Jay-Z");
    expect(sanitize("Sgt. Pepper's Lonely Hearts Club Band")).toBe("Sgt. Pepper's Lonely Hearts Club Band");
  });

  test("strips only what a filesystem will reject", () => {
    expect(sanitize("AC/DC")).toBe("ACDC");
    expect(sanitize('Who? What: "Why"')).toBe("Who What Why");
  });

  test("refuses a trailing dot or space, which Windows will not store", () => {
    expect(sanitize("Interlude.")).toBe("Interlude");
    expect(sanitize("Untitled ")).toBe("Untitled");
  });

  test("falls back rather than returning an empty name", () => {
    expect(sanitize("///")).toBe("untitled");
    expect(sanitize("")).toBe("untitled");
  });

  test("a sanitized path still matches the library index", () => {
    // sanitize() and the index must agree, or every download would be redundant.
    const hit = index.find({ artists: [sanitize("Radiohead")], album: sanitize("OK Computer"), title: sanitize("Karma Police") });
    expect(hit?.tier).toBe("exact");
  });
});
