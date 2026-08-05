import type { Config } from "../config.ts";
import { log } from "../logger.ts";
import { chunked, describe, nextCursor, TidalError, type TidalApi } from "./client.ts";

/**
 * Everything about a track worth keeping outside TIDAL. This is deliberately more than
 * `CollectionTrack` carries: the sync path only ever needs an ISRC to match on, whereas an
 * export has to survive the track being delisted, so it records what the track *was*.
 */
export type TrackDetail = {
  tidalId: string;
  title: string;
  /** Every credited artist, in TIDAL's order. The first is the one MusicBrainz indexes. */
  artists: string[];
  album?: string;
  albumId?: string;
  /** ISO 3166 date, present on most album releases. */
  releaseDate?: string;
  isrc?: string;
  /** Seconds. TIDAL reports an ISO 8601 duration ("PT4M44S"), which is awkward to sort on. */
  duration?: number;
  explicit?: boolean;
  copyright?: string;
  /** LOSSLESS / HIRES_LOSSLESS / DOLBY_ATMOS — what quality is on offer for this track. */
  mediaTags?: string[];
};

/** A playlist as it stood at export time, with its contents inlined. */
export type PlaylistDetail = {
  tidalId: string;
  name: string;
  description?: string;
  /** Ordered TIDAL track ids. Resolve against the export's `tracks` map. */
  trackIds: string[];
};

/** TIDAL returns at most this many tracks per `filter[id]` request. */
const TRACK_LOOKUP_BATCH_SIZE = 20;

/**
 * ISO 8601 durations, restricted to what TIDAL emits for a track: hours/minutes/seconds,
 * no date part. Anything unparseable yields undefined rather than a wrong number.
 */
export function parseIsoDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  if (!match) return undefined;
  const [, hours, minutes, seconds] = match;
  const total = Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
  return Number.isFinite(total) ? Math.round(total) : undefined;
}

/**
 * Resolves full metadata for tracks by id, in batches.
 *
 * `include=artists&include=albums` makes each response carry the related resources inline,
 * so a batch of 20 tracks costs one request rather than 41. Tracks that cannot be read are
 * absent from the result — a delisted track in an old playlist should not fail the export.
 */
export async function fetchTrackDetails(
  api: TidalApi,
  config: Config,
  trackIds: string[],
): Promise<Map<string, TrackDetail>> {
  const details = new Map<string, TrackDetail>();

  for (const batch of chunked([...new Set(trackIds)], TRACK_LOOKUP_BATCH_SIZE)) {
    const { data, error } = await api.GET("/tracks", {
      params: {
        query: {
          countryCode: config.tidal.countryCode,
          "filter[id]": batch,
          include: ["artists", "albums"],
        },
      },
    });

    if (error) {
      log.warn("Track metadata lookup failed for a batch", { count: batch.length, error: describe(error) });
      continue;
    }

    const artistNames = new Map<string, string>();
    const albums = new Map<string, { title?: string; releaseDate?: string }>();
    for (const entry of data?.included ?? []) {
      if (entry.type === "artists") {
        const resource = entry as { id: string; attributes?: { name?: string } };
        if (resource.attributes?.name) artistNames.set(resource.id, resource.attributes.name);
      } else if (entry.type === "albums") {
        const resource = entry as { id: string; attributes?: { title?: string; releaseDate?: string } };
        albums.set(resource.id, {
          title: resource.attributes?.title,
          releaseDate: resource.attributes?.releaseDate,
        });
      }
    }

    for (const track of data?.data ?? []) {
      const attributes = track.attributes;
      if (!attributes?.title) continue;

      const albumId = track.relationships?.albums?.data?.[0]?.id;
      const album = albumId ? albums.get(albumId) : undefined;
      const artists = (track.relationships?.artists?.data ?? [])
        .map((reference) => artistNames.get(reference.id))
        .filter((name): name is string => Boolean(name));

      details.set(track.id, {
        tidalId: track.id,
        title: attributes.version ? `${attributes.title} (${attributes.version})` : attributes.title,
        artists,
        album: album?.title,
        albumId,
        releaseDate: album?.releaseDate,
        isrc: attributes.isrc,
        duration: parseIsoDuration(attributes.duration),
        explicit: attributes.explicit,
        copyright: attributes.copyright?.text,
        mediaTags: attributes.mediaTags,
      });
    }
  }

  return details;
}

/**
 * Every playlist the authenticated user owns, contents included.
 *
 * Deliberately owner-filtered: a user's collection can also hold playlists *created by
 * TIDAL* (editorial mixes), and those are neither the user's curation nor stable enough to
 * be worth exporting.
 */
export async function fetchOwnedPlaylists(api: TidalApi, config: Config): Promise<PlaylistDetail[]> {
  const playlists: PlaylistDetail[] = [];
  let cursor: string | undefined;

  do {
    const { data, error } = await api.GET("/playlists", {
      params: {
        query: {
          countryCode: config.tidal.countryCode,
          "filter[owners.id]": ["me"],
          ...(cursor ? { "page[cursor]": cursor } : {}),
        },
      },
    });

    if (error) throw new TidalError(`Listing playlists failed: ${describe(error)}`);

    for (const playlist of data?.data ?? []) {
      playlists.push({
        tidalId: playlist.id,
        name: playlist.attributes?.name ?? `untitled-${playlist.id}`,
        description: playlist.attributes?.description,
        trackIds: [],
      });
    }

    cursor = nextCursor(data?.links?.next);
  } while (cursor);

  for (const playlist of playlists) {
    playlist.trackIds = await fetchPlaylistTrackIds(api, config, playlist.tidalId);
    log.debug("Read playlist", { name: playlist.name, tracks: playlist.trackIds.length });
  }

  return playlists;
}

/**
 * Ordered track ids for one playlist.
 *
 * `TidalPlaylists.listItems` skips entries with no `itemId` because it exists to *remove*
 * them; an export only reads, so it keeps every entry.
 */
async function fetchPlaylistTrackIds(api: TidalApi, config: Config, playlistId: string): Promise<string[]> {
  const trackIds: string[] = [];
  let cursor: string | undefined;

  do {
    const { data, error } = await api.GET("/playlists/{id}/relationships/items", {
      params: {
        path: { id: playlistId },
        query: {
          countryCode: config.tidal.countryCode,
          ...(cursor ? { "page[cursor]": cursor } : {}),
        },
      },
    });

    if (error) throw new TidalError(`Reading playlist ${playlistId} failed: ${describe(error)}`);

    for (const entry of data?.data ?? []) {
      if (entry.type === "tracks") trackIds.push(entry.id);
    }

    cursor = nextCursor(data?.links?.next);
  } while (cursor);

  return trackIds;
}
