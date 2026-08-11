import { describe, expect, test } from "bun:test";
import { toEnrichment } from "./enrich.ts";
import type { RecordingMetadata } from "./listenbrainz.ts";

/**
 * Turning a ListenBrainz response into tags.
 *
 * The interesting part is which tags count as a genre. ListenBrainz returns everything the
 * community applied to a recording, which for a well-loved album means "trip hop" sitting
 * beside "melancholic", "nocturnal" and "sunday morning" — and a library whose genre browser
 * is full of moods is worse than one with no genres at all.
 */

const MBID = "64e2d046-ccb4-41ef-b2f9-3bc38a7010e7";

const genre = (tag: string, count: number) => ({ tag, count, genre_mbid: `mbid-for-${tag}` });
const mood = (tag: string, count: number) => ({ tag, count });

describe("toEnrichment", () => {
  test("keeps genres and drops moods", () => {
    const metadata: RecordingMetadata = {
      tag: {
        recording: [mood("melancholic", 40), genre("trip hop", 3), mood("nocturnal", 20)],
      },
    };

    // "melancholic" outnumbers "trip hop" ten to one and is still not a genre.
    expect(toEnrichment(MBID, metadata).genres).toEqual(["trip hop"]);
  });

  test("orders by how many people applied the tag", () => {
    const metadata: RecordingMetadata = {
      tag: { recording: [genre("electronic", 3), genre("trip hop", 14), genre("downtempo", 7)] },
    };

    expect(toEnrichment(MBID, metadata).genres).toEqual(["trip hop", "downtempo", "electronic"]);
  });

  test("prefers the recording's genres over the release group's and the artist's", () => {
    const metadata: RecordingMetadata = {
      tag: {
        recording: [genre("acid jazz", 1)],
        release_group: [genre("trip hop", 20)],
        artist: [genre("electronic", 99)],
      },
    };

    // Narrowest first: what this recording is beats what the band generally is, however
    // many more people voted on the band.
    expect(toEnrichment(MBID, metadata).genres).toEqual(["acid jazz", "trip hop", "electronic"]);
  });

  test("falls back to the artist when nothing narrower is tagged", () => {
    const metadata: RecordingMetadata = {
      tag: { recording: [], release_group: [], artist: [genre("downtempo", 7)] },
    };

    expect(toEnrichment(MBID, metadata).genres).toEqual(["downtempo"]);
  });

  test("does not list the same genre twice when two levels agree", () => {
    const metadata: RecordingMetadata = {
      // Casing differs between levels, which is not two genres.
      tag: { recording: [genre("Trip Hop", 2)], release_group: [genre("trip hop", 20)] },
    };

    expect(toEnrichment(MBID, metadata).genres).toEqual(["Trip Hop"]);
  });

  test("leaves genres out entirely when there are none", () => {
    expect(toEnrichment(MBID, { tag: { recording: [mood("chill", 5)] } }).genres).toBeUndefined();
  });

  test("carries the identifiers a file needs to say what it is", () => {
    const metadata: RecordingMetadata = {
      artist: { artists: [{ artist_mbid: "artist-1" }, { artist_mbid: "artist-2" }] },
      release: {
        mbid: "release-1",
        release_group_mbid: "group-1",
        year: 1994,
        caa_id: 829521842,
        caa_release_mbid: "release-with-art",
      },
    };

    expect(toEnrichment(MBID, metadata)).toEqual({
      recordingMbid: MBID,
      artistMbids: ["artist-1", "artist-2"],
      releaseMbid: "release-1",
      releaseGroupMbid: "group-1",
      year: 1994,
      cover: { releaseMbid: "release-with-art", id: 829521842 },
    });
  });

  test("wants both halves of a cover art reference or neither", () => {
    // An id with no release to hang it off cannot be turned into a URL.
    expect(toEnrichment(MBID, { release: { caa_id: 12345 } }).cover).toBeUndefined();
    expect(toEnrichment(MBID, { release: { caa_release_mbid: "release-1" } }).cover).toBeUndefined();
  });

  test("an empty response still yields the recording it was asked about", () => {
    expect(toEnrichment(MBID, {})).toEqual({ recordingMbid: MBID });
  });
});
