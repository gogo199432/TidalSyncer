import type { Config } from "./config.ts";
import {
  humanizeSourcePatch,
  ListenBrainzClient,
  type PlaylistSummary,
  type SourcePlaylist,
} from "./listenbrainz.ts";
import { log } from "./logger.ts";
import type { SyncStore } from "./store.ts";
import { createClient, fetchCollectionTrackIds, TidalError, TidalPlaylists } from "./tidal/client.ts";
import { TrackMatcher } from "./tidal/match.ts";

export type PlaylistOutcome = {
  sourcePatch: string;
  status: "synced" | "unchanged" | "skipped" | "failed";
  tidalPlaylistId?: string;
  trackCount?: number;
  unmatched?: string[];
  /** Tracks dropped because they are already in the user's TIDAL collection. */
  inCollection?: number;
  error?: string;
};

export type SyncReport = {
  outcomes: PlaylistOutcome[];
  startedAt: string;
  durationMs: number;
};

export type SyncOptions = {
  /** Re-mirror even when ListenBrainz has not published a new edition. */
  force?: boolean;
};

export async function runSync(
  config: Config,
  store: SyncStore,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const startedAt = new Date();
  const startedAtMs = Date.now();

  const listenBrainz = new ListenBrainzClient(
    config.listenBrainzApiUrl,
    `listenbrainz-tidal-sync/1.0.0 ( ${config.contactEmail} )`,
  );
  const api = createClient();
  const playlists = new TidalPlaylists(api, config);
  const matcher = new TrackMatcher(api, config, store);

  const editions = await latestEditions(listenBrainz, config);
  log.info("Found ListenBrainz playlists", {
    count: editions.length,
    patches: editions.map((edition) => edition.sourcePatch).join(","),
  });

  const collection = lazyCollection(api);
  const outcomes: PlaylistOutcome[] = [];

  for (const edition of editions) {
    try {
      outcomes.push(
        await syncOne({
          config,
          store,
          listenBrainz,
          playlists,
          matcher,
          edition,
          options,
          collection,
        }),
      );
    } catch (error) {
      log.error("Playlist sync failed", {
        sourcePatch: edition.sourcePatch,
        error: error instanceof Error ? error.message : String(error),
      });
      outcomes.push({
        sourcePatch: edition.sourcePatch,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // One write at the end rather than per lookup.
  await store.flushCache();

  return { outcomes, startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAtMs };
}

/**
 * ListenBrainz publishes each refresh as a brand-new playlist, so a user accumulates many
 * editions of `weekly-jams`. We mirror only the newest edition of each family.
 */
/** Resolves the user's collection on first use, then reuses it for the rest of the run. */
export type CollectionLoader = () => Promise<Set<string>>;

/**
 * A large collection takes seconds to page through, so defer that cost until a playlist
 * genuinely needs mirroring. On a tick where every edition is unchanged — the common case
 * on a 6-hourly schedule — the collection is never fetched at all.
 */
function lazyCollection(api: ReturnType<typeof createClient>): CollectionLoader {
  let pending: Promise<Set<string>> | undefined;

  return () => {
    pending ??= (async () => {
      const collection = await fetchCollectionTrackIds(api);
      log.info("Loaded TIDAL collection", { tracks: collection.size });

      if (collection.size === 0) {
        // Streaming a track does not add it to the collection — only favouriting does — so
        // an empty result is plausible. Say so loudly, since it otherwise looks like a
        // silent no-op (and is also what a missing collection.read scope looks like).
        log.warn(
          "TIDAL collection is empty, so nothing will be filtered. Note that listening to a " +
            "track does not add it to your collection; only saving/favouriting it does.",
        );
      }

      return collection;
    })();

    return pending;
  };
}

/** True when this playlist family should have collection tracks removed. */
function filtersAgainstCollection(config: Config, sourcePatch: string): boolean {
  const filtered = new Set(config.tidal.skipCollectionFor);
  return filtered.has("*") || filtered.has(sourcePatch);
}

export async function latestEditions(
  client: ListenBrainzClient,
  config: Config,
): Promise<PlaylistSummary[]> {
  const summaries = await client.listCreatedFor(config.listenBrainzUser);
  const allowlist = new Set(config.sourcePatchAllowlist);
  const newest = new Map<string, PlaylistSummary>();

  for (const summary of summaries) {
    if (allowlist.size > 0 && !allowlist.has(summary.sourcePatch)) continue;

    const current = newest.get(summary.sourcePatch);
    if (!current || summary.lastModifiedAt > current.lastModifiedAt) {
      newest.set(summary.sourcePatch, summary);
    }
  }

  for (const wanted of allowlist) {
    if (!newest.has(wanted)) {
      log.warn("Configured playlist not published by ListenBrainz", { sourcePatch: wanted });
    }
  }

  return [...newest.values()].sort((a, b) => a.sourcePatch.localeCompare(b.sourcePatch));
}

async function syncOne(context: {
  config: Config;
  store: SyncStore;
  listenBrainz: ListenBrainzClient;
  playlists: TidalPlaylists;
  matcher: TrackMatcher;
  edition: PlaylistSummary;
  options: SyncOptions;
  collection: CollectionLoader;
}): Promise<PlaylistOutcome> {
  const { config, store, listenBrainz, playlists, matcher, edition, options, collection } = context;
  const { sourcePatch } = edition;
  const previous = store.getPlaylist(sourcePatch);

  const unchanged =
    previous?.lastSourceMbid === edition.mbid && previous?.lastModifiedAt === edition.lastModifiedAt;

  if (unchanged && !options.force) {
    log.info("No new edition, skipping", { sourcePatch, mbid: edition.mbid });
    return {
      sourcePatch,
      status: "unchanged",
      tidalPlaylistId: previous.tidalPlaylistId,
      trackCount: previous.trackCount,
    };
  }

  const playlist = await listenBrainz.fetchPlaylist(edition.mbid);
  log.info("Mirroring edition", {
    sourcePatch,
    mbid: edition.mbid,
    tracks: playlist.tracks.length,
  });

  const recordingMbids = playlist.tracks.flatMap((track) =>
    track.recordingMbid ? [track.recordingMbid] : [],
  );
  const isrcs = await listenBrainz.fetchIsrcs(recordingMbids);

  const match = await matcher.resolve(playlist.tracks, isrcs);
  log.info("Matched tracks", {
    sourcePatch,
    matched: match.trackIds.length,
    total: playlist.tracks.length,
    byIsrc: match.matchedByIsrc,
    bySearch: match.matchedBySearch,
  });

  for (const track of match.unmatched) {
    log.warn("No TIDAL match", { sourcePatch, artist: track.artist, title: track.title });
  }

  if (match.trackIds.length === 0) {
    throw new Error(
      `Resolved 0 of ${playlist.tracks.length} tracks on TIDAL; refusing to empty the playlist`,
    );
  }

  let trackIds = match.trackIds;
  let inCollection = 0;

  if (filtersAgainstCollection(config, sourcePatch)) {
    const owned = await collection();
    const kept = trackIds.filter((trackId) => !owned.has(trackId));
    inCollection = trackIds.length - kept.length;
    trackIds = kept;

    log.info("Filtered against TIDAL collection", {
      sourcePatch,
      removed: inCollection,
      remaining: trackIds.length,
    });

    // Owning the whole playlist is a normal outcome here, not a failure — but writing an
    // empty playlist would destroy last week's contents for no reason.
    if (trackIds.length === 0) {
      log.warn("Every track is already in your collection; leaving the playlist untouched", {
        sourcePatch,
      });
      return {
        sourcePatch,
        status: "skipped",
        tidalPlaylistId: previous?.tidalPlaylistId,
        trackCount: 0,
        inCollection,
      };
    }
  }

  const name = playlistName(config, sourcePatch);
  const description = buildDescription(playlist);

  if (config.dryRun) {
    log.info("[dry run] Would write playlist", { sourcePatch, name, tracks: trackIds.length });
    return {
      sourcePatch,
      status: "synced",
      trackCount: trackIds.length,
      unmatched: match.unmatched.map(describeTrack),
      inCollection,
    };
  }

  const playlistId = await resolveTidalPlaylist(playlists, previous?.tidalPlaylistId, name, description);

  const existing = await playlists.listItems(playlistId);
  const identical =
    existing.length === trackIds.length &&
    existing.every((item, index) => item.trackId === trackIds[index]);

  if (identical) {
    log.info("TIDAL playlist already matches, only refreshing metadata", { sourcePatch });
  } else {
    // Replace wholesale: clear then append, so the TIDAL order mirrors ListenBrainz exactly.
    if (existing.length > 0) await playlists.removeItems(playlistId, existing);
    await playlists.addItems(playlistId, trackIds);
    log.info("Wrote TIDAL playlist", {
      sourcePatch,
      playlistId,
      removed: existing.length,
      added: trackIds.length,
    });
  }

  await playlists.updateMetadata(playlistId, name, description);

  await store.savePlaylist(sourcePatch, {
    tidalPlaylistId: playlistId,
    lastSourceMbid: edition.mbid,
    lastModifiedAt: edition.lastModifiedAt,
    lastSyncedAt: new Date().toISOString(),
    trackCount: trackIds.length,
    unmatchedCount: match.unmatched.length,
  });

  return {
    sourcePatch,
    status: "synced",
    tidalPlaylistId: playlistId,
    trackCount: trackIds.length,
    unmatched: match.unmatched.map(describeTrack),
    inCollection,
  };
}

/**
 * Reuses the playlist recorded in state, falling back to a name lookup (so an existing
 * playlist is adopted rather than duplicated) and finally creating a new one. Also
 * recovers if the remembered playlist was deleted in the TIDAL app.
 */
async function resolveTidalPlaylist(
  playlists: TidalPlaylists,
  knownId: string | undefined,
  name: string,
  description: string,
): Promise<string> {
  if (knownId) {
    try {
      await playlists.listItems(knownId);
      return knownId;
    } catch (error) {
      if (!(error instanceof TidalError)) throw error;
      log.warn("Stored TIDAL playlist is unreachable, will re-resolve", {
        playlistId: knownId,
        error: error.message,
      });
    }
  }

  const existingId = await playlists.findOwnedByName(name);
  if (existingId) {
    log.info("Adopted existing TIDAL playlist", { name, playlistId: existingId });
    return existingId;
  }

  const createdId = await playlists.create(name, description);
  log.info("Created TIDAL playlist", { name, playlistId: createdId });
  return createdId;
}

function playlistName(config: Config, sourcePatch: string): string {
  return config.tidal.playlistNameTemplate.replaceAll("{title}", humanizeSourcePatch(sourcePatch));
}

function buildDescription(playlist: SourcePlaylist): string {
  const parts = [playlist.description, `Synced from ListenBrainz: ${playlist.title}.`];
  return parts.filter(Boolean).join(" ").trim();
}

function describeTrack(track: { artist: string; title: string }): string {
  return `${track.artist} - ${track.title}`;
}
