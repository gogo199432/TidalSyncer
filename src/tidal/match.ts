import type { Config } from "../config.ts";
import type { SourceTrack } from "../listenbrainz.ts";
import { log } from "../logger.ts";
import type { SyncStore } from "../store.ts";
import { describe, type TidalApi } from "./client.ts";

export type MatchResult = {
  /** TIDAL track ids, in ListenBrainz order, for everything we could resolve. */
  trackIds: string[];
  unmatched: SourceTrack[];
  matchedByIsrc: number;
  matchedBySearch: number;
};

/**
 * `filter[isrc]` returns one track per ISRC when given several, so a whole playlist
 * resolves in a couple of round trips.
 */
const ISRC_BATCH_SIZE = 20;

export class TrackMatcher {
  constructor(
    private readonly api: TidalApi,
    private readonly config: Config,
    private readonly store: SyncStore,
  ) {}

  /**
   * Resolves ListenBrainz tracks to TIDAL track ids in two tiers: an exact ISRC lookup
   * first, then a text search for whatever is left. Both tiers are cached persistently
   * (including confirmed misses) so repeat syncs of overlapping playlists are nearly free.
   */
  async resolve(tracks: SourceTrack[], isrcsByMbid: Map<string, string[]>): Promise<MatchResult> {
    const resolved = new Array<string | undefined>(tracks.length);
    let matchedByIsrc = 0;
    let matchedBySearch = 0;

    // Tier 1: ISRC. Collect every candidate ISRC that is not already cached.
    const isrcsForTrack = tracks.map((track) =>
      track.recordingMbid ? (isrcsByMbid.get(track.recordingMbid) ?? []) : [],
    );

    const pending = new Set<string>();
    for (const isrcs of isrcsForTrack) {
      for (const isrc of isrcs) {
        if (this.store.getCachedTrackByIsrc(isrc) === undefined) pending.add(isrc);
      }
    }

    if (pending.size > 0) await this.lookupIsrcs([...pending]);

    for (const [index, isrcs] of isrcsForTrack.entries()) {
      for (const isrc of isrcs) {
        const trackId = this.store.getCachedTrackByIsrc(isrc);
        if (trackId) {
          resolved[index] = trackId;
          matchedByIsrc += 1;
          break;
        }
      }
    }

    // Tier 2: text search for anything the ISRC pass could not place.
    for (const [index, track] of tracks.entries()) {
      if (resolved[index]) continue;

      const key = searchKey(track);
      let trackId = this.store.getCachedTrackBySearch(key);

      if (trackId === undefined) {
        trackId = await this.searchTrack(track);
        this.store.setCachedTrackBySearch(key, trackId);
      }

      if (trackId) {
        resolved[index] = trackId;
        matchedBySearch += 1;
      }
    }

    const trackIds: string[] = [];
    const unmatched: SourceTrack[] = [];
    const seen = new Set<string>();

    for (const [index, track] of tracks.entries()) {
      const trackId = resolved[index];
      if (!trackId) {
        unmatched.push(track);
        continue;
      }
      // A playlist may legitimately repeat a track, but duplicates from fuzzy matching
      // are far more likely, so keep the first occurrence only.
      if (seen.has(trackId)) continue;
      seen.add(trackId);
      trackIds.push(trackId);
    }

    return { trackIds, unmatched, matchedByIsrc, matchedBySearch };
  }

  private async lookupIsrcs(isrcs: string[]): Promise<void> {
    for (let index = 0; index < isrcs.length; index += ISRC_BATCH_SIZE) {
      const batch = isrcs.slice(index, index + ISRC_BATCH_SIZE);

      const { data, error } = await this.api.GET("/tracks", {
        params: {
          query: { countryCode: this.config.tidal.countryCode, "filter[isrc]": batch },
        },
      });

      if (error) {
        log.warn("ISRC lookup failed, falling back to search for this batch", {
          error: describe(error),
        });
        continue;
      }

      const found = new Map<string, string>();
      for (const track of data?.data ?? []) {
        const isrc = track.attributes?.isrc;
        if (isrc && !found.has(isrc)) found.set(isrc, track.id);
      }

      for (const isrc of batch) {
        // Caching the miss as null stops us re-querying a genuinely absent ISRC forever.
        this.store.setCachedTrackByIsrc(isrc, found.get(isrc) ?? null);
      }
    }
  }

  /**
   * Fallback matcher. TIDAL's search endpoint takes the query as the resource id. We only
   * accept a hit whose title still looks right — a wrong track in the playlist is worse
   * than a missing one — and we take the best-ranked such hit.
   */
  private async searchTrack(track: SourceTrack): Promise<string | null> {
    const query = `${track.artist} ${track.title}`;

    const { data, error } = await this.api.GET("/searchResults/{id}/relationships/tracks", {
      params: {
        path: { id: query },
        query: { countryCode: this.config.tidal.countryCode, include: ["tracks"] },
      },
    });

    if (error) {
      log.debug("Search failed", { query, error: describe(error) });
      return null;
    }

    // `data` is the ranked list of identifiers; `included` carries the full objects when
    // the API honours `include`. Keep the ranking and look up whatever titles are missing.
    const ranked = (data?.data ?? []).slice(0, SEARCH_CANDIDATE_LIMIT).map((entry) => entry.id);
    if (ranked.length === 0) return null;

    const titles = new Map<string, string>();
    for (const entry of data?.included ?? []) {
      if (entry.type !== "tracks") continue;
      const title = (entry as { attributes?: { title?: string } }).attributes?.title;
      if (title) titles.set(entry.id, title);
    }

    const missing = ranked.filter((id) => !titles.has(id));
    if (missing.length > 0) {
      for (const [id, title] of await this.fetchTitles(missing)) titles.set(id, title);
    }

    for (const id of ranked) {
      const title = titles.get(id);
      if (title && isTitleMatch(title, track.title)) return id;
    }

    log.debug("No confident match", { artist: track.artist, title: track.title });
    return null;
  }

  /** Resolves track titles by id, for when the search response omits `included`. */
  private async fetchTitles(trackIds: string[]): Promise<Map<string, string>> {
    const titles = new Map<string, string>();

    const { data, error } = await this.api.GET("/tracks", {
      params: {
        query: { countryCode: this.config.tidal.countryCode, "filter[id]": trackIds },
      },
    });

    if (error) {
      log.debug("Track title lookup failed", { error: describe(error) });
      return titles;
    }

    for (const entry of data?.data ?? []) {
      if (entry.attributes?.title) titles.set(entry.id, entry.attributes.title);
    }

    return titles;
  }
}

/** Only the top handful of search hits are plausible; beyond that a match is noise. */
const SEARCH_CANDIDATE_LIMIT = 10;

/**
 * Accepts a candidate whose title matches once casing, accents and punctuation are folded,
 * and again once bracketed suffixes like "(Remastered 2011)" are dropped — the two
 * differences that routinely separate a MusicBrainz title from its TIDAL equivalent.
 */
export function isTitleMatch(candidateTitle: string, wantedTitle: string): boolean {
  const candidate = normalize(candidateTitle);
  const wanted = normalize(wantedTitle);

  if (!candidate || !wanted) return false;
  if (candidate === wanted) return true;

  const strippedCandidate = stripParentheticals(candidate);
  const strippedWanted = stripParentheticals(wanted);
  return strippedCandidate === strippedWanted && strippedWanted.length > 0;
}

export function stripParentheticals(value: string): string {
  return value
    .replace(/\s*[([][^)\]]*[)\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Folds away the differences that routinely separate MusicBrainz titles from TIDAL ones:
 * case, accents (NFKD then drop combining marks), and punctuation such as the various
 * apostrophes and dashes. Brackets survive so `stripParentheticals` can still act on them.
 */
export function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s()[\]]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cache key for a name-based lookup, stable across the casing/punctuation differences. */
export function searchKey(track: { artist: string; title: string }): string {
  return `${normalize(track.artist)} ${normalize(track.title)}`;
}
