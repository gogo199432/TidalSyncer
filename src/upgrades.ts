import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "./logger.ts";
import { rank, type QualityTier } from "./quality.ts";

/**
 * A record of what an upgrade attempt actually got, per track.
 *
 * `mediaTags` in the export describe the *catalogue*, not what this account may stream. A
 * track TIDAL lists as HIRES_LOSSLESS comes back as plain 16-bit FLAC on a subscription
 * without the hi-res tier — not as an error, just as a smaller file. So `attainableTier`
 * says "hires", the file on disk probes as "lossless", and the upgrade check concludes there
 * is something better to fetch.
 *
 * Nothing about that changes between runs. Without a memory of the attempt, the same track
 * is re-fetched on *every* run, for ever, retiring a perfectly good file for a byte-identical
 * one each time — and now that downloads run on a schedule, unattended. This is that memory:
 * one line per track saying what a run aimed at and what it came back with.
 */

export type UpgradeAttempt = {
  /** The tier the run was aiming for. */
  attempted: QualityTier;
  /** The tier of the file that actually landed. */
  achieved: QualityTier;
  at: string;
};

type LedgerFile = {
  version: 1;
  attempts: Record<string, UpgradeAttempt>;
};

const EMPTY: LedgerFile = { version: 1, attempts: {} };

export class UpgradeLedger {
  private file: LedgerFile = structuredClone(EMPTY);

  private constructor(private readonly path: string) {}

  static async open(dataDir: string): Promise<UpgradeLedger> {
    const ledger = new UpgradeLedger(join(dataDir, "upgrades.json"));

    try {
      ledger.file = JSON.parse(await readFile(ledger.path, "utf8")) as LedgerFile;
      ledger.file.attempts ??= {};
    } catch (error) {
      // Absent is the normal first-run case. Anything else is worth a line, but never worth
      // failing the run over: the cost of starting fresh is one redundant download per track.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("Could not read the upgrade ledger, starting fresh", {
          path: ledger.path,
          error: String(error),
        });
      }
    }

    return ledger;
  }

  get size(): number {
    return Object.keys(this.file.attempts).length;
  }

  /**
   * True when a previous run already proved this is not worth trying again: it aimed at
   * least as high as this one is aiming, and what it got back was no better than the file
   * sitting on disk right now.
   *
   * Both halves matter. Aiming *higher* than last time is a genuinely different request, and
   * a file that has since been replaced by a better one — by another tool, or by hand —
   * deserves to be judged on what it is now rather than on what it was.
   */
  settled(trackId: string, target: QualityTier, existing: QualityTier): boolean {
    const previous = this.file.attempts[trackId];
    if (!previous) return false;
    return rank(previous.attempted) >= rank(target) && rank(previous.achieved) <= rank(existing);
  }

  /** Records an attempt and persists it. Writes are rare — only tracks actually fetched. */
  async record(trackId: string, attempted: QualityTier, achieved: QualityTier): Promise<void> {
    this.file.attempts[trackId] = { attempted, achieved, at: new Date().toISOString() };

    try {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.file, null, 2)}\n`, "utf8");
      await rename(temporary, this.path);
    } catch (error) {
      // The download itself succeeded; losing the note only costs a redundant re-check next
      // run. Failing the track over it would be the wrong trade.
      log.warn("Could not write the upgrade ledger", { path: this.path, error: String(error) });
    }
  }
}
