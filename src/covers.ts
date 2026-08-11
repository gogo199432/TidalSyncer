import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Enrichment } from "./enrich.ts";
import { log } from "./logger.ts";

/**
 * Cover art, fetched once per release and embedded into every track on it.
 *
 * The Cover Art Archive needs no lookup: ListenBrainz already reported the release's image id
 * alongside everything else, so the URL is known before anything is asked for. What this adds
 * is the caching, which is the part that matters — an album's twelve tracks share one cover,
 * and a collection re-downloading the same JPEG a dozen times would be both slow and rude.
 *
 * Cached on disk rather than in memory, so `repair` tagging a whole library and the nightly
 * download of four new tracks draw on the same images.
 */

/**
 * Thumbnail size. The archive serves 250, 500, 1200 and the original, which can be several
 * megabytes of scan — embedded into every track of a collection, that adds up to a library
 * nobody asked for. 500 is what fills an album tile on a phone.
 */
const SIZE = 500;

/** A file smaller than this is an error page, not a JPEG. */
const MIN_IMAGE_BYTES = 1024;

const TIMEOUT_MS = 20_000;

export class CoverStore {
  /** Release MBID -> local path, or null once it is known there is no getting one. */
  private readonly known = new Map<string, string | null>();

  constructor(private readonly directory: string) {}

  /**
   * The local path of this track's cover, fetching it if this is the first track to ask.
   *
   * Never throws and never retries within a run: cover art is the most optional thing here,
   * and a release whose image 404s should cost one request, not one per track on it.
   */
  async pathFor(enrichment: Enrichment | undefined): Promise<string | undefined> {
    return await this.pathForCover(enrichment?.cover);
  }

  /** The same, for a caller holding only the image reference — the Soulseek ledger does. */
  async pathForCover(cover: Enrichment["cover"]): Promise<string | undefined> {
    if (!cover) return undefined;

    const cached = this.known.get(cover.releaseMbid);
    if (cached !== undefined) return cached ?? undefined;

    const path = join(this.directory, `${cover.releaseMbid}-${cover.id}-${SIZE}.jpg`);

    // From an earlier run. Size-checked rather than trusted, so a fetch interrupted by a
    // kill cannot leave a truncated image to be embedded into a hundred files.
    if (await isUsable(path)) {
      this.known.set(cover.releaseMbid, path);
      return path;
    }

    const fetched = await this.fetch(cover.releaseMbid, cover.id, path);
    this.known.set(cover.releaseMbid, fetched ?? null);
    return fetched;
  }

  private async fetch(releaseMbid: string, id: number, path: string): Promise<string | undefined> {
    const url = `https://coverartarchive.org/release/${releaseMbid}/${id}-${SIZE}.jpg`;
    // Written aside and renamed, for the same reason every other write here is: a partial
    // file under the final name is one that gets embedded into a track.
    const temporary = `${path}.${process.pid}.part`;

    try {
      await mkdir(this.directory, { recursive: true });

      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) {
        log.debug("No cover art for a release", { releaseMbid, status: response.status });
        return undefined;
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength < MIN_IMAGE_BYTES) {
        log.debug("Cover art came back too small to be an image", { releaseMbid, bytes: bytes.byteLength });
        return undefined;
      }

      await Bun.write(temporary, bytes);
      await rename(temporary, path);
      log.debug("Fetched cover art", { releaseMbid, kilobytes: Math.round(bytes.byteLength / 1024) });
      return path;
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      log.debug("Could not fetch cover art", { releaseMbid, error: String(error) });
      return undefined;
    }
  }
}

async function isUsable(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size >= MIN_IMAGE_BYTES;
  } catch {
    return false;
  }
}
