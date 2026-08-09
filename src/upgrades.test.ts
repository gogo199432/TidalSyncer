import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpgradeLedger } from "./upgrades.ts";

/**
 * The ledger exists for one reason: TIDAL's `mediaTags` describe the catalogue, not the
 * subscription. A track listed as HIRES_LOSSLESS that this account can only stream as 16-bit
 * FLAC looks upgradable for ever, because nothing about it ever changes. These tests pin the
 * rule that stops that being an every-run re-download.
 */

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "upgrades-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("settled", () => {
  test("says nothing about a track it has never seen", async () => {
    const ledger = await UpgradeLedger.open(dataDir);
    expect(ledger.settled("1", "hires", "lossless")).toBe(false);
  });

  test("closes the loop: aimed at hi-res, got 16-bit, will not try again", async () => {
    const ledger = await UpgradeLedger.open(dataDir);
    await ledger.record("1", "hires", "lossless");

    expect(ledger.settled("1", "hires", "lossless")).toBe(true);
  });

  test("survives a restart, which is the whole point of writing it down", async () => {
    const first = await UpgradeLedger.open(dataDir);
    await first.record("1", "hires", "lossless");

    const second = await UpgradeLedger.open(dataDir);
    expect(second.settled("1", "hires", "lossless")).toBe(true);
    expect(second.size).toBe(1);
  });

  test("still tries when this run aims higher than the one that was disappointed", async () => {
    const ledger = await UpgradeLedger.open(dataDir);
    // A `lossless` run got lossless, as it should have. That says nothing about hi-res.
    await ledger.record("1", "lossless", "lossless");

    expect(ledger.settled("1", "hires", "lossless")).toBe(false);
  });

  test("still tries when the file on disk got worse than the one that was judged", async () => {
    const ledger = await UpgradeLedger.open(dataDir);
    await ledger.record("1", "hires", "lossless");

    // Whatever is there now is an mp3 — replaced by hand, or by another tool. The earlier
    // "no better than lossless" verdict does not cover it.
    expect(ledger.settled("1", "hires", "lossy")).toBe(false);
  });

  test("is satisfied when the aim was met and the file on disk is that good", async () => {
    const ledger = await UpgradeLedger.open(dataDir);
    await ledger.record("1", "hires", "hires");

    // Belt and braces — `considerUpgrade` compares tiers itself and never gets this far.
    expect(ledger.settled("1", "hires", "hires")).toBe(true);
  });

  test("a later attempt replaces the earlier verdict rather than stacking on it", async () => {
    const ledger = await UpgradeLedger.open(dataDir);
    await ledger.record("1", "lossless", "lossless");
    await ledger.record("1", "hires", "hires");

    expect(ledger.size).toBe(1);
    expect(ledger.settled("1", "hires", "lossless")).toBe(false);
  });
});

describe("the file itself", () => {
  test("starts fresh on a corrupt ledger rather than failing the run", async () => {
    await writeFile(join(dataDir, "upgrades.json"), "{ not json");

    const ledger = await UpgradeLedger.open(dataDir);
    expect(ledger.size).toBe(0);
    expect(ledger.settled("1", "hires", "lossless")).toBe(false);
  });

  test("is readable JSON, so a wrong verdict can be deleted by hand", async () => {
    const ledger = await UpgradeLedger.open(dataDir);
    await ledger.record("14832", "hires", "lossless");

    const written = JSON.parse(await readFile(join(dataDir, "upgrades.json"), "utf8"));
    expect(written.version).toBe(1);
    expect(written.attempts["14832"]).toMatchObject({ attempted: "hires", achieved: "lossless" });
    expect(Date.parse(written.attempts["14832"].at)).toBeGreaterThan(0);
  });
});
