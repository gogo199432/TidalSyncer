import { log } from "./logger.ts";

export class MusicBrainzError extends Error {}

/**
 * MusicBrainz asks for at most one request per second per client. One shared gate keeps
 * every call site inside that budget without anyone having to remember to sleep.
 */
const MIN_REQUEST_INTERVAL_MS = 1100;

/**
 * ISRCs per search request. `/ws/2/isrc/{isrc}` resolves one at a time, which would take
 * minutes for a real collection; a search for `isrc:A OR isrc:B ...` resolves a whole
 * batch in one request and still reports each recording's ISRCs, so results map back
 * unambiguously. 20 leaves plenty of headroom under the 100-result page.
 */
const ISRC_BATCH_SIZE = 20;

const SEARCH_LIMIT = 100;

/** Transient failures are worth one retry; the rate gate already spaces requests out. */
const MAX_ATTEMPTS = 3;

type SearchResponse = {
  count?: number;
  recordings?: Array<{
    id?: string;
    title?: string;
    score?: number;
    isrcs?: string[];
  }>;
};

export class MusicBrainzClient {
  private nextRequestAt = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly userAgent: string,
  ) {}

  /**
   * Resolves ISRCs to MusicBrainz recording MBIDs — the reverse of the playlist direction,
   * where ListenBrainz hands us MBIDs and we look up ISRCs to find TIDAL tracks.
   *
   * ISRCs absent from the returned map have no recording in MusicBrainz. An ISRC can name
   * several recordings (the same track on different releases); the best-scoring hit wins,
   * which is what ListenBrainz itself would have matched a listen to.
   */
  async recordingMbidsByIsrc(isrcs: string[]): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();
    const unique = [...new Set(isrcs.filter(Boolean))];

    for (const batch of chunked(unique, ISRC_BATCH_SIZE)) {
      const wanted = new Set(batch);
      const query = batch.map((isrc) => `isrc:${isrc}`).join(" OR ");

      const url = new URL("/ws/2/recording", this.baseUrl);
      url.searchParams.set("query", query);
      url.searchParams.set("limit", String(SEARCH_LIMIT));
      url.searchParams.set("fmt", "json");

      let body: SearchResponse;
      try {
        body = await this.get<SearchResponse>(url);
      } catch (error) {
        // One bad batch should not abandon the rest of the collection.
        log.warn("MusicBrainz ISRC lookup failed for a batch", {
          isrcs: batch.length,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      // Results arrive best-match first, so the first recording claiming an ISRC wins.
      for (const recording of body.recordings ?? []) {
        if (!recording.id) continue;
        for (const isrc of recording.isrcs ?? []) {
          if (wanted.has(isrc) && !resolved.has(isrc)) resolved.set(isrc, recording.id);
        }
      }
    }

    return resolved;
  }

  private async get<T>(url: URL): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      await this.waitForSlot();

      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": this.userAgent },
      });

      if (response.ok) return (await response.json()) as T;

      // 503 is how MusicBrainz says "slow down"; 5xx is worth retrying too.
      const retryable = response.status === 503 || response.status >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        const detail = await response.text().catch(() => "");
        throw new MusicBrainzError(
          `MusicBrainz ${response.status} for ${url.pathname}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        );
      }

      const backoffMs = MIN_REQUEST_INTERVAL_MS * 2 ** attempt;
      log.debug("MusicBrainz asked us to back off", { status: response.status, backoffMs });
      this.nextRequestAt = Date.now() + backoffMs;
    }
  }

  private async waitForSlot(): Promise<void> {
    const waitMs = this.nextRequestAt - Date.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
  }
}

/** Exposed for callers that want to report progress in the same units we request in. */
export function isrcBatchCount(isrcs: number): number {
  return Math.ceil(isrcs / ISRC_BATCH_SIZE);
}

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
