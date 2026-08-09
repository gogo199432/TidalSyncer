import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "../logger.ts";

/**
 * Transfers slskd is still working on when a run ends.
 *
 * Soulseek is a queue, and the queue is other people's spare bandwidth: a popular file behind
 * forty other requests can take hours. A download run cannot wait that long, and cancelling
 * would mean never getting the slow ones — which, for a track TIDAL will not serve at all,
 * usually means never getting it.
 *
 * So a transfer that outlasts its budget is simply left running, noted here, and filed into
 * the library by whichever later run finds it finished. That makes the fallback fit the way
 * the rest of this tool already works: each scheduled run picks up where the last one got to.
 */

export type PendingTransfer = {
  /** The peer serving it. Needed to ask slskd how the transfer is going. */
  username: string;
  /** The peer's own path, which is what slskd knows the transfer by. */
  remoteFilename: string;
  /** Library-relative directory the file was told to land in. */
  destination: string;
  /** Library-relative path it should end up at, extension still to be decided. */
  target: string;
  queuedAt: string;
};

type LedgerFile = {
  version: 1;
  transfers: Record<string, PendingTransfer>;
};

const EMPTY: LedgerFile = { version: 1, transfers: {} };

export class PendingTransfers {
  private file: LedgerFile = structuredClone(EMPTY);

  private constructor(private readonly path: string) {}

  static async open(dataDir: string): Promise<PendingTransfers> {
    const pending = new PendingTransfers(join(dataDir, "slskd-pending.json"));

    try {
      pending.file = JSON.parse(await readFile(pending.path, "utf8")) as LedgerFile;
      pending.file.transfers ??= {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn("Could not read the pending slskd transfers, starting fresh", {
          path: pending.path,
          error: String(error),
        });
      }
    }

    return pending;
  }

  get size(): number {
    return Object.keys(this.file.transfers).length;
  }

  entries(): Array<[string, PendingTransfer]> {
    return Object.entries(this.file.transfers);
  }

  has(trackId: string): boolean {
    return trackId in this.file.transfers;
  }

  async add(trackId: string, transfer: PendingTransfer): Promise<void> {
    this.file.transfers[trackId] = transfer;
    await this.save();
  }

  async remove(trackId: string): Promise<void> {
    if (!(trackId in this.file.transfers)) return;
    delete this.file.transfers[trackId];
    await this.save();
  }

  private async save(): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.file, null, 2)}\n`, "utf8");
      await rename(temporary, this.path);
    } catch (error) {
      // Losing the note costs a re-search next run, not the file — slskd keeps transferring
      // either way. Not worth failing a run over.
      log.warn("Could not write the pending slskd transfers", { path: this.path, error: String(error) });
    }
  }
}
