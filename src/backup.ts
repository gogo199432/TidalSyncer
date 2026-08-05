import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import {
  logDownloadReport,
  runDownload,
  type DownloadProgress,
  type DownloadReport,
} from "./download.ts";
import { logExportReport, runExport, type ExportManifest } from "./export.ts";
import type { MatchTier } from "./library.ts";
import { log } from "./logger.ts";
import { DeviceNotAuthenticatedError, DeviceSession } from "./tidal/device-auth.ts";
import type { Quality } from "./tidal/download.ts";

/**
 * The backup side of the daemon — device login, `export` and `download` — held as state a
 * long-lived process can expose and a browser can drive.
 *
 * The CLI runs each of these once and exits, which is fine at a terminal but useless from a
 * page: the device flow needs a code shown to the user *while* the daemon waits for them to
 * approve it, and a download of a whole collection runs for hours and has to be watchable
 * and stoppable. So all three become jobs with a snapshot, mirroring `SyncRunner`.
 *
 * Only one job runs at a time. Export writes `export.json` and download reads it, so letting
 * them overlap would have a download working from a file being rewritten underneath it.
 */

export type BackupJob = "export" | "download";

export type AuthState =
  /** No TIDAL_DEVICE_CLIENT_ID, so downloading is switched off entirely. */
  | "unconfigured"
  /** Configured, but no playback session stored yet. */
  | "signed-out"
  /** A device code has been issued and the daemon is waiting for it to be approved. */
  | "pending"
  | "authorised"
  /** The last attempt failed; `error` says how. */
  | "failed";

export type DownloadRequest = {
  quality: Quality;
  playlist?: string;
  limit?: number;
  skipTier: MatchTier;
  dryRun: boolean;
};

/** Enough of the export to drive the page, without shipping the whole manifest each poll. */
export type ExportSummary = {
  exportedAt: string;
  stats: ExportManifest["stats"];
  playlists: { name: string; trackCount: number }[];
};

export type BackupSnapshot = {
  libraryDir: string;
  /** FLAC arrives inside an MP4 container, so without ffmpeg only the AAC tiers work. */
  ffmpeg: boolean;
  defaults: { quality: Quality; skipTier: MatchTier; delayMs: number };
  auth: {
    state: AuthState;
    /** Where the user must go to approve the device. Only while `pending`. */
    verificationUri?: string;
    userCode?: string;
    expiresAt?: string;
    error?: string;
  };
  running: BackupJob | null;
  runningSince: string | null;
  /** A stop has been asked for and the run is finishing its current track. */
  stopping: boolean;
  export: {
    summary: ExportSummary | null;
    lastRunAt: string | null;
    error: string | null;
  };
  download: {
    progress: DownloadProgress | null;
    report: DownloadReport | null;
    request: DownloadRequest | null;
    finishedAt: string | null;
    error: string | null;
  };
};

export class BackupRunner {
  private active: { job: BackupJob; startedAt: string } | undefined;
  private controller: AbortController | undefined;

  private authState: AuthState = "signed-out";
  private authError: string | undefined;
  private pending: { verificationUri: string; userCode: string; expiresAt: string } | undefined;

  private exportSummary: ExportSummary | null = null;
  private exportRanAt: string | null = null;
  private exportError: string | null = null;

  private progress: DownloadProgress | null = null;
  private downloadReport: DownloadReport | null = null;
  private downloadRequest: DownloadRequest | null = null;
  private downloadFinishedAt: string | null = null;
  private downloadError: string | null = null;

  private constructor(
    private readonly config: Config,
    /**
     * Used only for the device flow and for reporting whether a session exists — never for
     * API calls. `runDownload` opens its own session from the same file, which keeps it
     * reading whatever the most recent login wrote and stops two instances refreshing the
     * same token against each other.
     */
    private session: DeviceSession,
  ) {}

  static async create(config: Config): Promise<BackupRunner> {
    const session = await DeviceSession.open(config);
    const runner = new BackupRunner(config, session);

    runner.authState = !config.tidal.deviceClientId
      ? "unconfigured"
      : session.isAuthenticated
        ? "authorised"
        : "signed-out";

    // Read once at startup rather than on every status poll: the manifest carries full
    // metadata for every track and can be megabytes.
    runner.exportSummary = await readExportSummary(config);

    return runner;
  }

  get running(): boolean {
    return this.active !== undefined;
  }

  snapshot(): BackupSnapshot {
    return {
      libraryDir: this.config.libraryDir,
      ffmpeg: Boolean(Bun.which("ffmpeg")),
      defaults: {
        quality: this.config.downloadQuality,
        skipTier: this.config.skipTier,
        delayMs: this.config.tidal.downloadDelayMs,
      },
      auth: {
        state: this.authState,
        ...(this.authState === "pending" ? this.pending : {}),
        ...(this.authError ? { error: this.authError } : {}),
      },
      running: this.active?.job ?? null,
      runningSince: this.active?.startedAt ?? null,
      stopping: Boolean(this.controller?.signal.aborted),
      export: {
        summary: this.exportSummary,
        lastRunAt: this.exportRanAt,
        error: this.exportError,
      },
      download: {
        progress: this.progress,
        report: this.downloadReport,
        request: this.downloadRequest,
        finishedAt: this.downloadFinishedAt,
        error: this.downloadError,
      },
    };
  }

  /**
   * Starts the device flow and returns the code straight away, then keeps polling in the
   * background until the user approves it or the code expires.
   *
   * The code is returned rather than only logged because the whole point is to put it on the
   * page. Note that whoever can see it can approve it with *their* TIDAL account, which
   * would leave the daemon holding a session for an account you did not intend — the same
   * reason the dashboard belongs on a trusted network.
   */
  async startLogin(): Promise<{ verificationUri: string; userCode: string; expiresAt: string }> {
    if (!this.config.tidal.deviceClientId) {
      throw new BackupError("TIDAL_DEVICE_CLIENT_ID is not set, so downloading is switched off.");
    }

    // A second click while a code is still live should show the same code, not burn it and
    // issue another that the first browser tab knows nothing about.
    if (this.authState === "pending" && this.pending && Date.parse(this.pending.expiresAt) > Date.now()) {
      return this.pending;
    }

    const authorization = await this.session.requestDeviceCode();
    const pending = {
      verificationUri: authorization.verificationUriComplete ?? authorization.verificationUri,
      userCode: authorization.userCode,
      expiresAt: new Date(Date.now() + authorization.expiresIn * 1000).toISOString(),
    };

    this.pending = pending;
    this.authState = "pending";
    this.authError = undefined;
    log.info("Device login started from the dashboard", { expiresAt: pending.expiresAt });

    // Deliberately not awaited: this blocks until the user finishes in their browser, and
    // the page polls /api/status to find out that they did.
    void this.session
      .pollForToken(authorization)
      .then(() => {
        this.authState = "authorised";
        this.pending = undefined;
      })
      .catch((error: unknown) => {
        this.authState = "failed";
        this.pending = undefined;
        this.authError = error instanceof Error ? error.message : String(error);
        log.warn("Device login failed", { error: this.authError });
      });

    return pending;
  }

  /** Starts an export. Returns false if another backup job is already running. */
  startExport(): boolean {
    if (this.active) return false;

    this.active = { job: "export", startedAt: new Date().toISOString() };
    this.exportError = null;

    void (async () => {
      try {
        const result = await runExport(this.config);
        logExportReport(result);
        this.exportSummary = summarize(result.manifest);
      } catch (error) {
        this.exportError = error instanceof Error ? error.message : String(error);
        log.error("Export failed", { error: this.exportError });
      } finally {
        this.exportRanAt = new Date().toISOString();
        this.active = undefined;
      }
    })();

    return true;
  }

  /** Starts a download. Returns false if another backup job is already running. */
  startDownload(request: DownloadRequest): boolean {
    if (this.active) return false;

    const controller = new AbortController();
    this.controller = controller;
    this.active = { job: "download", startedAt: new Date().toISOString() };
    this.downloadRequest = request;
    this.downloadReport = null;
    this.downloadError = null;
    this.downloadFinishedAt = null;
    this.progress = null;

    void (async () => {
      try {
        const report = await runDownload(this.config, {
          ...request,
          signal: controller.signal,
          onProgress: (progress) => {
            this.progress = progress;
          },
        });
        logDownloadReport(report);
        this.downloadReport = report;
      } catch (error) {
        this.downloadError = error instanceof Error ? error.message : String(error);
        log.error("Download failed", { error: this.downloadError });

        // A dead refresh token clears the stored session, so re-read it rather than leaving
        // the page claiming to be signed in when the next run would fail the same way.
        if (error instanceof DeviceNotAuthenticatedError) {
          this.session = await DeviceSession.open(this.config);
          this.authState = this.session.isAuthenticated ? "authorised" : "signed-out";
        }
      } finally {
        this.progress = null;
        this.downloadFinishedAt = new Date().toISOString();
        this.active = undefined;
        this.controller = undefined;
      }
    })();

    return true;
  }

  /** Asks a running download to stop after the current track. No-op for anything else. */
  stop(): boolean {
    if (this.active?.job !== "download" || !this.controller) return false;
    log.info("Download stop requested from the dashboard");
    this.controller.abort();
    return true;
  }
}

export class BackupError extends Error {}

function summarize(manifest: ExportManifest): ExportSummary {
  return {
    exportedAt: manifest.exportedAt,
    stats: manifest.stats,
    playlists: manifest.playlists.map((playlist) => ({
      name: playlist.name,
      trackCount: playlist.trackIds.length,
    })),
  };
}

/** Absent or unreadable is the normal first-run case, not an error worth surfacing. */
async function readExportSummary(config: Config): Promise<ExportSummary | null> {
  const path = join(config.dataDir, "export", "export.json");

  try {
    return summarize(JSON.parse(await readFile(path, "utf8")) as ExportManifest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("Could not read the existing export", { path, error: String(error) });
    }
    return null;
  }
}
