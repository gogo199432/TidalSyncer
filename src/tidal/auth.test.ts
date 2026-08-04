import { describe, expect, test } from "bun:test";
import type { Config } from "../config.ts";
import { scopesFor } from "./auth.ts";

const configWith = (skipCollectionFor: string[], syncFavorites = false) =>
  ({ tidal: { skipCollectionFor }, syncFavorites }) as Config;

describe("scopesFor", () => {
  test("requests only the playlist scopes when nothing reads the collection", () => {
    expect(scopesFor(configWith([]))).toEqual(["playlists.read", "playlists.write"]);
  });

  test("adds collection.read only when filtering is enabled", () => {
    expect(scopesFor(configWith(["weekly-exploration"]))).toContain("collection.read");
    expect(scopesFor(configWith(["*"]))).toContain("collection.read");
  });

  test("adds collection.read for favourite syncing, which reads the collection too", () => {
    expect(scopesFor(configWith([], true))).toContain("collection.read");
  });
});
