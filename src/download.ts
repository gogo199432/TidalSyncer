import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Config } from "./config.ts";
import type { ExportManifest, ExportedTrack } from "./export.ts";
import { LibraryIndex, type MatchTier } from "./library.ts";
import { log } from "./logger.ts";
import {
  attainableTier,
  describeQuality,
  probeQuality,
  rank,
  type LocalQuality,
  type QualityTier,
} from "./quality.ts";
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
  /** Files replaced with a better copy. Only ever non-zero when upgrading was asked for. */
  upgraded: number;
  /** What was replaced, by the tier the old file was at. */
  upgradedFrom: Record<QualityTier, number>;
  /** Matched files that were already as good as anything TIDAL would serve. */
  alreadyBest: number;
};

/**
 * What happened to one track.
 *
 * On a dry run these are what *would* happen — the loop takes the same decisions and stops
 * short of acting on them, so a plan and a run are described by the same vocabulary.
 */
export type DownloadOutcome = "downloaded" | "upgraded" | "skipped" | "unavailable" | "failed";

export type DownloadEvent = {
  /** 1-based position in the run, so the list can be read against the progress counter. */
  index: number;
  track: string;
  outcome: DownloadOutcome;
  /** Why: the match tier, the quality change, or the error. */
  detail?: string;
  /** Library-relative, for the file this concerns. */
  path?: string;
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
  /**
   * Replace a file already in the library when TIDAL would serve something better — a
   * lossless copy of a track you only have as AAC, say.
   *
   * Off by default, because it is the one mode that touches files you already have. The
   * replaced file is moved to `DATA_DIR/replaced/` rather than deleted, so a bad call is
   * recoverable; nothing is ever removed until the new file is on disk.
   */
  upgrade?: boolean;
  /** Called before each track. The dashboard uses it to paint a live progress bar. */
  onProgress?: (progress: DownloadProgress) => void;
  /**
   * Called once per track with what happened to it. This is what makes a failure visible
   * while a run is going rather than only in the log, and what lets a dry run print a plan
   * instead of a count.
   */
  onEvent?: (event: DownloadEvent) => void;
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
 * Consecutive failures that mean the run itself is broken rather than the tracks being odd.
 *
 * A missing codec, a wrong ffmpeg invocation or a share that went read-only fails *every*
 * track identically, and at three seconds apiece a long list spends half an hour proving it.
 * Individual tracks do genuinely fail, so this is not one strike — but it is not 695 either.
 */
const CONSECUTIVE_FAILURE_LIMIT = 5;

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
    upgraded: 0,
    upgradedFrom: { lossy: 0, lossless: 0, hires: 0 },
    alreadyBest: 0,
  };

  // Built once up front rather than stat'ing per track: the whole point is to match files
  // this tool did not write, whose names will not be the ones it would have chosen.
  const library = await LibraryIndex.build(config.libraryDir);
  const allowedTiers = new Set(TIER_ORDER.slice(0, TIER_ORDER.indexOf(options.skipTier) + 1));
  let consecutiveFailures = 0;

  log.info("Starting download", {
    tracks: selected.length,
    quality: options.quality,
    library: config.libraryDir,
    source: options.playlist ?? "collection",
    skipTier: options.skipTier,
    upgrade: Boolean(options.upgrade),
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

    const found = library.find(track);
    // Kept as the match itself rather than a boolean, so the branches below narrow on it.
    const matched = found && allowedTiers.has(found.tier) ? found : undefined;

    // What replacing this file would actually get us, if anything. Undefined means leave it
    // alone: either upgrading is off, or the file is already as good as TIDAL's copy, or it
    // could not be read — and an unreadable file is not grounds for overwriting it.
    const upgrade = matched && options.upgrade ? await considerUpgrade(matched, track, options) : undefined;

    const emit = (outcome: DownloadOutcome, detail?: string, path?: string) =>
      options.onEvent?.({ index: index + 1, track: label(track), outcome, detail, path });

    if (matched && !upgrade) {
      report.skipped += 1;
      report.skippedByTier[matched.tier] += 1;
      if (options.upgrade) report.alreadyBest += 1;
      log.debug("Already in library", {
        track: label(track),
        tier: matched.tier,
        path: library.relative(matched.path),
      });
      emit("skipped", matched.tier, library.relative(matched.path));
      continue;
    }

    if (options.dryRun) {
      // Counted rather than only logged: on a dry run these read as "would download" and
      // "would upgrade", and a plan you have to grep the log to size up is not a plan.
      if (upgrade) {
        report.upgraded += 1;
        report.upgradedFrom[upgrade.from.tier] += 1;
        log.info("Would upgrade", {
          track: label(track),
          from: describeQuality(upgrade.from),
          to: upgrade.to,
          path: library.relative(upgrade.path),
        });
        emit("upgraded", `${describeQuality(upgrade.from)} → ${upgrade.to}`, library.relative(upgrade.path));
      } else {
        report.downloaded += 1;
        log.info("Would download", { track: label(track), path: track.path });
        emit("downloaded", undefined, track.path);
      }
      continue;
    }

    log.info(`[${index + 1}/${selected.length}] ${label(track)}${upgrade ? " (upgrade)" : ""}`);

    try {
      const destination = join(config.libraryDir, track.path);
      // Unreachable on a dry run: the loop `continue`s above before it gets here.
      const written = upgrade
        ? await replace(config, session!, track, destination, upgrade.path, options.quality)
        : await downloadTrack(session!, track.tidalId, destination, options.quality);

      if (!written) {
        report.unavailable += 1;
        emit("unavailable", "TIDAL served only a preview at every tier");
      } else if (upgrade) {
        report.upgraded += 1;
        report.upgradedFrom[upgrade.from.tier] += 1;
        log.info("Replaced with a better copy", {
          track: label(track),
          from: describeQuality(upgrade.from),
          to: upgrade.to,
        });
        emit("upgraded", `${describeQuality(upgrade.from)} → ${upgrade.to}`, relative(config.libraryDir, written));
      } else {
        report.downloaded += 1;
        emit("downloaded", undefined, relative(config.libraryDir, written));
      }

      consecutiveFailures = 0;
    } catch (error) {
      // An encrypted playlist means the whole approach stopped working, not that one track
      // is odd — carrying on would just produce hundreds of identical failures.
      if (error instanceof EncryptedStreamError) throw error;

      report.failed += 1;
      consecutiveFailures += 1;
      const message = error instanceof DownloadError ? error.message : String(error);
      log.warn("Track failed", { track: label(track), error: message });
      emit("failed", message);

      if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
        throw new DownloadError(
          `${consecutiveFailures} tracks in a row failed, so this is the run and not the ` +
            `tracks — stopping instead of working through ${selected.length - index - 1} more. ` +
            `Last error: ${message}`,
        );
      }
    }

    await sleep(config.tidal.downloadDelayMs, options.signal);
  }

  return report;
}

/**
 * Decides whether TIDAL's copy of a track beats the one on disk.
 *
 * Compares against what a download would *actually* produce — the best TIDAL offers, capped
 * by the quality asked for — rather than against TIDAL's catalogue entry, so a lossless run
 * never claims it is about to upgrade a FLAC to hi-res and then writes 16-bit.
 */
async function considerUpgrade(
  existing: { path: string },
  track: ExportedTrack,
  options: DownloadOptions,
): Promise<{ from: LocalQuality; to: QualityTier; path: string } | undefined> {
  const from = await probeQuality(existing.path);
  if (!from) return undefined;

  const to = attainableTier(track.mediaTags, options.quality);
  // Carries the path so the branches that act on an upgrade need not re-narrow the match.
  return rank(to) > rank(from.tier) ? { from, to, path: existing.path } : undefined;
}

/**
 * Downloads a better copy and retires the old file.
 *
 * The old file is moved into `DATA_DIR/replaced/`, mirroring its path in the library, rather
 * than deleted — this is the one operation that destroys something the user already had, and
 * a judgement about "better" made from a codec name deserves an undo. It also leaves the
 * library with exactly one copy, which a deletion-free approach would not: the new file
 * usually lands under a different extension, so keeping both would show up as a duplicate in
 * whatever is serving the library.
 *
 * Ordering matters. When the new file would land on the old one's exact path, the old is
 * moved aside *first* and put back if the download fails; otherwise it is only retired once
 * the replacement is safely written.
 */
async function replace(
  config: Config,
  session: DeviceSession,
  track: ExportedTrack,
  destination: string,
  existingPath: string,
  quality: Quality,
): Promise<string | undefined> {
  // Empty `replacedDir` means the old file is deleted rather than kept. It is still only
  // removed once the replacement is on disk, so the failure modes below are unchanged —
  // except that "put it back" becomes impossible, which is why retiring is the default.
  const retired = config.replacedDir
    ? join(config.replacedDir, relative(config.libraryDir, existingPath))
    : undefined;
  if (retired) await mkdir(dirname(retired), { recursive: true });

  const collides = existingPath === destination;
  // Without somewhere to put it, a colliding path has to be moved aside temporarily anyway:
  // the download would otherwise overwrite the only copy before it is known to have worked.
  const parked = retired ?? `${existingPath}.superseded`;
  if (collides) await rename(existingPath, parked);

  let written: string | undefined;
  try {
    written = await downloadTrack(session, track.tidalId, destination, quality);
  } catch (error) {
    // Put it back before anything else — a failed upgrade must not cost the user the file
    // they already had.
    if (collides) await rename(parked, existingPath);
    throw error;
  }

  if (!written) {
    // Preview-only at every tier: nothing was written, so restore and leave it be.
    if (collides) await rename(parked, existingPath);
    return undefined;
  }

  if (collides) {
    // Parked out of the way only because the replacement needed the name; with no retire
    // directory configured, this is where the old copy is actually discarded.
    if (!retired) await rm(parked, { force: true });
  } else if (retired) {
    await rename(existingPath, retired).catch(async (error: unknown) => {
      // The replacement is already on disk; failing to retire the old one would leave two
      // copies, so say so loudly rather than reporting a clean upgrade.
      log.warn("Downloaded the better copy but could not retire the old file", {
        old: existingPath,
        error: String(error),
      });
      await rm(retired, { force: true });
    });
  } else {
    await rm(existingPath, { force: true });
  }

  return written;
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
  const { skippedByTier, upgradedFrom, ...counts } = report;
  log.info(report.stopped ? "Download stopped" : "Download complete", { ...counts });

  if (report.skipped > 0) {
    log.info("Skips by how they were matched", { ...skippedByTier });
  }

  if (report.upgraded > 0) {
    log.info("Upgraded, by what the old file was", { ...upgradedFrom });
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
