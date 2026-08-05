import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { ExportManifest, ExportedTrack } from "./export.ts";
import { LibraryIndex, type MatchTier } from "./library.ts";
import { log } from "./logger.ts";
import { DeviceNotAuthenticatedError, DeviceSession } from "./tidal/device-auth.ts";
import { downloadTrack, DownloadError, EncryptedStreamError, type Quality } from "./tidal/download.ts";

export type DownloadReport = {
  total: number;
  downloaded: number;
  /** Already present in the library — from an earlier run, or from some other tool. */
  skipped: number;
  /** How each skip was decided, so a run can be audited rather than taken on trust. */
  skippedByTier: Record<MatchTier, number>;
  /** TIDAL would only serve a preview — not entitled at any tier. */
  unavailable: number;
  failed: number;
  /** True when the run was stopped by hand before it reached the end of the list. */
  stopped: boolean;
};

/** Emitted before each track, so a caller with a UI can show where the run has got to. */
export type DownloadProgress = {
  /** 1-based position of the track about to be considered. */
  index: number;
  total: number;
  /** "Artist - Title" of that track. */
  track: string;
  downloaded: number;
  skipped: number;
  unavailable: number;
  failed: number;
};

export type DownloadOptions = {
  quality: Quality;
  /** Cap on tracks fetched this run. Downloading a whole collection in one go gets noticed. */
  limit?: number;
  /** Only tracks in this playlist (by name, case-insensitive). Default: the collection. */
  playlist?: string;
  dryRun: boolean;
  /**
   * Strictest tier the library index may skip on. `exact` requires artist, album and title
   * to agree; `loose` also accepts a match once "(Remastered 2011)"-style suffixes are
   * dropped. Looser means fewer redundant downloads and more risk of skipping a track you
   * wanted a different version of.
   */
  skipTier: MatchTier;
  /** Called before each track. The dashboard uses it to paint a live progress bar. */
  onProgress?: (progress: DownloadProgress) => void;
  /**
   * Stops the run at the next track boundary. A full collection at three seconds a track is
   * hours of work, so anything driving this from a UI needs a way out that is not SIGTERM;
   * stopping between tracks rather than mid-track is what keeps a partial file off disk.
   */
  signal?: AbortSignal;
};

/** Ordered loosest-last, so a configured tier admits itself and everything stricter. */
const TIER_ORDER: MatchTier[] = ["exact", "album-agnostic", "loose"];

/**
 * Fills a local library from the snapshot `export` produced.
 *
 * The export is the input on purpose rather than reading TIDAL again: it already resolved
 * every id to artist/album/title, so this pass makes exactly one network call per track and
 * stays resumable — anything already on disk is skipped, so an interrupted run continues
 * where it stopped instead of refetching.
 */
export async function runDownload(config: Config, options: DownloadOptions): Promise<DownloadReport> {
  const manifest = await readManifest(config);

  // A dry run reads the export and the library and contacts nothing, so it must work before
  // `download-login` has ever been run — that is exactly when you want to see the plan.
  const session = options.dryRun ? undefined : await DeviceSession.open(config);
  if (session && !session.isAuthenticated) throw new DeviceNotAuthenticatedError();

  const selected = select(manifest, options);
  const report: DownloadReport = {
    total: selected.length,
    downloaded: 0,
    skipped: 0,
    skippedByTier: { exact: 0, "album-agnostic": 0, loose: 0 },
    unavailable: 0,
    failed: 0,
    stopped: false,
  };

  // Built once up front rather than stat'ing per track: the whole point is to match files
  // this tool did not write, whose names will not be the ones it would have chosen.
  const library = await LibraryIndex.build(config.libraryDir);
  const allowedTiers = new Set(TIER_ORDER.slice(0, TIER_ORDER.indexOf(options.skipTier) + 1));

  log.info("Starting download", {
    tracks: selected.length,
    quality: options.quality,
    library: config.libraryDir,
    source: options.playlist ?? "collection",
    skipTier: options.skipTier,
  });

  for (const [index, track] of selected.entries()) {
    if (options.signal?.aborted) {
      report.stopped = true;
      log.info("Download stopped by request", { after: index, of: selected.length });
      break;
    }

    options.onProgress?.({
      index: index + 1,
      total: selected.length,
      track: label(track),
      downloaded: report.downloaded,
      skipped: report.skipped,
      unavailable: report.unavailable,
      failed: report.failed,
    });

    const existing = library.find(track);

    if (existing && allowedTiers.has(existing.tier)) {
      report.skipped += 1;
      report.skippedByTier[existing.tier] += 1;
      log.debug("Already in library", {
        track: label(track),
        tier: existing.tier,
        path: library.relative(existing.path),
      });
      continue;
    }

    if (options.dryRun) {
      log.info("Would download", { track: label(track), path: track.path });
      continue;
    }

    log.info(`[${index + 1}/${selected.length}] ${label(track)}`);

    try {
      const destination = join(config.libraryDir, track.path);
      // Unreachable on a dry run: the loop `continue`s above before it gets here.
      const written = await downloadTrack(session!, track.tidalId, destination, options.quality);
      if (written) report.downloaded += 1;
      else report.unavailable += 1;
    } catch (error) {
      // An encrypted playlist means the whole approach stopped working, not that one track
      // is odd — carrying on would just produce hundreds of identical failures.
      if (error instanceof EncryptedStreamError) throw error;

      report.failed += 1;
      log.warn("Track failed", {
        track: label(track),
        error: error instanceof DownloadError ? error.message : String(error),
      });
    }

    await sleep(config.tidal.downloadDelayMs, options.signal);
  }

  return report;
}

async function readManifest(config: Config): Promise<ExportManifest> {
  const path = join(config.dataDir, "export", "export.json");

  try {
    return JSON.parse(await readFile(path, "utf8")) as ExportManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DownloadError(`No export found at ${path}. Run \`bun run export\` first.`);
    }
    throw error;
  }
}

/** Resolves the requested source to an ordered, de-duplicated list of tracks. */
function select(manifest: ExportManifest, options: DownloadOptions): ExportedTrack[] {
  let trackIds: string[];

  if (options.playlist) {
    const wanted = options.playlist.toLowerCase();
    const playlist = manifest.playlists.find((entry) => entry.name.toLowerCase() === wanted);
    if (!playlist) {
      const names = manifest.playlists.map((entry) => entry.name).join(", ");
      throw new DownloadError(`No exported playlist named "${options.playlist}". Available: ${names || "none"}`);
    }
    trackIds = playlist.trackIds;
  } else {
    trackIds = manifest.favoriteIds;
  }

  const seen = new Set<string>();
  const tracks: ExportedTrack[] = [];
  for (const trackId of trackIds) {
    if (seen.has(trackId)) continue;
    seen.add(trackId);
    // Tombstoned tracks have no metadata, so there is no path to write them to.
    const track = manifest.tracks[trackId];
    if (track) tracks.push(track);
  }

  return options.limit ? tracks.slice(0, options.limit) : tracks;
}

function label(track: ExportedTrack): string {
  return `${track.artists[0] ?? "Unknown Artist"} - ${track.title}`;
}

/** Resolves early if `signal` aborts, so "stop" does not sit through the inter-track pause. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export function logDownloadReport(report: DownloadReport): void {
  const { skippedByTier, ...counts } = report;
  log.info(report.stopped ? "Download stopped" : "Download complete", { ...counts });

  if (report.skipped > 0) {
    log.info("Skips by how they were matched", { ...skippedByTier });
  }

  // A `loose` match is the one that can be wrong — it ignores "(Live)", "(Acoustic)" and
  // the like, so it can skip a track you wanted a different version of. Say so explicitly.
  if (skippedByTier.loose > 0) {
    log.warn("Some skips matched only after dropping bracketed suffixes; re-run with " +
      "--skip-tier=album-agnostic to fetch those", { loose: skippedByTier.loose });
  }

  if (report.unavailable > 0) {
    log.warn("Some tracks were preview-only — the account is not entitled to them at any tier", {
      unavailable: report.unavailable,
    });
  }
}

export { DownloadError };
