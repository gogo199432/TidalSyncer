import { describe, expect, test } from "bun:test";
import { isTitleMatch } from "./match.ts";

describe("isTitleMatch", () => {
  test("matches identical titles", () => {
    expect(isTitleMatch("Heaven for the Sinner", "Heaven for the Sinner")).toBe(true);
  });

  test("ignores case, accents and punctuation differences", () => {
    expect(isTitleMatch("DON'T STOP", "Don’t Stop")).toBe(true);
    expect(isTitleMatch("Bjork - Joga", "Björk - Jóga")).toBe(true);
    expect(isTitleMatch("Ne me quitte pas", "Ne me quitte pas")).toBe(true);
  });

  test("ignores bracketed suffixes on either side", () => {
    expect(isTitleMatch("Karma Police (Remastered 2011)", "Karma Police")).toBe(true);
    expect(isTitleMatch("Blue Monday", "Blue Monday [2016 Remaster]")).toBe(true);
  });

  test("rejects genuinely different tracks", () => {
    expect(isTitleMatch("Karma Police", "Paranoid Android")).toBe(false);
    expect(isTitleMatch("Heaven", "Heaven for the Sinner")).toBe(false);
  });

  test("rejects when stripping brackets would leave nothing to compare", () => {
    // Two different tracks whose titles are entirely parenthetical must not collapse
    // into a match on the empty string.
    expect(isTitleMatch("(Interlude)", "(Reprise)")).toBe(false);
  });

  test("rejects empty titles", () => {
    expect(isTitleMatch("", "Karma Police")).toBe(false);
    expect(isTitleMatch("Karma Police", "")).toBe(false);
  });
});
