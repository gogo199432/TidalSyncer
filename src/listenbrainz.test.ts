import { afterEach, describe, expect, test } from "bun:test";
import { humanizeSourcePatch, ListenBrainzClient } from "./listenbrainz.ts";

const REAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

describe("humanizeSourcePatch", () => {
  test("turns source patches into playlist titles", () => {
    expect(humanizeSourcePatch("weekly-jams")).toBe("Weekly Jams");
    expect(humanizeSourcePatch("weekly-exploration")).toBe("Weekly Exploration");
    expect(humanizeSourcePatch("top_discoveries_of_2025")).toBe("Top Discoveries Of 2025");
  });
});

/**
 * Serves canned responses so parsing is covered without hitting the network. `afterEach`
 * puts the real `fetch` back — the client awaits its rate-limit gate before fetching, so
 * anything tied to the microtask queue would restore too early.
 */
function clientWith(responses: Record<string, unknown>, token = ""): ListenBrainzClient {
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    const body = responses[url.pathname];
    if (!body) return new Response("not found", { status: 404 });
    return Response.json(body);
  }) as typeof fetch;

  return new ListenBrainzClient("https://example.test", "test/1.0", token);
}

/** Variant for endpoints whose answer depends on the query string or the request body. */
function clientServing(
  handler: (url: URL, body: unknown) => unknown,
  token = "test-token",
): ListenBrainzClient {
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const parsed = init?.body ? JSON.parse(String(init.body)) : undefined;
    return Response.json(handler(new URL(String(input)), parsed));
  }) as typeof fetch;

  return new ListenBrainzClient("https://example.test", "test/1.0", token);
}

describe("ListenBrainzClient.fetchPlaylist", () => {
  test("extracts identity, tracks and recording MBIDs from JSPF", async () => {
    const client = clientWith({
      "/1/playlist/abc": {
        playlist: {
          identifier: "https://listenbrainz.org/playlist/abc",
          title: "Weekly Jams for listener",
          annotation: "<p>Songs you have <b>heard</b> before.</p>",
          extension: {
            "https://musicbrainz.org/doc/jspf#playlist": {
              last_modified_at: "2026-08-03T10:00:00+00:00",
              additional_metadata: { algorithm_metadata: { source_patch: "weekly-jams" } },
            },
          },
          track: [
            {
              title: "Heaven for the Sinner",
              creator: "Bonobo feat. Erykah Badu",
              album: "The North Borders",
              identifier: ["https://musicbrainz.org/recording/62c15559-e7f0-44b3-b38f-3684078fd407"],
            },
            // Missing a creator; must be dropped rather than matched blindly.
            { title: "Orphan", identifier: [] },
          ],
        },
      },
    });

    const playlist = await client.fetchPlaylist("abc");

    expect(playlist.sourcePatch).toBe("weekly-jams");
    expect(playlist.mbid).toBe("abc");
    expect(playlist.lastModifiedAt).toBe("2026-08-03T10:00:00+00:00");
    expect(playlist.description).toBe("Songs you have heard before.");
    expect(playlist.tracks).toHaveLength(1);
    expect(playlist.tracks[0]).toEqual({
      title: "Heaven for the Sinner",
      artist: "Bonobo feat. Erykah Badu",
      album: "The North Borders",
      recordingMbid: "62c15559-e7f0-44b3-b38f-3684078fd407",
    });
  });

  test("rejects a playlist with no source patch", async () => {
    const client = clientWith({
      "/1/playlist/abc": {
        playlist: { identifier: "https://listenbrainz.org/playlist/abc", track: [] },
      },
    });

    await expect(client.fetchPlaylist("abc")).rejects.toThrow(/source patch/);
  });
});

describe("ListenBrainzClient.fetchIsrcs", () => {
  test("maps recording MBIDs to ISRCs and omits recordings without one", async () => {
    const client = clientWith({
      "/1/metadata/recording/": {
        "mbid-1": { recording: { isrcs: ["GBCFB1300103"] } },
        "mbid-2": { recording: { isrcs: [] } },
        "mbid-3": { recording: {} },
      },
    });

    const isrcs = await client.fetchIsrcs(["mbid-1", "mbid-2", "mbid-3", "mbid-1"]);

    expect(isrcs.get("mbid-1")).toEqual(["GBCFB1300103"]);
    expect(isrcs.has("mbid-2")).toBe(false);
    expect(isrcs.has("mbid-3")).toBe(false);
  });
});

describe("ListenBrainzClient.lovedRecordingMbids", () => {
  test("pages until the reported total is covered", async () => {
    const page = (mbids: string[]) => ({
      count: mbids.length,
      offset: 0,
      total_count: 3,
      feedback: mbids.map((recording_mbid) => ({ recording_mbid, score: 1 })),
    });

    const client = clientServing((url) =>
      url.searchParams.get("offset") === "0" ? page(["mbid-a", "mbid-b"]) : page(["mbid-c"]),
    );

    expect(await client.lovedRecordingMbids("listener")).toEqual(
      new Set(["mbid-a", "mbid-b", "mbid-c"]),
    );
  });

  test("ignores feedback carrying no recording MBID", async () => {
    const client = clientServing(() => ({
      count: 2,
      offset: 0,
      total_count: 2,
      // An MSID-only love is real feedback, but we can only submit and compare MBIDs.
      feedback: [
        { recording_mbid: "mbid-a", score: 1 },
        { recording_mbid: null, recording_msid: "msid-b", score: 1 },
      ],
    }));

    expect(await client.lovedRecordingMbids("listener")).toEqual(new Set(["mbid-a"]));
  });

  test("stops rather than looping when a page comes back empty", async () => {
    const client = clientServing(() => ({ count: 0, offset: 0, total_count: 9, feedback: [] }));
    expect(await client.lovedRecordingMbids("listener")).toEqual(new Set());
  });
});

describe("ListenBrainzClient.lookupRecordings", () => {
  test("maps results back to the requested positions", async () => {
    const client = clientServing((_url, body) => {
      const recordings = (body as { recordings: Array<{ recording_name: string }> }).recordings;
      return recordings.map((recording, index) => ({
        index,
        recording_name: recording.recording_name,
        // The mapper reports no MBID for what it cannot place.
        ...(recording.recording_name === "Unknowable" ? {} : { recording_mbid: `mbid-${index}` }),
      }));
    });

    const resolved = await client.lookupRecordings([
      { artist: "Portishead", title: "Glory Box" },
      { artist: "Nobody", title: "Unknowable" },
      { artist: "Queen", title: "Bohemian Rhapsody" },
    ]);

    expect(resolved.get(0)).toBe("mbid-0");
    expect(resolved.has(1)).toBe(false);
    expect(resolved.get(2)).toBe("mbid-2");
  });

  test("drops over-long queries the server would reject, keeping the rest aligned", async () => {
    const seen: string[] = [];
    const client = clientServing((_url, body) => {
      const recordings = (body as { recordings: Array<{ recording_name: string }> }).recordings;
      for (const recording of recordings) seen.push(recording.recording_name);
      return recordings.map((_recording, index) => ({ index, recording_mbid: `mbid-${index}` }));
    });

    const resolved = await client.lookupRecordings([
      { artist: "A".repeat(200), title: "B".repeat(200) },
      { artist: "Queen", title: "Bohemian Rhapsody" },
    ]);

    expect(seen).toEqual(["Bohemian Rhapsody"]);
    // The survivor keeps its original index, not the position within the trimmed batch.
    expect(resolved.has(0)).toBe(false);
    expect(resolved.get(1)).toBe("mbid-0");
  });
});

describe("ListenBrainzClient.validateToken", () => {
  test("returns the account the token belongs to", async () => {
    const client = clientWith({ "/1/validate-token": { valid: true, user_name: "listener" } });
    expect(await client.validateToken()).toBe("listener");
  });

  test("rejects a token the server does not recognise", async () => {
    const client = clientWith({ "/1/validate-token": { code: 200, valid: false } });
    await expect(client.validateToken()).rejects.toThrow(/LISTENBRAINZ_TOKEN/);
  });
});
