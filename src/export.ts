import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { log } from "./logger.ts";
import { fetchOwnedPlaylists, fetchTrackDetails, type PlaylistDetail, type TrackDetail } from "./tidal/catalog.ts";
import { createClient, fetchCollectionTracks } from "./tidal/client.ts";

/** Bumped when the on-disk shape changes, so a consumer can refuse a snapshot it predates. */
const EXPORT_VERSION = 1;

export type ExportManifest = {
  version: number;
  exportedAt: string;
  countryCode: string;
  playlists: PlaylistDetail[];
  /** Ordered TIDAL track ids for the collection ("My Collection" → Tracks). */
  favoriteIds: string[];
  /** Every track referenced above, keyed by TIDAL id. */
  tracks: Record<string, ExportedTrack>;
  stats: {
    playlists: number;
    favorites: number;
    uniqueTracks: number;
    /** Tracks whose metadata TIDAL would not return — delisted, or region-locked. */
    unresolved: number;
    withIsrc: number;
  };
};

/** A `TrackDetail` plus where the downloader should put the file, if it ever fetches one. */
export type ExportedTrack = TrackDetail & {
  /** Library-relative, extension included: `Artist/Album/Title.flac`. */
  path: string;
  /** When the user favourited it. Only set for collection tracks. */
  addedAt?: string;
};

export type ExportResult = {
  directory: string;
  manifest: ExportManifest;
};

/**
 * Writes a portable snapshot of the TIDAL account's curation: every owned playlist, the
 * collection, and full metadata for every track either references.
 *
 * The point is that this survives things the account does not. A TIDAL playlist stops
 * existing when the subscription lapses, and individual tracks get delisted or silently
 * swapped for a `replacement` version while it is still live. An ISRC plus artist/title
 * recorded here stays resolvable against MusicBrainz, a local library, or a shop, forever.
 */
export async function runExport(config: Config): Promise<ExportResult> {
  const api = createClient();
  const directory = join(config.dataDir, "export");

  log.info("Reading playlists");
  const playlists = await fetchOwnedPlaylists(api, config);

  log.info("Reading collection");
  const collection = await fetchCollectionTracks(api);
  const favoriteIds = collection.map((track) => track.trackId);
  const addedAt = new Map(collection.map((track) => [track.trackId, track.addedAt]));

  const referenced = [...new Set([...playlists.flatMap((playlist) => playlist.trackIds), ...favoriteIds])];
  log.info("Resolving track metadata", { tracks: referenced.length });
  const details = await fetchTrackDetails(api, config, referenced);

  const tracks: Record<string, ExportedTrack> = {};
  for (const [trackId, detail] of details) {
    tracks[trackId] = { ...detail, path: libraryPath(detail), addedAt: addedAt.get(trackId) };
  }

  const manifest: ExportManifest = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    countryCode: config.tidal.countryCode,
    playlists,
    favoriteIds,
    tracks,
    stats: {
      playlists: playlists.length,
      favorites: favoriteIds.length,
      uniqueTracks: referenced.length,
      unresolved: referenced.length - details.size,
      withIsrc: [...details.values()].filter((track) => track.isrc).length,
    },
  };

  await mkdir(join(directory, "playlists"), { recursive: true });
  await writeAtomic(join(directory, "export.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  for (const playlist of playlists) {
    const file = join(directory, "playlists", `${slugify(playlist.name)}.m3u8`);
    await writeAtomic(file, renderM3u(playlist.name, playlist.trackIds, tracks));
  }
  await writeAtomic(join(directory, "favorites.m3u8"), renderM3u("Favorites", favoriteIds, tracks));

  return { directory, manifest };
}

/**
 * Extended M3U, one per playlist.
 *
 * The URI line is the *intended* library path rather than a TIDAL URL: the file may not
 * exist yet, but every player resolves relative paths against the playlist's own location,
 * so dropping these next to a filled-in library makes them work with no rewriting. The
 * `#TIDAL-*` comments are ignored by players and are what makes the file re-resolvable.
 */
function renderM3u(name: string, trackIds: string[], tracks: Record<string, ExportedTrack>): string {
  const lines = ["#EXTM3U", `#PLAYLIST:${name}`];

  for (const trackId of trackIds) {
    const track = tracks[trackId];
    if (!track) {
      // Keep a tombstone: knowing a slot existed and what it pointed at beats a silent gap.
      lines.push(`# unresolved TIDAL track ${trackId}`);
      continue;
    }

    const artist = track.artists[0] ?? "Unknown Artist";
    lines.push(`#EXTINF:${track.duration ?? -1},${artist} - ${track.title}`);
    if (track.isrc) lines.push(`#TIDAL-ISRC:${track.isrc}`);
    lines.push(`#TIDAL-ID:${track.tidalId}`);
    lines.push(track.path);
  }

  return `${lines.join("\n")}\n`;
}

/** `Artist/Album/Title.flac` — the layout Navidrome, Plex and beets all read without help. */
function libraryPath(track: TrackDetail): string {
  const artist = sanitize(track.artists[0] ?? "Unknown Artist");
  const album = sanitize(track.album ?? "Unknown Album");
  return `${artist}/${album}/${sanitize(track.title)}.flac`;
}

/**
 * Strips what no filesystem will take, and nothing else.
 *
 * Windows is the binding constraint — reserved characters plus no trailing dot or space —
 * and honouring it keeps an exported library portable across the NAS it will probably end
 * up on.
 *
 * Spaces and hyphens are deliberately *kept*. Every other tagger writes "Karma Police.flac",
 * so folding them to "Karma_Police.flac" would stop this matching an existing library.
 */
export function sanitize(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  return cleaned.slice(0, 120).trim() || "untitled";
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, 80) || "untitled";
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

export function logExportReport(result: ExportResult): void {
  const { stats } = result.manifest;
  log.info("Export complete", {
    directory: result.directory,
    playlists: stats.playlists,
    favorites: stats.favorites,
    tracks: stats.uniqueTracks,
    withIsrc: stats.withIsrc,
    unresolved: stats.unresolved,
  });

  if (stats.unresolved > 0) {
    log.warn("Some tracks could not be resolved and are recorded as tombstones", {
      unresolved: stats.unresolved,
    });
  }
}
