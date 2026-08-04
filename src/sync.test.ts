import { describe, expect, test } from "bun:test";
import type { Config } from "./config.ts";
import type { ListenBrainzClient, PlaylistSummary } from "./listenbrainz.ts";
import { latestEditions } from "./sync.ts";

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

const SUMMARIES: PlaylistSummary[] = [
  { sourcePatch: "weekly-jams", mbid: "old", title: "old", lastModifiedAt: daysAgo(9) },
  { sourcePatch: "weekly-jams", mbid: "new", title: "new", lastModifiedAt: daysAgo(2) },
  { sourcePatch: "daily-jams", mbid: "daily", title: "daily", lastModifiedAt: daysAgo(1) },
  { sourcePatch: "top-discoveries-of-2019", mbid: "y19", title: "2019", lastModifiedAt: daysAgo(900) },
];

const fakeClient = {
  listCreatedFor: async () => SUMMARIES,
} as unknown as ListenBrainzClient;

function configWith(overrides: Partial<Config>): Config {
  return {
    listenBrainzUser: "listener",
    sourcePatchAllowlist: [],
    ...overrides,
  } as Config;
}

const RECOMMENDATIONS = ["weekly-jams", "weekly-exploration", "daily-jams"];

describe("latestEditions", () => {
  test("keeps only the newest edition of each family", async () => {
    const editions = await latestEditions(fakeClient, configWith({}));

    const weeklyJams = editions.filter((edition) => edition.sourcePatch === "weekly-jams");
    expect(weeklyJams).toHaveLength(1);
    expect(weeklyJams[0]?.mbid).toBe("new");
  });

  test("excludes year-in-review lists when scoped to the recommendation playlists", async () => {
    const editions = await latestEditions(
      fakeClient,
      configWith({ sourcePatchAllowlist: RECOMMENDATIONS }),
    );
    expect(editions.map((edition) => edition.sourcePatch)).toEqual(["daily-jams", "weekly-jams"]);
  });

  test("mirrors every family when the allowlist is empty", async () => {
    const editions = await latestEditions(fakeClient, configWith({}));
    expect(editions.map((edition) => edition.sourcePatch)).toEqual([
      "daily-jams",
      "top-discoveries-of-2019",
      "weekly-jams",
    ]);
  });

  test("honours a narrower allowlist", async () => {
    const editions = await latestEditions(
      fakeClient,
      configWith({ sourcePatchAllowlist: ["weekly-jams"] }),
    );
    expect(editions.map((edition) => edition.sourcePatch)).toEqual(["weekly-jams"]);
  });
});
