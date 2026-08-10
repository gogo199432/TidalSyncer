import { afterEach, describe, expect, test } from "bun:test";
import { chooseRelease, MusicBrainzClient, type MbRelease } from "./musicbrainz.ts";

const REAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

/** Serves one canned search response and records the queries it was asked. */
function clientServing(body: unknown, queries: string[] = []): MusicBrainzClient {
  globalThis.fetch = (async (input: string | URL) => {
    queries.push(new URL(String(input)).searchParams.get("query") ?? "");
    return Response.json(body);
  }) as typeof fetch;

  return new MusicBrainzClient("https://mb.test", "test/1.0");
}

describe("MusicBrainzClient.recordingMbidsByIsrc", () => {
  test("maps each ISRC to the recording that claims it", async () => {
    const queries: string[] = [];
    const client = clientServing(
      {
        count: 2,
        recordings: [
          { id: "rec-1", title: "Cut to the Feeling", score: 100, isrcs: ["USUM71703861"] },
          // Recordings routinely carry several ISRCs; only the queried one should match.
          { id: "rec-2", title: "Bohemian Rhapsody", score: 93, isrcs: ["GBCEE0100112", "GBUM71029604"] },
        ],
      },
      queries,
    );

    const resolved = await client.recordingMbidsByIsrc(["USUM71703861", "GBUM71029604"]);

    expect(resolved.get("USUM71703861")).toBe("rec-1");
    expect(resolved.get("GBUM71029604")).toBe("rec-2");
    // An ISRC the recording happens to carry but we never asked about stays out.
    expect(resolved.has("GBCEE0100112")).toBe(false);
    expect(queries).toEqual(["isrc:USUM71703861 OR isrc:GBUM71029604"]);
  });

  test("keeps the best-scoring recording when several claim one ISRC", async () => {
    const client = clientServing({
      recordings: [
        { id: "best", score: 100, isrcs: ["USUM71703861"] },
        { id: "worse", score: 60, isrcs: ["USUM71703861"] },
      ],
    });

    const resolved = await client.recordingMbidsByIsrc(["USUM71703861"]);
    expect(resolved.get("USUM71703861")).toBe("best");
  });

  test("omits ISRCs MusicBrainz does not know, and asks once per duplicate", async () => {
    const queries: string[] = [];
    const client = clientServing({ count: 0, recordings: [] }, queries);

    const resolved = await client.recordingMbidsByIsrc(["AAAA00000000", "AAAA00000000"]);

    expect(resolved.size).toBe(0);
    expect(queries).toEqual(["isrc:AAAA00000000"]);
  });

  test("a failing batch is skipped rather than failing the whole collection", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;
    const client = new MusicBrainzClient("https://mb.test", "test/1.0");

    expect((await client.recordingMbidsByIsrc(["AAAA00000000"])).size).toBe(0);
  });
});

/**
 * A popular recording is on a dozen releases: the original album, its reissues, and a
 * scattering of compilations. Taking the first would file a track under whichever DJ mix
 * MusicBrainz happened to list first.
 */
describe("chooseRelease", () => {
  const album = (title: string, extra: Partial<MbRelease> = {}): MbRelease => ({
    title,
    status: "Official",
    "release-group": { "primary-type": "Album" },
    ...extra,
  });

  test("lets the reissues vote for the album they are reissues of", () => {
    // The shape of the real answer for "Infected Mushroom — Becoming Insane": four pressings
    // of Vicious Delicious against one compilation appearance.
    expect(
      chooseRelease([
        album("Vicious Delicious", { date: "2025-11-27" }),
        album("Vicious Delicious", { date: "2007-04-30" }),
        album("Psy Hi Volume 1 - BNE Hits", { date: "2007-11" }),
        album("Vicious Delicious", { date: "2007-04-01" }),
        album("Vicious Delicious", { date: "2011" }),
      ]),
    ).toBe("Vicious Delicious");
  });

  test("drops compilations before counting, where MusicBrainz labels them", () => {
    expect(
      chooseRelease([
        album("Now That's What I Call Music", { "release-group": { "primary-type": "Album", "secondary-types": ["Compilation"] } }),
        album("Now That's What I Call Music", { "release-group": { "primary-type": "Album", "secondary-types": ["Compilation"] } }),
        album("Dummy", { date: "1994" }),
      ]),
    ).toBe("Dummy");
  });

  test("prefers the earliest pressing when nothing else separates them", () => {
    expect(chooseRelease([album("Later", { date: "2001" }), album("Earlier", { date: "1994" })])).toBe("Earlier");
  });

  test("ignores unofficial releases unless they are all there is", () => {
    expect(
      chooseRelease([
        album("Bootleg", { status: "Bootleg" }),
        album("Bootleg", { status: "Bootleg" }),
        album("The Real Album", { date: "1999" }),
      ]),
    ).toBe("The Real Album");
    expect(chooseRelease([album("Bootleg", { status: "Bootleg" })])).toBe("Bootleg");
  });

  test("says nothing rather than guessing when there are no releases", () => {
    // The caller then files under "Unknown Album", which is at least honest.
    expect(chooseRelease([])).toBeUndefined();
    expect(chooseRelease([{ status: "Official" }])).toBeUndefined();
  });
});
