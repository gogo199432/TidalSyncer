import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, utimes } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import type { Config } from "./config.ts";
import type { ExportManifest, ExportedTrack } from "./export.ts";
import { DirectoryNames } from "./directories.ts";
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
import {
  downloadTrack,
  DownloadError,
  EncryptedStreamError,
  PART_SUFFIX,
  RAW_SUFFIX,
  type Quality,
} from "./tidal/download.ts";
import { runFallback, type FallbackCandidate, type FallbackReport } from "./slskd/fallback.ts";
import { UpgradeLedger } from "./upgrades.ts";

export type DownloadReport = {
  total: number;
  downloaded: number;
  /** Already present in the library — from an earlier run, or from some other tool. */
  skipped: number;
  /** How each skip was decided, so a run can be audited rather than taken on trust. */
  skippedByTier: Record<MatchTier, number>;
  /** TIDAL would only serve a preview — not entitled at any tier. */
  unavailable: number;
  /**
   * In the source list, but the snapshot carries no metadata for them — delisted or
   * region-locked, so there is nothing to fetch and nowhere to put it. Never attempted.
   */
  missing: number;
  failed: number;
  /** True when the run was stopped by hand before it reached the end of the list. */
  stopped: boolean;
  /** Files replaced with a better copy. Only ever non-zero when upgrading was asked for. */
  upgraded: number;
  /** What was replaced, by the tier the old file was at. */
  upgradedFrom: Record<QualityTier, number>;
  /**
   * Matched files that were already as good as anything TIDAL would serve — including the
   * ones where that only became clear after fetching TIDAL's copy and finding it no better.
   */
  alreadyBest: number;
  /**
   * The Soulseek pass, when one ran. Absent when slskd is not configured, which is the
   * default — so a zero here means "tried and got nothing", not "switched off".
   */
  soulseek?: FallbackReport;
};

/**
 * What happened to one track.
 *
 * On a dry run these are what *would* happen — the loop takes the same decisions and stops
 * short of acting on them, so a plan and a run are described by the same vocabulary.
 */
export type DownloadOutcome =
  | "downloaded"
  | "upgraded"
  | "skipped"
  | "unavailable"
  | "missing"
  /** Rescued from Soulseek after TIDAL would not serve it. */
  | "soulseek"
  | "failed";

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
 * The scratch name an upgrade fetches to, before it is known to be worth keeping.
 *
 * Leading dot so scanners ignore it, and no audio extension on the prefix so the library
 * index does not either. `%d` is the pid of the run that created it.
 */
const UPGRADE_PREFIX = ".upgrading-";

/** Matches every transient this tool writes into the library, and nothing else. */
const INTERRUPTED = new RegExp(
  `^${UPGRADE_PREFIX.replace(".", "\\.")}(\\d+)-|\\.(\\d+)(?:${RAW_SUFFIX}|${PART_SUFFIX})$`,
);

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

  const { tracks: selected, missing } = select(manifest, options);
  const report: DownloadReport = {
    // Tombstones are counted in the total on purpose: they are part of what was asked for,
    // and leaving them out is what made them invisible.
    total: selected.length + missing.length,
    downloaded: 0,
    skipped: 0,
    skippedByTier: { exact: 0, "album-agnostic": 0, loose: 0 },
    unavailable: 0,
    missing: 0,
    failed: 0,
    stopped: false,
    upgraded: 0,
    upgradedFrom: { lossy: 0, lossless: 0, hires: 0 },
    alreadyBest: 0,
  };

  // Housekeeping, before the run proper. The sweep goes before the index is built so a
  // partial file from a killed run is neither counted nor left to accumulate. Both are
  // skipped on a dry run, which does not get to delete anything.
  if (!options.dryRun) {
    await sweepInterrupted(config.libraryDir);
    await pruneRetired(config);
  }

  // Built once up front rather than stat'ing per track: the whole point is to match files
  // this tool did not write, whose names will not be the ones it would have chosen.
  const library = await LibraryIndex.build(config.libraryDir);
  const allowedTiers = new Set(TIER_ORDER.slice(0, TIER_ORDER.indexOf(options.skipTier) + 1));
  // Read on dry runs too, so the plan matches what a real run would actually do rather than
  // re-proposing upgrades an earlier run already established TIDAL will not serve.
  // Prefers the spelling of an artist or album folder already on disk over TIDAL's, so a
  // library with `Nero` does not acquire a second `NERO` next to it.
  const directories = new DirectoryNames(config.libraryDir);
  const ledger = options.upgrade ? await UpgradeLedger.open(config.dataDir) : undefined;
  let consecutiveFailures = 0;

  // Everything TIDAL turns out not to serve, collected as the run goes and handed to
  // Soulseek at the end. Collected even when slskd is unconfigured — the list costs nothing
  // and keeping the branch out of the loop keeps the loop about TIDAL.
  const fallback: FallbackCandidate[] = [];

  log.info("Starting download", {
    tracks: selected.length,
    ...(missing.length > 0 ? { tombstoned: missing.length } : {}),
    quality: options.quality,
    library: config.libraryDir,
    source: options.playlist ?? "collection",
    skipTier: options.skipTier,
    upgrade: Boolean(options.upgrade),
    ...(ledger ? { knownUpgradeAttempts: ledger.size } : {}),
  });

  // Reported first, and before anything is fetched: they are known the moment the snapshot is
  // read, and they are the answer to "why is this run shorter than my collection?".
  for (const [index, trackId] of missing.entries()) {
    report.missing += 1;
    log.warn("No metadata in the snapshot, so there is nothing to fetch", { trackId });
    options.onEvent?.({
      index: index + 1,
      track: `TIDAL track ${trackId}`,
      outcome: "missing",
      detail: "not in the snapshot — delisted, or not available in TIDAL_COUNTRY_CODE",
    });
    fallback.push({ tidalId: trackId, index: index + 1, tombstone: manifest.tombstones?.[trackId] });
  }

  for (const [position, track] of selected.entries()) {
    // Continues the numbering past the tombstones, so an event's index still reads against
    // the progress counter and the total.
    const index = position + missing.length;
    if (options.signal?.aborted) {
      report.stopped = true;
      log.info("Download stopped by request", { after: index, of: report.total });
      break;
    }

    options.onProgress?.({
      index: index + 1,
      total: report.total,
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
    const upgrade = matched && options.upgrade ? await considerUpgrade(matched, track, options, ledger) : undefined;

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

    log.info(`[${index + 1}/${report.total}] ${label(track)}${upgrade ? " (upgrade)" : ""}`);

    try {
      // Unreachable on a dry run: the loop `continue`s above before it gets here.
      const destination = join(config.libraryDir, await directories.resolve(track.path));

      if (upgrade) {
        const result = await replace(config, session!, track, destination, upgrade, options.quality);

        // Remember what TIDAL actually served. `unavailable` says nothing about quality, so
        // it is not recorded — a track that becomes entitled later deserves another look.
        if (result.outcome !== "unavailable") {
          // A replacement `replace` could not read is recorded as no better than what was
          // already here — that is the conclusion it acted on, and leaving it unrecorded
          // would put the track back in the queue every run with the same answer waiting.
          await ledger?.record(track.tidalId, upgrade.to, result.achieved ?? upgrade.from.tier);
        }

        if (result.outcome === "unavailable") {
          report.unavailable += 1;
          emit("unavailable", "TIDAL served only a preview at every tier");
          fallback.push({ tidalId: track.tidalId, index: index + 1, track });
        } else if (result.outcome === "not-better") {
          report.skipped += 1;
          report.skippedByTier[upgrade.tier] += 1;
          report.alreadyBest += 1;
          log.info("Kept the existing file — TIDAL's copy was no better", {
            track: label(track),
            existing: describeQuality(upgrade.from),
            expected: upgrade.to,
            served: result.achieved ?? "unreadable",
          });
          emit(
            "skipped",
            `TIDAL served ${result.achieved ?? "an unreadable file"}, no better than ` +
              `${describeQuality(upgrade.from)}`,
            library.relative(upgrade.path),
          );
        } else {
          report.upgraded += 1;
          report.upgradedFrom[upgrade.from.tier] += 1;
          log.info("Replaced with a better copy", {
            track: label(track),
            from: describeQuality(upgrade.from),
            to: result.achieved,
          });
          emit(
            "upgraded",
            `${describeQuality(upgrade.from)} → ${result.achieved}`,
            relative(config.libraryDir, result.path),
          );
        }
      } else {
        const written = await downloadTrack(session!, track.tidalId, destination, options.quality);

        if (!written) {
          report.unavailable += 1;
          emit("unavailable", "TIDAL served only a preview at every tier");
          fallback.push({ tidalId: track.tidalId, index: index + 1, track });
        } else {
          report.downloaded += 1;
          emit("downloaded", undefined, relative(config.libraryDir, written));

          // A fresh download settles this account's entitlement for this track just as well
          // as an upgrade attempt would, and it is free here — one local ffprobe rather than
          // a second fetch of the same audio on the next run.
          if (ledger) {
            const landed = await probeQuality(written);
            const aimed = attainableTier(track.mediaTags, options.quality);
            if (landed) await ledger.record(track.tidalId, aimed, landed.tier);
          }
        }
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
            `tracks — stopping instead of working through ${selected.length - position - 1} more. ` +
            `Last error: ${message}`,
        );
      }
    }

    await sleep(config.tidal.downloadDelayMs, options.signal);
  }

  // Everything TIDAL would not serve, tried on Soulseek. Skipped entirely on a dry run, which
  // has promised to contact nothing, and when slskd is unconfigured — which is the default.
  if (config.slskd.url && !options.dryRun) {
    // Which bucket each candidate was counted in during the TIDAL pass, so resolving one
    // takes it out of the right one. A rescued tombstone is not an `unavailable` that
    // stopped being unavailable.
    const countedAs = new Map(
      fallback.map((candidate) => [candidate.tidalId, candidate.track ? "unavailable" : "missing"] as const),
    );

    report.soulseek = await runFallback(config, fallback, {
      signal: options.signal,
      // The library index this run already built. Soulseek is the only place a delisted
      // track can be recognised as already downloaded, because it is the only place its
      // name is known.
      alreadyHave: (track) => {
        const found = library.find(track);
        return found && allowedTiers.has(found.tier) ? library.relative(found.path) : undefined;
      },
      onOutcome: (outcome) => {
        const resolved = outcome.status === "downloaded" || outcome.status === "present";
        if (resolved) {
          if (countedAs.get(outcome.tidalId) === "unavailable") {
            report.unavailable = Math.max(0, report.unavailable - 1);
          } else {
            report.missing = Math.max(0, report.missing - 1);
          }
        }

        // A fetched track counts as downloaded because that is what it is — it is in the
        // library now — and `soulseek` on the event says where it came from.
        if (outcome.status === "downloaded") report.downloaded += 1;
        if (outcome.status === "present") report.skipped += 1;

        options.onEvent?.({
          index: outcome.index,
          track: outcome.track,
          outcome:
            outcome.status === "downloaded" ? "soulseek" : outcome.status === "present" ? "skipped" : "failed",
          detail: `soulseek: ${outcome.detail}`,
          path: outcome.path,
        });
      },
    });
    logFallbackReport(report.soulseek);
  }

  return report;
}

function logFallbackReport(report: FallbackReport): void {
  log.info("Soulseek fallback finished", { ...report });

  if (report.alreadyPresent > 0) {
    log.info("Some were already in the library from an earlier run and were not fetched again", {
      alreadyPresent: report.alreadyPresent,
    });
  }

  if (report.unsearchable > 0) {
    log.warn(
      "Some delisted tracks could not be searched for: the snapshot has no ISRC for them, so " +
        "there is no way to find out what they were called",
      { unsearchable: report.unsearchable },
    );
  }

  if (report.queued > 0) {
    log.info("Some transfers are still queued on slskd; a later run will file them", {
      queued: report.queued,
    });
  }
}

/** An upgrade worth attempting: what is on disk, what a download should beat it with. */
type Upgrade = {
  from: LocalQuality;
  to: QualityTier;
  /** Absolute path of the file that would be replaced. */
  path: string;
  /** How the library index matched it, so a declined upgrade can still be counted as a skip. */
  tier: MatchTier;
};

/**
 * Decides whether TIDAL's copy of a track is worth trying to beat the one on disk with.
 *
 * Compares against what a download would *actually* produce — the best TIDAL offers, capped
 * by the quality asked for — rather than against TIDAL's catalogue entry, so a lossless run
 * never claims it is about to upgrade a FLAC to hi-res and then writes 16-bit.
 *
 * That is still only a claim about the catalogue, and the catalogue is not the account: see
 * `src/upgrades.ts` for why a run that has already been disappointed by a track must not
 * keep being optimistic about it.
 */
async function considerUpgrade(
  existing: { path: string; tier: MatchTier },
  track: ExportedTrack,
  options: DownloadOptions,
  ledger: UpgradeLedger | undefined,
): Promise<Upgrade | undefined> {
  const from = await probeQuality(existing.path);
  if (!from) return undefined;

  const to = attainableTier(track.mediaTags, options.quality);
  if (rank(to) <= rank(from.tier)) return undefined;

  if (ledger?.settled(track.tidalId, to, from.tier)) {
    log.debug("Not re-attempting an upgrade TIDAL has already declined to serve", {
      track: label(track),
      existing: describeQuality(from),
      wanted: to,
    });
    return undefined;
  }

  // Carries the path and tier so the branches that act on an upgrade need not re-narrow the
  // match they came from.
  return { from, to, path: existing.path, tier: existing.tier };
}

/**
 * What came of trying to replace a file.
 *
 * `not-better` is the case that only exists because entitlement cannot be known in advance:
 * TIDAL served the track, and once it was on disk it turned out to be no improvement.
 */
type ReplaceResult =
  | { outcome: "replaced"; path: string; achieved: QualityTier }
  | { outcome: "not-better"; achieved: QualityTier | undefined }
  | { outcome: "unavailable" };

/**
 * Downloads a better copy, checks it really is one, and only then retires the old file.
 *
 * The old file is moved into `DATA_DIR/replaced/`, mirroring its path in the library, rather
 * than deleted — this is the one operation that destroys something the user already had, and
 * a judgement about "better" made from a codec name deserves an undo. It also leaves the
 * library with exactly one copy, which a deletion-free approach would not: the new file
 * usually lands under a different extension, so keeping both would show up as a duplicate in
 * whatever is serving the library.
 *
 * The candidate is fetched to a scratch name beside where it would live rather than over the
 * file it hopes to replace, and the existing copy is not touched until the new one is on disk
 * *and* has been read back and found better. That covers all three ways an upgrade fails to
 * arrive — the download throws, TIDAL serves a preview, or the file that lands is no
 * improvement — with the original never having moved, and it means a run killed mid-download
 * leaves a stray dotfile rather than a hole in the library.
 *
 * The last of those three is the one that matters most, because it is routine rather than
 * exotic: `mediaTags` promise what the *catalogue* holds, not what this subscription may
 * stream. Without reading the result back, a `hires` run on an account without the hi-res
 * tier quietly rewrites the library with byte-identical 16-bit FLAC, and does it again every
 * run — see `src/upgrades.ts`.
 */
async function replace(
  config: Config,
  session: DeviceSession,
  track: ExportedTrack,
  destination: string,
  upgrade: Upgrade,
  quality: Quality,
): Promise<ReplaceResult> {
  // Leading dot, so a scanner watching the library ignores whatever a crash leaves behind.
  // `downloadTrack` picks the extension itself — it walks down tiers — so the real target is
  // only known once something has actually been written.
  const scratch = join(dirname(destination), `${UPGRADE_PREFIX}${process.pid}-${basename(destination)}`);

  const written = await downloadTrack(session, track.tidalId, scratch, quality);
  if (!written) return { outcome: "unavailable" };

  // An unreadable replacement is treated exactly like a worse one. `considerUpgrade` refuses
  // to judge a file it cannot probe; the same reticence has to apply to the file that wants
  // to take its place, or the one check that cannot describe what it wrote wins by default.
  const landed = await probeQuality(written);
  if (!landed || rank(landed.tier) <= rank(upgrade.from.tier)) {
    await rm(written, { force: true });
    return { outcome: "not-better", achieved: landed?.tier };
  }

  // Retire first, then move in: the two can be the same path when the extension has not
  // changed, and a rename within one directory is not something that fails halfway.
  const target = withExtension(destination, extname(written));
  await retire(config, upgrade.path);
  await mkdir(dirname(target), { recursive: true });
  await rename(written, target);

  return { outcome: "replaced", path: target, achieved: landed.tier };
}

/**
 * Puts the superseded file where it can be recovered from, or deletes it when no
 * `replacedDir` is configured.
 *
 * Never throws. The replacement is already on disk and about to take the name, so a retire
 * that cannot happen is a lost undo rather than a failed upgrade — but it is not a reason to
 * leave two copies of the track in the library either, which is what a bare rethrow would do.
 */
async function retire(config: Config, path: string): Promise<void> {
  if (!config.replacedDir) {
    await rm(path, { force: true });
    return;
  }

  const retired = join(config.replacedDir, relative(config.libraryDir, path));

  try {
    await mkdir(dirname(retired), { recursive: true });
    await rename(path, retired);
    await stamp(retired);
  } catch (error) {
    // A `replacedDir` on another filesystem is the expected reason — rename cannot cross one.
    // Copying is slower but it is the difference between keeping the undo and losing it.
    try {
      await Bun.write(retired, Bun.file(path));
      await rm(path, { force: true });
      await stamp(retired);
    } catch (copyError) {
      log.warn("Replaced the file but could not retire the old copy, so it was deleted", {
        path,
        to: retired,
        error: String((error as NodeJS.ErrnoException).code === "EXDEV" ? copyError : error),
      });
      await rm(path, { force: true });
    }
  }
}

/**
 * Marks a retired file with the moment it was retired, which is what `pruneRetired` ages it
 * out on.
 *
 * A file's own mtime is when it was *written* — for a rip from 2014, a decade before anything
 * replaced it. Pruning on that would delete the file the instant it was retired and take the
 * undo with it, so the clock has to start when the file arrives here.
 */
async function stamp(path: string): Promise<void> {
  const now = new Date();
  await utimes(path, now, now).catch((error: unknown) => {
    // Not fatal — the file is retired either way — but it does mean this one will be judged
    // on the age of the recording rather than the age of the decision, so say so out loud.
    log.warn("Could not stamp a retired file with its retire time; it may be pruned early", {
      path,
      error: String(error),
    });
  });
}

/** `Title.flac` + `.m4a` -> `Title.m4a`. Mirrors what `downloadTrack` does to its target. */
function withExtension(path: string, extension: string): string {
  return path.replace(/\.[^./]*$/, "") + extension;
}

/**
 * Clears transient files left by a run that did not get to finish.
 *
 * Nothing here is reachable in normal operation — every path that writes one of these
 * removes it, on success and on failure alike. It exists for the kill: `daemon` exits on
 * SIGTERM without waiting for the download to reach a track boundary, so every container
 * restart, redeploy or crash during a scheduled backup strands a partial file in the library,
 * and nothing else would ever tidy it up. Downloads only became unattended when they went on
 * the schedule, which is what makes this worth having.
 *
 * The names it matches are ones only this tool writes — see `RAW_SUFFIX` in
 * `tidal/download.ts` for why they look the way they do. Anything tagged with *this* pid is
 * left alone, so a run cannot delete a file it is in the middle of writing.
 */
async function sweepInterrupted(libraryDir: string): Promise<void> {
  const removed: string[] = [];

  const walk = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }

      const match = INTERRUPTED.exec(entry.name);
      if (!match) continue;
      // Its own in-flight work, from a concurrent run in this process. Not ours to remove.
      if (Number(match[1] ?? match[2]) === process.pid) continue;

      try {
        await rm(path, { force: true });
        removed.push(relative(libraryDir, path));
      } catch (error) {
        log.warn("Could not remove a leftover from an interrupted run", { path, error: String(error) });
      }
    }
  };

  await walk(libraryDir);

  if (removed.length > 0) {
    log.info("Cleared leftovers from a run that was interrupted", { files: removed.length });
    for (const path of removed) log.debug("Removed leftover", { path });
  }
}

/**
 * Ages retired files out of `replacedDir`.
 *
 * That directory is the undo for the one operation that destroys something you already had,
 * so it is deliberately not cleared as soon as the replacement lands. But it is also where
 * most of a library ends up if you upgrade most of a library — gigabytes — and nothing else
 * would ever remove any of it.
 *
 * A retention window rather than a weekly wipe: emptying it every Sunday would give a file
 * retired on Saturday night one day of undo and a file retired on Monday a full seven, where
 * this gives every file the same week no matter when it arrived. Run from `runDownload`, so
 * it happens wherever retiring happens — on every daemon tick, and on a one-off CLI run.
 */
async function pruneRetired(config: Config): Promise<void> {
  if (!config.replacedDir || config.replacedRetentionDays <= 0) return;

  const cutoff = Date.now() - config.replacedRetentionDays * 24 * 60 * 60 * 1000;
  let files = 0;
  let bytes = 0;

  /** Returns true when the directory was removed, so a parent knows it lost a child. */
  const walk = async (directory: string, isRoot: boolean): Promise<boolean> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }

    let kept = 0;
    for (const entry of entries) {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!(await walk(path, false))) kept += 1;
        continue;
      }

      try {
        const info = await stat(path);
        // mtime, because `stamp` set it to the moment the file was retired. Deliberately not
        // ctime: `stamp` bumps that too, so nothing that has ever been stamped could age.
        if (info.mtimeMs >= cutoff) {
          kept += 1;
          continue;
        }
        await rm(path, { force: true });
        files += 1;
        bytes += info.size;
      } catch (error) {
        kept += 1;
        log.warn("Could not prune a retired file", { path, error: String(error) });
      }
    }

    // An upgraded library otherwise leaves a skeleton of empty Artist/Album folders behind
    // for ever. The root stays regardless — the next retire needs somewhere to put things.
    if (kept > 0 || isRoot) return false;
    await rmdir(directory).catch(() => {});
    return true;
  };

  await walk(config.replacedDir, true);

  if (files > 0) {
    log.info("Pruned replaced files past their retention window", {
      files,
      megabytes: Math.round(bytes / 1_000_000),
      retentionDays: config.replacedRetentionDays,
      directory: config.replacedDir,
    });
  }
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

/**
 * Resolves the requested source to an ordered, de-duplicated list of tracks, plus the ids of
 * the ones the snapshot could not describe.
 *
 * Those are reported rather than quietly dropped. A tombstoned track is one TIDAL would not
 * return metadata for when the snapshot was taken — delisted since you favourited it, or
 * region-locked out of `TIDAL_COUNTRY_CODE` — so there is no artist, album or title, and
 * therefore no path to write a file to. They are also the most interesting tracks in a
 * collection, being the ones that stopped existing, and a download that silently left them
 * out of its own arithmetic was the last place you would notice.
 */
function select(manifest: ExportManifest, options: DownloadOptions): { tracks: ExportedTrack[]; missing: string[] } {
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
  const missing: string[] = [];

  for (const trackId of trackIds) {
    if (seen.has(trackId)) continue;
    seen.add(trackId);

    const track = manifest.tracks[trackId];
    if (!track) {
      missing.push(trackId);
      continue;
    }

    tracks.push(track);
    // The limit caps what is fetched, and stopping here rather than slicing afterwards keeps
    // a limited run describing the stretch of the collection it actually looked at instead of
    // reporting every tombstone in the whole of it.
    if (options.limit && tracks.length >= options.limit) break;
  }

  return { tracks, missing };
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

  if (report.missing > 0) {
    log.warn(
      "Some tracks are in the source list but carry no metadata in the snapshot, so they were " +
        "never attempted — delisted since you favourited them, or not available in your " +
        "country. The export records them as tombstones with their ids",
      { missing: report.missing },
    );
  }
}

export { DownloadError };
