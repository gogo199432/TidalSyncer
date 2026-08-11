import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUntagged, metadataArgs, readTags, runFfmpeg, tagsFor, writeTags } from "./tags.ts";

const TRACK = {
  tidalId: "1234",
  title: "4ÆM",
  artists: ["Grimes", "Barbara Dane"],
  album: "Miss Anthropocene",
  releaseDate: "2020-02-21",
  isrc: "USQX91902123",
  duration: 271,
};

describe("metadataArgs", () => {
  test("files a track under its first credit, and keeps the full one alongside", () => {
    const args = metadataArgs(tagsFor(TRACK));

    // The artist a server groups by has to be the one the folder is named after, or every
    // collaboration grows a second artist.
    expect(args).toContain("artist=Grimes");
    expect(args).toContain("album_artist=Grimes");
    expect(args).toContain("artists=Grimes; Barbara Dane");
  });

  test("carries title, album, date and ISRC", () => {
    const args = metadataArgs(tagsFor(TRACK));

    expect(args).toContain("title=4ÆM");
    expect(args).toContain("album=Miss Anthropocene");
    expect(args).toContain("date=2020-02-21");
    expect(args).toContain("ISRC=USQX91902123");
  });

  test("omits what is not known rather than writing an empty tag", () => {
    const args = metadataArgs({ title: "Untitled", artists: [] });

    expect(args).toEqual(["-metadata", "title=Untitled"]);
  });

  test("writes no `artists` when there is only one credit", () => {
    const args = metadataArgs({ title: "Karma Police", artists: ["Radiohead"] });

    expect(args.join(" ")).not.toContain("artists=");
    expect(args).toContain("artist=Radiohead");
  });

  test("writes the strongest genre and the MusicBrainz identifiers", () => {
    const args = metadataArgs(
      tagsFor({
        ...TRACK,
        enrichment: {
          recordingMbid: "recording-1",
          artistMbids: ["artist-1", "artist-2"],
          releaseMbid: "release-1",
          releaseGroupMbid: "group-1",
          genres: ["art pop", "electronic", "industrial"],
          year: 2020,
        },
      }),
    );

    expect(args).toContain("genre=art pop");
    // Both spellings of the recording id: MUSICBRAINZ_TRACKID has meant this in file tags
    // since long before MUSICBRAINZ_RECORDINGID existed.
    expect(args).toContain("MUSICBRAINZ_TRACKID=recording-1");
    expect(args).toContain("MUSICBRAINZ_RECORDINGID=recording-1");
    expect(args).toContain("MUSICBRAINZ_ARTISTID=artist-1");
    expect(args).toContain("MUSICBRAINZ_ALBUMID=release-1");
    expect(args).toContain("MUSICBRAINZ_RELEASEGROUPID=group-1");
  });

  test("prefers TIDAL's release date over MusicBrainz's year", () => {
    // TIDAL knows which release it sold you; the recording's earliest year is a different
    // question, and only worth answering when TIDAL declined to.
    const dated = tagsFor({ ...TRACK, enrichment: { recordingMbid: "r", year: 1988 } });
    expect(dated.releaseDate).toBe("2020-02-21");

    const undated = tagsFor({ ...TRACK, releaseDate: undefined, enrichment: { recordingMbid: "r", year: 1988 } });
    expect(undated.releaseDate).toBe("1988");
  });
});

describe("isUntagged", () => {
  test("a file with neither title nor artist", () => {
    expect(isUntagged({ tags: {}, hasArtwork: false })).toBe(true);
  });

  test("container brands are not metadata", () => {
    // Exactly what a demuxed TIDAL track carries, and the state the backfill exists to fix.
    expect(isUntagged({ tags: {}, hasArtwork: false })).toBe(true);
  });

  test("half-filled tags belong to whatever wrote them", () => {
    expect(isUntagged({ tags: { artist: "Grimes" }, hasArtwork: false })).toBe(false);
    expect(isUntagged({ tags: { title: "4ÆM" }, hasArtwork: false })).toBe(false);
  });
});

// The round trip needs a real encoder. Everything above is pure and runs regardless.
const ffmpeg = Bun.which("ffmpeg") && Bun.which("ffprobe");

describe.if(Boolean(ffmpeg))("reading and writing tags", () => {
  let directory: string;
  let path: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "tags-"));
    path = join(directory, "4ÆM.flac");
    // A second of silence, and — like a demuxed TIDAL track — not one word about the music.
    await runFfmpeg(["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-f", "flac", path]);
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("a freshly encoded file reads as untagged", async () => {
    const before = await readTags(path);

    expect(before).toBeDefined();
    expect(isUntagged(before!)).toBe(true);
  });

  test("what is written comes back", async () => {
    await writeTags(path, tagsFor(TRACK));
    const after = await readTags(path);

    expect(after).toBeDefined();
    expect(isUntagged(after!)).toBe(false);
    expect(after!.tags.title).toBe("4ÆM");
    expect(after!.tags.artist).toBe("Grimes");
    expect(after!.tags.album).toBe("Miss Anthropocene");
    expect(after!.tags.date).toBe("2020-02-21");
  });

  test("a file that is not audio reads as unreadable, not as untagged", async () => {
    const impostor = join(directory, "Not Music.flac");
    await Bun.write(impostor, "this is not a flac file");

    // ffprobe will guess a codec from the extension and exit 0. Treating that as "untagged"
    // would have the backfill rewrite text files.
    expect(await readTags(impostor)).toBeUndefined();
  });

  test("an unknown extension is refused rather than guessed at", async () => {
    const odd = join(directory, "Track.weird");
    await Bun.write(odd, "x");

    expect(writeTags(odd, tagsFor(TRACK))).rejects.toThrow(/No ffmpeg output format/);
  });
});
