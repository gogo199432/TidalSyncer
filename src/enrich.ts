import { join } from "node:path";
import type { Config } from "./config.ts";
import { readJson, writeAtomic } from "./json-file.ts";
import { ListenBrainzClient, type LbTag, type RecordingMetadata } from "./listenbrainz.ts";
import { log } from "./logger.ts";
import { MusicBrainzClient } from "./musicbrainz.ts";
import type { TrackDetail } from "./tidal/catalog.ts";

/**
 * What TIDAL does not know about the music it sells.
 *
 * TIDAL's track endpoint gives a title, a credit list, an album and a date, and that is the
 * end of it — no genre, and no identifier that means anything outside TIDAL. MusicBrainz has
 * all of it, and every track in the snapshot with an ISRC is one lookup away from it.
 *
 * The route is deliberately indirect. MusicBrainz itself allows one request a second, which
 * for a collection of any size is minutes of waiting; ListenBrainz mirrors the same data,
 * needs no token, and answers 50 recordings a request. So MusicBrainz is asked only the
 * question ListenBrainz cannot answer — which recording an ISRC is — and it is asked in
 * batches of twenty, with the answers cached for ever afterwards.
 *
 * None of this is load-bearing. Every failure here degrades to a file tagged with exactly
 * what TIDAL said, which is what the previous version wrote at best.
 */

export type Enrichment = {
  /** The MusicBrainz recording this track is. Everything else hangs off it. */
  recordingMbid: string;
  artistMbids?: string[];
  releaseMbid?: string;
  releaseGroupMbid?: string;
  /** Genres, strongest first. Only tags MusicBrainz recognises as genres. */
  genres?: string[];
  /** The release year, for tracks TIDAL gave no date for. */
  year?: number;
  /** Cover Art Archive: enough to build the image URL, no second lookup needed. */
  cover?: { releaseMbid: string; id: number };
};

type CacheFile = {
  version: 1;
  /** ISRC -> recording MBID, or null for "MusicBrainz has been asked and does not know". */
  isrcToRecording: Record<string, string | null>;
  /** Recording MBID -> what ListenBrainz said about it. */
  recordings: Record<string, Enrichment>;
};

const EMPTY: CacheFile = { version: 1, isrcToRecording: {}, recordings: {} };

/**
 * How many genres to keep.
 *
 * More than one would have to be written as `"trip hop; electronic"`, because a single
 * `-metadata genre=` is all ffmpeg offers and Vorbis's repeated-field form is out of reach
 * from the command line. Whether a scanner reads that back as two genres or as one oddly
 * named one depends on how it is configured, so the tag carries the one genre that is
 * unambiguous and the rest stay in the snapshot for anything that wants them.
 */
const GENRES_KEPT = 3;

/**
 * Resolves everything MusicBrainz knows for a set of tracks, keyed by TIDAL id.
 *
 * Tracks with no ISRC are absent from the result: there is no way to ask about them. So are
 * the ones MusicBrainz does not recognise, and that answer is cached too — a track that is
 * not in MusicBrainz today will not be next week either, and re-asking every six hours for
 * ever is the sort of thing that gets a client blocked.
 */
export async function enrich(config: Config, tracks: TrackDetail[]): Promise<Map<string, Enrichment>> {
  const cache = new EnrichmentCache(join(config.dataDir, "enrichment.json"));
  await cache.load();

  const byIsrc = new Map<string, TrackDetail[]>();
  for (const track of tracks) {
    if (!track.isrc) continue;
    const existing = byIsrc.get(track.isrc);
    if (existing) existing.push(track);
    else byIsrc.set(track.isrc, [track]);
  }

  const unresolved = [...byIsrc.keys()].filter((isrc) => cache.recordingFor(isrc) === undefined);

  if (unresolved.length > 0) {
    log.info("Resolving ISRCs to MusicBrainz recordings", { isrcs: unresolved.length, cached: byIsrc.size - unresolved.length });
    try {
      const client = new MusicBrainzClient(config.musicBrainzApiUrl, userAgent(config));
      const resolved = await client.recordingMbidsByIsrc(unresolved);
      // Misses are recorded as misses, which is the half that stops this being re-run for ever.
      for (const isrc of unresolved) cache.setRecording(isrc, resolved.get(isrc) ?? null);
    } catch (error) {
      log.warn("Could not reach MusicBrainz, so this run adds no genres or identifiers", {
        error: String(error),
      });
    }
  }

  const wanted = new Set<string>();
  for (const isrc of byIsrc.keys()) {
    const mbid = cache.recordingFor(isrc);
    if (mbid && !cache.has(mbid)) wanted.add(mbid);
  }

  if (wanted.size > 0) {
    log.info("Reading recording metadata from ListenBrainz", { recordings: wanted.size });
    const client = new ListenBrainzClient(config.listenBrainzApiUrl, userAgent(config));
    const metadata = await client.fetchRecordingMetadata([...wanted]);
    for (const [mbid, entry] of metadata) cache.set(mbid, toEnrichment(mbid, entry));
  }

  await cache.save();

  const result = new Map<string, Enrichment>();
  for (const [isrc, sharing] of byIsrc) {
    const mbid = cache.recordingFor(isrc);
    const enrichment = mbid ? cache.get(mbid) : undefined;
    if (!enrichment) continue;
    // Several TIDAL tracks can share an ISRC — the same recording on the single and on the
    // album — and each of them wants the same answer.
    for (const track of sharing) result.set(track.tidalId, enrichment);
  }

  log.info("Enrichment resolved", {
    tracks: result.size,
    of: tracks.length,
    withGenre: [...result.values()].filter((entry) => entry.genres?.length).length,
    withCover: [...result.values()].filter((entry) => entry.cover).length,
  });

  return result;
}

/**
 * Turns one ListenBrainz response into what gets written into a file.
 *
 * Genres come from the recording first, then the release group, then the artist — narrowest
 * first, because "the genre of this recording" is a better answer than "the genre of this
 * band" and only the last of the three is always populated. Within a level they are ordered
 * by how many people applied the tag.
 */
export function toEnrichment(recordingMbid: string, metadata: RecordingMetadata): Enrichment {
  const release = metadata.release;
  const artistMbids = (metadata.artist?.artists ?? [])
    .map((artist) => artist.artist_mbid)
    .filter((mbid): mbid is string => Boolean(mbid));

  return {
    recordingMbid,
    ...(artistMbids.length > 0 ? { artistMbids } : {}),
    ...(release?.mbid ? { releaseMbid: release.mbid } : {}),
    ...(release?.release_group_mbid ? { releaseGroupMbid: release.release_group_mbid } : {}),
    ...(release?.year ? { year: release.year } : {}),
    ...(genresOf(metadata).length > 0 ? { genres: genresOf(metadata) } : {}),
    ...(release?.caa_id && release.caa_release_mbid
      ? { cover: { releaseMbid: release.caa_release_mbid, id: release.caa_id } }
      : {}),
  };
}

function genresOf(metadata: RecordingMetadata): string[] {
  const tags = metadata.tag;
  const genres: string[] = [];

  for (const level of [tags?.recording, tags?.release_group, tags?.artist]) {
    for (const tag of ranked(level ?? [])) {
      // Case-folded, because "Trip Hop" and "trip hop" are the same genre and a library that
      // ends up with both has learnt nothing.
      if (!genres.some((existing) => existing.toLowerCase() === tag.toLowerCase())) genres.push(tag);
      if (genres.length >= GENRES_KEPT) return genres;
    }
  }

  return genres;
}

/** Both APIs ask to be told who is calling, and MusicBrainz enforces it. */
function userAgent(config: Config): string {
  return `listenbrainz-tidal-sync/1.0.0 ( ${config.contactEmail} )`;
}

/** Genres only — a tag with no `genre_mbid` is a mood, a decade or somebody's opinion. */
function ranked(tags: LbTag[]): string[] {
  return tags
    .filter((tag) => tag.genre_mbid && tag.tag)
    .sort((left, right) => (right.count ?? 0) - (left.count ?? 0) || left.tag.localeCompare(right.tag))
    .map((tag) => tag.tag);
}

/**
 * The answers, on disk.
 *
 * Its own file rather than a corner of `cache.json`, which `SyncStore` owns: the daemon holds
 * one of those open for its whole life and writes it back wholesale, so a second writer would
 * be a way to lose sync state. This one is opened, used and closed inside a single export.
 */
class EnrichmentCache {
  private file: CacheFile = structuredClone(EMPTY);
  private dirty = false;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    this.file = await readJson(this.path, structuredClone(EMPTY));
    this.file.isrcToRecording ??= {};
    this.file.recordings ??= {};
  }

  /** The MBID for an ISRC, `null` for a known miss, `undefined` for never asked. */
  recordingFor(isrc: string): string | null | undefined {
    return this.file.isrcToRecording[isrc];
  }

  setRecording(isrc: string, mbid: string | null): void {
    this.file.isrcToRecording[isrc] = mbid;
    this.dirty = true;
  }

  has(mbid: string): boolean {
    return mbid in this.file.recordings;
  }

  get(mbid: string): Enrichment | undefined {
    return this.file.recordings[mbid];
  }

  set(mbid: string, enrichment: Enrichment): void {
    this.file.recordings[mbid] = enrichment;
    this.dirty = true;
  }

  async save(): Promise<void> {
    if (!this.dirty) return;

    try {
      await writeAtomic(this.path, `${JSON.stringify(this.file, null, 2)}\n`);
      this.dirty = false;
    } catch (error) {
      // Losing the cache costs a re-lookup next run, not a track. Never worth failing over.
      log.warn("Could not write the enrichment cache", { path: this.path, error: String(error) });
    }
  }
}
