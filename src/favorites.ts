import type { Config } from "./config.ts";
import { ListenBrainzClient, type RecordingQuery } from "./listenbrainz.ts";
import { log } from "./logger.ts";
import { MusicBrainzClient } from "./musicbrainz.ts";
import { UNRESOLVED_SAMPLE_LIMIT, type SyncStore } from "./store.ts";
import {
  type CollectionTrack,
  createClient,
  fetchCollectionTracks,
  fetchTrackDescriptors,
} from "./tidal/client.ts";
import { searchKey } from "./tidal/match.ts";

export type FavoritesReport = {
  collectionTracks: number;
  matchedByIsrc: number;
  matchedByName: number;
  /** Distinct recordings, after several TIDAL tracks collapsing onto one are merged. */
  recordings: number;
  unresolved: string[];
  alreadyLoved: number;
  loved: number;
  failed: number;
  dryRun: boolean;
  durationMs: number;
};

/**
 * Enough consecutive failures to mean something systemic — a revoked token, ListenBrainz
 * down — rather than one awkward recording. Stopping then avoids burning a whole rate
 * limit budget on requests that cannot succeed.
 */
const CONSECUTIVE_FAILURE_LIMIT = 10;

/** How often to report progress during a long first import. */
const PROGRESS_INTERVAL = 100;

export class FavoritesError extends Error {}

/**
 * Mirrors the TIDAL collection's tracks into ListenBrainz as loved recordings.
 *
 * This is the reverse of the playlist direction and needs the opposite mapping: TIDAL
 * gives us ISRCs, and ListenBrainz wants MusicBrainz recording MBIDs. ISRC is the precise
 * route; a name lookup through ListenBrainz's own mapper catches the rest.
 *
 * Additive by design — a track dropped from the TIDAL collection keeps its ListenBrainz
 * love, because loves also arrive from the ListenBrainz site and other clients, and this
 * tool has no way to tell those apart from ones it wrote.
 */
export async function runFavoritesSync(config: Config, store: SyncStore): Promise<FavoritesReport> {
  const startedAtMs = Date.now();

  const listenBrainz = new ListenBrainzClient(
    config.listenBrainzApiUrl,
    userAgent(config),
    config.listenBrainzToken,
  );
  const musicBrainz = new MusicBrainzClient(config.musicBrainzApiUrl, userAgent(config));

  const tokenOwner = await listenBrainz.validateToken();
  if (tokenOwner !== config.listenBrainzUser) {
    throw new FavoritesError(
      `LISTENBRAINZ_TOKEN belongs to "${tokenOwner}" but LISTENBRAINZ_USER is ` +
        `"${config.listenBrainzUser}". Loves are written to the token's account, so this ` +
        "would favourite tracks on the wrong profile.",
    );
  }

  const api = createClient();
  const tracks = await fetchCollectionTracks(api);
  log.info("Read TIDAL collection", { tracks: tracks.length });

  if (tracks.length === 0) {
    // Streaming a track does not add it to the collection — only favouriting does — so an
    // empty result is plausible rather than an error, but it is worth saying out loud.
    log.warn(
      "TIDAL collection is empty, so there is nothing to love. Note that listening to a " +
        "track does not add it to your collection; only saving/favouriting it does.",
    );
  }

  const { byTrack, matchedByIsrc, matchedByName, unresolved } = await resolveRecordings(
    { config, store, api, listenBrainz, musicBrainz },
    tracks,
  );

  // Resolution is the expensive half — minutes of rate-limited MusicBrainz requests on a
  // first run — so bank it before anything that submits and could fail.
  await store.flushCache();

  // Several TIDAL tracks — the single, the album cut, the remaster — routinely share one
  // MusicBrainz recording, and ListenBrainz holds one love per recording.
  const recordings = new Set(byTrack.values());

  log.info("Resolved collection to MusicBrainz recordings", {
    byIsrc: matchedByIsrc,
    byName: matchedByName,
    unresolved: unresolved.length,
    recordings: recordings.size,
  });

  const alreadyLoved = await listenBrainz.lovedRecordingMbids(config.listenBrainzUser);
  const missing = [...recordings].filter((mbid) => !alreadyLoved.has(mbid));

  log.info("Comparing against ListenBrainz loves", {
    lovedOnListenBrainz: alreadyLoved.size,
    toSubmit: missing.length,
  });

  const report: FavoritesReport = {
    collectionTracks: tracks.length,
    matchedByIsrc,
    matchedByName,
    recordings: recordings.size,
    unresolved,
    alreadyLoved: recordings.size - missing.length,
    loved: 0,
    failed: 0,
    dryRun: config.dryRun,
    durationMs: 0,
  };

  if (config.dryRun) {
    log.info("[dry run] Would love recordings on ListenBrainz", { count: missing.length });
  } else {
    const { loved, failed } = await submitLoves(listenBrainz, missing);
    report.loved = loved;
    report.failed = failed;
  }

  await store.saveFavorites({
    lastSyncedAt: new Date().toISOString(),
    collectionTracks: tracks.length,
    resolved: recordings.size,
    loved: report.loved,
    // Kept by name so `status` and the dashboard can show *which* tracks fell through,
    // not just how many — the usual next question after seeing the number.
    unresolved: [...unresolved].sort((a, b) => a.localeCompare(b)).slice(0, UNRESOLVED_SAMPLE_LIMIT),
    unresolvedTotal: unresolved.length,
  });

  report.durationMs = Date.now() - startedAtMs;
  return report;
}

type ResolveContext = {
  config: Config;
  store: SyncStore;
  api: ReturnType<typeof createClient>;
  listenBrainz: ListenBrainzClient;
  musicBrainz: MusicBrainzClient;
};

type ResolveResult = {
  /** TIDAL track id -> MusicBrainz recording MBID, for everything we placed. */
  byTrack: Map<string, string>;
  matchedByIsrc: number;
  matchedByName: number;
  /** Human-readable descriptions of what we could not place. */
  unresolved: string[];
};

async function resolveRecordings(
  context: ResolveContext,
  tracks: CollectionTrack[],
): Promise<ResolveResult> {
  const { store, config, api, listenBrainz, musicBrainz } = context;
  const byTrack = new Map<string, string>();
  let matchedByIsrc = 0;

  // Tier 1: ISRC via MusicBrainz. Only ISRCs we have never looked up cost a request;
  // confirmed misses are cached as null so a collection settles to zero lookups.
  const pending = tracks.flatMap((track) =>
    track.isrc && store.getCachedRecordingByIsrc(track.isrc) === undefined ? [track.isrc] : [],
  );
  const uniquePending = [...new Set(pending)];

  if (uniquePending.length > 0) {
    log.info("Looking up ISRCs on MusicBrainz", { isrcs: uniquePending.length });
    const found = await musicBrainz.recordingMbidsByIsrc(uniquePending);
    for (const isrc of uniquePending) {
      store.setCachedRecordingByIsrc(isrc, found.get(isrc) ?? null);
    }
  }

  for (const track of tracks) {
    const mbid = track.isrc ? store.getCachedRecordingByIsrc(track.isrc) : null;
    if (mbid) {
      byTrack.set(track.trackId, mbid);
      matchedByIsrc += 1;
    }
  }

  // Tier 2: artist + title through ListenBrainz's own mapper, for tracks with no ISRC or
  // an ISRC MusicBrainz does not carry.
  const remaining = tracks.filter((track) => !byTrack.has(track.trackId));
  const { matchedByName, unresolved } = await resolveByName(
    { store, config, api, listenBrainz },
    remaining,
    byTrack,
  );

  return { byTrack, matchedByIsrc, matchedByName, unresolved };
}

async function resolveByName(
  context: Pick<ResolveContext, "store" | "config" | "api" | "listenBrainz">,
  tracks: CollectionTrack[],
  byTrack: Map<string, string>,
): Promise<{ matchedByName: number; unresolved: string[] }> {
  const { store, config, api, listenBrainz } = context;
  if (tracks.length === 0) return { matchedByName: 0, unresolved: [] };

  // The collection listing gives titles but not artists, and the mapper needs both.
  const descriptors = await fetchTrackDescriptors(
    api,
    config,
    tracks.map((track) => track.trackId),
  );

  const queries: RecordingQuery[] = [];
  const queryOwners: string[] = [];
  const unresolved: string[] = [];
  let matchedByName = 0;

  for (const track of tracks) {
    const descriptor = descriptors.get(track.trackId);
    if (!descriptor) {
      unresolved.push(track.title ?? `TIDAL track ${track.trackId}`);
      continue;
    }

    const cached = store.getCachedRecordingBySearch(searchKey(descriptor));

    if (cached) {
      byTrack.set(track.trackId, cached);
      matchedByName += 1;
    } else if (cached === null) {
      unresolved.push(describeDescriptor(descriptor));
    } else {
      queries.push(descriptor);
      queryOwners.push(track.trackId);
    }
  }

  if (queries.length > 0) {
    log.info("Looking up remaining tracks by name on ListenBrainz", { tracks: queries.length });
    const found = await listenBrainz.lookupRecordings(queries);

    for (const [index, query] of queries.entries()) {
      const trackId = queryOwners[index];
      const mbid = found.get(index) ?? null;
      // Cache the miss too, so a track ListenBrainz cannot map is only asked about once.
      store.setCachedRecordingBySearch(searchKey(query), mbid);

      if (mbid && trackId) {
        byTrack.set(trackId, mbid);
        matchedByName += 1;
      } else {
        unresolved.push(describeDescriptor(query));
      }
    }
  }

  for (const description of unresolved) {
    log.debug("No MusicBrainz recording", { track: description });
  }

  return { matchedByName, unresolved };
}

async function submitLoves(
  listenBrainz: ListenBrainzClient,
  recordingMbids: string[],
): Promise<{ loved: number; failed: number }> {
  let loved = 0;
  let failed = 0;
  let consecutiveFailures = 0;

  for (const [index, mbid] of recordingMbids.entries()) {
    try {
      await listenBrainz.loveRecording(mbid);
      loved += 1;
      consecutiveFailures = 0;
    } catch (error) {
      failed += 1;
      consecutiveFailures += 1;
      log.warn("Could not love recording", {
        recordingMbid: mbid,
        error: error instanceof Error ? error.message : String(error),
      });

      if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
        throw new FavoritesError(
          `${consecutiveFailures} ListenBrainz submissions failed in a row; stopping with ` +
            `${loved} of ${recordingMbids.length} loved. The next run resumes from here.`,
        );
      }
    }

    const done = index + 1;
    if (done % PROGRESS_INTERVAL === 0) {
      log.info("Loving recordings", { done, total: recordingMbids.length });
    }
  }

  return { loved, failed };
}

function describeDescriptor(descriptor: { artist: string; title: string }): string {
  return `${descriptor.artist} - ${descriptor.title}`;
}

function userAgent(config: Config): string {
  return `listenbrainz-tidal-sync/1.0.0 ( ${config.contactEmail} )`;
}
