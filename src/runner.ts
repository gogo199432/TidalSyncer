import type { Config } from "./config.ts";
import { type FavoritesReport, runFavoritesSync } from "./favorites.ts";
import { log } from "./logger.ts";
import type { RunRecord, RunTrigger, SyncStore } from "./store.ts";
import { runSync, type SyncOptions, type SyncReport } from "./sync.ts";

/** Live view of the runner, for the dashboard. */
export type RunnerSnapshot = {
  running: boolean;
  /** When the in-flight run started, if one is in flight. */
  runningSince?: string;
  runningTrigger?: RunTrigger;
  /** Reports from the most recent run *of this process*, so they reset on restart. */
  lastSync?: SyncReport;
  lastFavorites?: FavoritesReport;
  lastRun?: RunRecord;
};

/**
 * One place that runs a sync — the playlist direction, then favourites if enabled — and
 * remembers how it went. The CLI, the daemon's cron tick and the dashboard's "sync now"
 * all go through here, so a manual trigger can never overlap a scheduled one.
 */
export class SyncRunner {
  private active: { startedAt: string; trigger: RunTrigger } | undefined;
  private lastSync: SyncReport | undefined;
  private lastFavorites: FavoritesReport | undefined;
  private lastRun: RunRecord | undefined;

  constructor(
    private readonly config: Config,
    private readonly store: SyncStore,
  ) {}

  get running(): boolean {
    return this.active !== undefined;
  }

  snapshot(): RunnerSnapshot {
    return {
      running: this.running,
      runningSince: this.active?.startedAt,
      runningTrigger: this.active?.trigger,
      lastSync: this.lastSync,
      lastFavorites: this.lastFavorites,
      lastRun: this.lastRun,
    };
  }

  /**
   * Runs once, unless a run is already in flight — then this returns `undefined` rather
   * than queueing, because two concurrent runs would write the same TIDAL playlists.
   *
   * Never throws: a failing run is recorded and reported, so a bad tick cannot kill the
   * daemon and the next one simply retries.
   */
  async run(trigger: RunTrigger, options: SyncOptions = {}): Promise<RunRecord | undefined> {
    if (this.active) {
      log.warn("Sync already running, ignoring trigger", {
        trigger,
        since: this.active.startedAt,
      });
      return undefined;
    }

    const startedAt = new Date();
    const startedAtMs = Date.now();
    this.active = { startedAt: startedAt.toISOString(), trigger };

    let playlists = { synced: 0, unchanged: 0, skipped: 0, failed: 0 };
    let favorites: RunRecord["favorites"];
    let error: string | undefined;

    try {
      const report = await runSync(this.config, this.store, options);
      this.lastSync = report;
      playlists = tally(report);
      logSyncReport(report);

      if (this.config.syncFavorites) {
        const favoritesReport = await runFavoritesSync(this.config, this.store);
        this.lastFavorites = favoritesReport;
        favorites = {
          recordings: favoritesReport.recordings,
          loved: favoritesReport.loved,
          failed: favoritesReport.failed,
        };
        logFavoritesReport(favoritesReport);
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      log.error("Sync run failed", { trigger, error });
      if (caught instanceof Error && caught.stack) log.debug("Stack", { stack: caught.stack });
    } finally {
      this.active = undefined;
    }

    const record: RunRecord = {
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAtMs,
      trigger,
      playlists,
      ...(favorites ? { favorites } : {}),
      ...(error ? { error } : {}),
    };
    this.lastRun = record;

    // History is a nicety; losing it must not turn a good run into a failed one.
    try {
      await this.store.recordRun(record);
    } catch (caught) {
      log.warn("Could not record run history", { error: String(caught) });
    }

    return record;
  }
}

/**
 * How long to wait before each retry of the startup sync. Roughly a minute in total, which
 * is the scale of the problem it exists for — a pod's network being a few seconds behind its
 * process — without turning a genuinely offline host into a retry loop.
 */
export const STARTUP_RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

/**
 * The daemon's sync-on-startup, retried.
 *
 * A container's first seconds are the least likely moment in its life for it to have working
 * egress: an orchestrator starts the process as soon as the image is unpacked, and the pod's
 * network — the CNI finishing its routes, the DNS service becoming reachable — can be a
 * second or two behind. The first TIDAL call then fails on connect, and this run exists
 * precisely so that a fresh deploy is useful without waiting for the first tick. Taking that
 * one failure and going quiet until the next tick, up to six hours later on the default
 * schedule, defeats the whole point of it.
 *
 * Only a whole-run failure is retried. A run that finished but had a playlist fail has
 * already done most of its work, and repeating it would re-mirror the ones that went fine.
 */
export async function syncOnStartup(
  runner: Pick<SyncRunner, "run">,
  options: SyncOptions = {},
  delays: number[] = STARTUP_RETRY_DELAYS_MS,
): Promise<RunRecord | undefined> {
  for (let attempt = 0; ; attempt += 1) {
    const record = await runner.run("startup", options);
    if (!record?.error) return record;

    const delay = delays[attempt];
    if (delay === undefined) {
      log.warn("Startup sync never got through; leaving it to the schedule", { error: record.error });
      return record;
    }

    log.warn("Startup sync failed; retrying", {
      error: record.error,
      attempt: attempt + 1,
      retryInMs: delay,
    });
    await Bun.sleep(delay);
  }
}

/** True when the run had anything go wrong — the CLI's exit code. */
export function runFailed(record: RunRecord | undefined): boolean {
  if (!record) return false;
  return Boolean(record.error) || record.playlists.failed > 0 || (record.favorites?.failed ?? 0) > 0;
}

function tally(report: SyncReport): RunRecord["playlists"] {
  const count = (status: string) =>
    report.outcomes.filter((outcome) => outcome.status === status).length;
  return {
    synced: count("synced"),
    unchanged: count("unchanged"),
    skipped: count("skipped"),
    failed: count("failed"),
  };
}

function logSyncReport(report: SyncReport): void {
  log.info("Sync finished", { ...tally(report), durationMs: report.durationMs });

  for (const outcome of report.outcomes) {
    if (outcome.status === "failed") {
      log.error("Playlist failed", { sourcePatch: outcome.sourcePatch, error: outcome.error });
      continue;
    }
    if (outcome.unmatched?.length) {
      log.info("Unmatched tracks", {
        sourcePatch: outcome.sourcePatch,
        count: outcome.unmatched.length,
      });
    }
    if (outcome.inCollection) {
      log.info("Already in collection", {
        sourcePatch: outcome.sourcePatch,
        count: outcome.inCollection,
      });
    }
  }
}

export function logFavoritesReport(report: FavoritesReport): void {
  log.info(report.dryRun ? "Favourites finished (dry run)" : "Favourites finished", {
    collection: report.collectionTracks,
    recordings: report.recordings,
    byIsrc: report.matchedByIsrc,
    byName: report.matchedByName,
    alreadyLoved: report.alreadyLoved,
    loved: report.loved,
    failed: report.failed,
    durationMs: report.durationMs,
  });

  if (report.unresolved.length > 0) {
    log.info("Not found on MusicBrainz", { count: report.unresolved.length });
    for (const track of report.unresolved) log.debug("Unresolved favourite", { track });
  }
}
