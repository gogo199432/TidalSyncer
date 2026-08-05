import { describe, expect, test } from "bun:test";
import { parseIsoDuration } from "./catalog.ts";

describe("parseIsoDuration", () => {
  test("converts the shapes TIDAL emits for a track", () => {
    expect(parseIsoDuration("PT4M44S")).toBe(284);
    expect(parseIsoDuration("PT46M17S")).toBe(2777);
    expect(parseIsoDuration("PT30S")).toBe(30);
    expect(parseIsoDuration("PT3M")).toBe(180);
  });

  test("handles the hour component that long mixes carry", () => {
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
  });

  test("rounds fractional seconds", () => {
    expect(parseIsoDuration("PT4M44.6S")).toBe(285);
  });

  test("returns undefined rather than a wrong number for anything unparseable", () => {
    expect(parseIsoDuration(undefined)).toBeUndefined();
    expect(parseIsoDuration("")).toBeUndefined();
    expect(parseIsoDuration("4:44")).toBeUndefined();
    // A date component would be a different unit entirely; refuse it instead of guessing.
    expect(parseIsoDuration("P1DT4M")).toBeUndefined();
  });
});
