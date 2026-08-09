import { describe, expect, test } from "bun:test";
import type { SlskdFile, SlskdResponse } from "./client.ts";
import { basenameOf, extensionOf, pick, plausible, score, searchText } from "./match.ts";

/**
 * This is the code that decides whether to put a stranger's file into the user's library, so
 * the tests are mostly about what it *refuses*. A wrong track that lands silently is worse
 * than an empty result, because the empty result is visible and the wrong file is not.
 */

const TRACK = { artist: "Portishead", title: "Glory Box", duration: 301 };

const file = (filename: string, extra: Partial<SlskdFile> = {}): SlskdFile => ({
  filename,
  size: 40 * 1024 * 1024,
  ...extra,
});

const from = (username: string, files: SlskdFile[], extra: Partial<SlskdResponse> = {}): SlskdResponse => ({
  username,
  files,
  ...extra,
});

describe("what a candidate has to look like", () => {
  test("accepts the ordinary shapes a share puts a track in", () => {
    for (const name of [
      "@@abc\\Portishead\\Dummy\\05 Glory Box.flac",
      "music\\Portishead - Glory Box.mp3",
      "P\\Portishead\\Dummy (1994)\\Glory Box.flac",
    ]) {
      expect(plausible(file(name), TRACK)).toBe(true);
    }
  });

  test("rejects anything that is not audio, whatever else it says", () => {
    for (const name of [
      "Portishead\\Dummy\\Glory Box.zip",
      "Portishead\\Dummy\\Glory Box.cue",
      "Portishead\\Dummy\\Glory Box.jpg",
      "Portishead\\Dummy\\Glory Box",
    ]) {
      expect(plausible(file(name), TRACK)).toBe(false);
    }
  });

  test("rejects a file too small to be the track, or far too large to be one track", () => {
    const name = "Portishead\\Dummy\\Glory Box.flac";
    expect(plausible(file(name, { size: 40_000 }), TRACK)).toBe(false);
    // An album rip, a DJ set or a video that happens to be named after the track.
    expect(plausible(file(name, { size: 800 * 1024 * 1024 }), TRACK)).toBe(false);
  });

  test("needs the title in the filename, not merely somewhere in the path", () => {
    // The directory is right and the file is not the one that was asked for.
    expect(plausible(file("Portishead\\Glory Box\\Sour Times.flac"), TRACK)).toBe(false);
  });

  test("needs the artist somewhere in the path, but tolerates it not being in the name", () => {
    expect(plausible(file("Portishead\\Dummy\\05 Glory Box.flac"), TRACK)).toBe(true);
    expect(plausible(file("Various\\Chillout Vol 3\\Glory Box.flac"), TRACK)).toBe(false);
  });

  test("ignores punctuation and accents on both sides", () => {
    const track = { artist: "Sigur Rós", title: "Hoppípolla" };
    expect(plausible(file("Sigur Ros\\Takk\\Hoppipolla.flac"), track)).toBe(true);
  });

  test("rejects a recording whose reported length disagrees", () => {
    // A live take or an extended mix filed under the same name.
    expect(plausible(file("Portishead\\Glory Box.flac", { length: 480 }), TRACK)).toBe(false);
    expect(plausible(file("Portishead\\Glory Box.flac", { length: 299 }), TRACK)).toBe(true);
  });

  test("does not hold a missing length against a peer that reports nothing", () => {
    // Most real results carry no attributes at all; requiring them would reject the peers who
    // simply share files without tagging them.
    expect(plausible(file("Portishead\\Glory Box.flac"), TRACK)).toBe(true);
  });
});

describe("ranking what survives", () => {
  const plain = from("peer", []);

  test("prefers lossless to lossy, whatever else is on offer", () => {
    const flac = score(file("Portishead\\Glory Box.flac"), plain, TRACK);
    const mp3 = score(file("Portishead\\Glory Box.mp3", { bitRate: 320 }), plain, TRACK);
    expect(flac).toBeGreaterThan(mp3);
  });

  test("prefers a peer that can start now to one behind a queue", () => {
    const name = "Portishead\\Glory Box.flac";
    const free = score(file(name), from("a", [], { hasFreeUploadSlot: true }), TRACK);
    const queued = score(file(name), from("b", [], { queueLength: 60 }), TRACK);
    expect(free).toBeGreaterThan(queued);
  });

  test("does not let a queue outweigh the format", () => {
    // A queued FLAC still beats an immediately available mp3 — waiting is recoverable, and
    // the run will simply pick it up next time.
    const flac = score(file("Portishead\\Glory Box.flac"), from("a", [], { queueLength: 200 }), TRACK);
    const mp3 = score(
      file("Portishead\\Glory Box.mp3", { bitRate: 320 }),
      from("b", [], { hasFreeUploadSlot: true, uploadSpeed: 5_000_000 }),
      TRACK,
    );
    expect(flac).toBeGreaterThan(mp3);
  });
});

describe("refusing lossy outright", () => {
  test("is off by default — for a track TIDAL will not serve, something beats nothing", () => {
    expect(plausible(file("Portishead\\Glory Box.mp3"), TRACK)).toBe(true);
  });

  test("drops every lossy candidate when asked, rather than ranking them last", () => {
    const responses = [from("peer", [file("Portishead\\Glory Box.mp3", { bitRate: 320 })])];
    expect(pick(responses, TRACK)?.username).toBe("peer");
    expect(pick(responses, TRACK, true)).toBeUndefined();
  });
});

describe("pick", () => {
  test("takes the best file across every peer that answered", () => {
    const chosen = pick(
      [
        from("slow", [file("Portishead\\Glory Box.mp3", { bitRate: 192 })]),
        from("good", [file("Portishead\\Dummy\\Glory Box.flac")], { hasFreeUploadSlot: true }),
        from("noise", [file("Portishead\\Dummy\\Sour Times.flac")]),
      ],
      TRACK,
    );

    expect(chosen?.username).toBe("good");
    expect(chosen?.file.filename).toContain("Glory Box.flac");
    expect(chosen?.reason).toContain("flac");
  });

  test("returns nothing rather than the closest thing it saw", () => {
    const chosen = pick(
      [from("peer", [file("Massive Attack\\Mezzanine\\Teardrop.flac"), file("Portishead\\Dummy\\Roads.flac")])],
      TRACK,
    );
    expect(chosen).toBeUndefined();
  });

  test("survives a peer that reports a file with no size", () => {
    const broken = { filename: "Portishead\\Glory Box.flac" } as SlskdFile;
    expect(pick([from("peer", [broken])], TRACK)).toBeUndefined();
  });
});

describe("the search that is sent", () => {
  test("drops bracketed suffixes and punctuation peers do not have", () => {
    expect(searchText({ artist: "Portishead", title: "Glory Box (Remastered 2011)" })).toBe(
      "portishead glory box",
    );
  });

  test("keeps it plain rather than precise — a search is not a filter", () => {
    expect(searchText({ artist: "Sigur Rós", title: "Hoppípolla" })).toBe("sigur ros hoppipolla");
  });
});

describe("path helpers", () => {
  test("read the extension from the name when the peer does not report one", () => {
    expect(extensionOf(file("a\\b\\c.FLAC"))).toBe("flac");
    expect(extensionOf(file("a\\b\\c.flac", { extension: ".MP3" }))).toBe("mp3");
    expect(basenameOf(file("a\\b\\Glory Box.flac"))).toBe("Glory Box.flac");
  });
});
