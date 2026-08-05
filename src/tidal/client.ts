import { createAPIClient } from "@tidal-music/api";
import type { Config } from "../config.ts";
import { log } from "../logger.ts";
import { credentialsProvider } from "./auth.ts";

export type TidalApi = ReturnType<typeof createAPIClient>;

/** One entry in a TIDAL playlist. `itemId` is the per-entry handle needed to remove it. */
export type PlaylistItem = {
  trackId: string;
  itemId: string;
};

export class TidalError extends Error {}

export function createClient(): TidalApi {
  return createAPIClient(credentialsProvider);
}

/**
 * TIDAL rejects oversized mutation payloads; batching keeps requests well inside limits
 * and gives partial progress if one batch fails.
 */
const ITEM_BATCH_SIZE = 20;

export class TidalPlaylists {
  constructor(
    private readonly api: TidalApi,
    private readonly config: Config,
  ) {}

  private get countryCode(): string {
    return this.config.tidal.countryCode;
  }

  /** Finds a playlist owned by the authenticated user with an exact name match. */
  async findOwnedByName(name: string): Promise<string | undefined> {
    let cursor: string | undefined;

    do {
      const { data, error } = await this.api.GET("/playlists", {
        params: {
          query: {
            countryCode: this.countryCode,
            "filter[owners.id]": ["me"],
            ...(cursor ? { "page[cursor]": cursor } : {}),
          },
        },
      });

      if (error) throw new TidalError(`Listing playlists failed: ${describe(error)}`);

      const match = data?.data?.find((playlist) => playlist.attributes?.name === name);
      if (match) return match.id;

      cursor = nextCursor(data?.links?.next);
    } while (cursor);

    return undefined;
  }

  async create(name: string, description: string): Promise<string> {
    const { data, error } = await this.api.POST("/playlists", {
      params: { query: { countryCode: this.countryCode } },
      body: {
        data: {
          type: "playlists",
          attributes: {
            name,
            description: description.slice(0, 500),
            accessType: this.config.tidal.playlistAccess,
          },
        },
      },
    });

    if (error || !data?.data?.id) {
      throw new TidalError(`Creating playlist "${name}" failed: ${describe(error)}`);
    }

    return data.data.id;
  }

  /** Keeps the mirrored playlist's name/description in step with ListenBrainz. */
  async updateMetadata(playlistId: string, name: string, description: string): Promise<void> {
    const { error } = await this.api.PATCH("/playlists/{id}", {
      params: { path: { id: playlistId }, query: { countryCode: this.countryCode } },
      body: {
        data: {
          id: playlistId,
          type: "playlists",
          attributes: {
            name,
            description: description.slice(0, 500),
            accessType: this.config.tidal.playlistAccess,
          },
        },
      },
    });

    // Non-fatal: a stale title is much less important than correct contents.
    if (error) log.warn("Could not update playlist metadata", { playlistId, error: describe(error) });
  }

  async listItems(playlistId: string): Promise<PlaylistItem[]> {
    const items: PlaylistItem[] = [];
    let cursor: string | undefined;

    do {
      const { data, error } = await this.api.GET("/playlists/{id}/relationships/items", {
        params: {
          path: { id: playlistId },
          query: {
            countryCode: this.countryCode,
            ...(cursor ? { "page[cursor]": cursor } : {}),
          },
        },
      });

      if (error) throw new TidalError(`Reading playlist ${playlistId} failed: ${describe(error)}`);

      for (const entry of data?.data ?? []) {
        // Entries without an itemId cannot be removed individually, so skip them.
        if (entry.meta?.itemId) items.push({ trackId: entry.id, itemId: entry.meta.itemId });
      }

      cursor = nextCursor(data?.links?.next);
    } while (cursor);

    return items;
  }

  async removeItems(playlistId: string, items: PlaylistItem[]): Promise<void> {
    for (const batch of chunked(items, ITEM_BATCH_SIZE)) {
      const { error } = await this.api.DELETE("/playlists/{id}/relationships/items", {
        params: { path: { id: playlistId } },
        body: {
          data: batch.map((item) => ({
            id: item.trackId,
            type: "tracks" as const,
            meta: { itemId: item.itemId },
          })),
        },
      });

      if (error) throw new TidalError(`Removing items from ${playlistId} failed: ${describe(error)}`);
    }
  }

  /** Appends tracks in order. TIDAL adds to the end, so sequential batches preserve order. */
  async addItems(playlistId: string, trackIds: string[]): Promise<void> {
    for (const batch of chunked(trackIds, ITEM_BATCH_SIZE)) {
      const { error } = await this.api.POST("/playlists/{id}/relationships/items", {
        params: { path: { id: playlistId }, query: { countryCode: this.countryCode } },
        body: {
          data: batch.map((trackId) => ({ id: trackId, type: "tracks" as const })),
        },
      });

      if (error) throw new TidalError(`Adding items to ${playlistId} failed: ${describe(error)}`);
    }
  }
}

/** A favourited track, with the identifiers needed to find it on MusicBrainz. */
export type CollectionTrack = {
  trackId: string;
  /** Present for almost every catalogue track; the primary key for matching. */
  isrc?: string;
  title?: string;
  /** When the user favourited it. Only used for reporting. */
  addedAt?: string;
};

/**
 * Reads every track in the authenticated user's TIDAL collection ("My Collection" →
 * Tracks). Used both for filtering playlists against music they already keep, and as the
 * source for mirroring favourites back to ListenBrainz.
 *
 * Note this is the *collection*, not listening history: streaming a track through TIDAL
 * does not add it here, only explicitly favouriting it does. An account that never
 * favourites anything will legitimately return an empty list.
 *
 * `include: items` makes the response carry the full track objects rather than bare ids,
 * so ISRCs come back in the same requests instead of costing a second pass.
 */
export async function fetchCollectionTracks(api: TidalApi): Promise<CollectionTrack[]> {
  const tracks: CollectionTrack[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  do {
    const { data, error } = await api.GET("/userCollectionTracks/{id}/relationships/items", {
      params: {
        path: { id: "me" },
        query: {
          locale: "en-US",
          include: ["items"],
          ...(cursor ? { "page[cursor]": cursor } : {}),
        },
      },
    });

    if (error) throw new TidalError(`Reading TIDAL collection failed: ${describe(error)}`);

    const attributes = new Map<string, { isrc?: string; title?: string }>();
    for (const entry of data?.included ?? []) {
      if (entry.type !== "tracks") continue;
      const resource = entry as { id: string; attributes?: { isrc?: string; title?: string } };
      attributes.set(resource.id, {
        isrc: resource.attributes?.isrc,
        title: resource.attributes?.title,
      });
    }

    for (const entry of data?.data ?? []) {
      if (entry.type !== "tracks" || seen.has(entry.id)) continue;
      seen.add(entry.id);
      tracks.push({
        trackId: entry.id,
        addedAt: entry.meta?.addedAt,
        ...attributes.get(entry.id),
      });
    }

    cursor = nextCursor(data?.links?.next);
  } while (cursor);

  return tracks;
}

/** The id-only view of the collection, for filtering playlists. */
export async function fetchCollectionTrackIds(api: TidalApi): Promise<Set<string>> {
  const tracks = await fetchCollectionTracks(api);
  return new Set(tracks.map((track) => track.trackId));
}

/** TIDAL returns at most this many tracks per `filter[id]` request. */
const TRACK_LOOKUP_BATCH_SIZE = 20;

/**
 * Resolves "artist — title" for tracks by id, for the name-based fallback when a track
 * has no ISRC or MusicBrainz does not know it. Tracks that cannot be read are simply
 * absent from the result.
 */
export async function fetchTrackDescriptors(
  api: TidalApi,
  config: Config,
  trackIds: string[],
): Promise<Map<string, { artist: string; title: string }>> {
  const descriptors = new Map<string, { artist: string; title: string }>();

  for (const batch of chunked(trackIds, TRACK_LOOKUP_BATCH_SIZE)) {
    const { data, error } = await api.GET("/tracks", {
      params: {
        query: {
          countryCode: config.tidal.countryCode,
          "filter[id]": batch,
          include: ["artists"],
        },
      },
    });

    if (error) {
      log.debug("Track descriptor lookup failed", { error: describe(error) });
      continue;
    }

    const artistNames = new Map<string, string>();
    for (const entry of data?.included ?? []) {
      if (entry.type !== "artists") continue;
      const resource = entry as { id: string; attributes?: { name?: string } };
      if (resource.attributes?.name) artistNames.set(resource.id, resource.attributes.name);
    }

    for (const track of data?.data ?? []) {
      const title = track.attributes?.title;
      // The first credited artist is the one MusicBrainz indexes the recording under.
      const artistId = track.relationships?.artists?.data?.[0]?.id;
      const artist = artistId ? artistNames.get(artistId) : undefined;
      if (title && artist) descriptors.set(track.id, { artist, title });
    }
  }

  return descriptors;
}

/** The API returns a relative URL for the next page; we only need the cursor from it. */
export function nextCursor(next: string | undefined): string | undefined {
  if (!next) return undefined;
  const query = next.slice(next.indexOf("?") + 1);
  return new URLSearchParams(query).get("page[cursor]") ?? undefined;
}

export function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function describe(error: unknown): string {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;

  const errors = (error as { errors?: Array<{ detail?: string; title?: string }> }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.map((entry) => entry.detail ?? entry.title ?? "?").join("; ");
  }

  return JSON.stringify(error).slice(0, 300);
}
