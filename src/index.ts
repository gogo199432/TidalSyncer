#!/usr/bin/env bun
import { Cron } from "croner";
import { BackupRunner } from "./backup.ts";
import { ConfigError, type Config, loadConfig } from "./config.ts";
import { startDashboard } from "./dashboard/server.ts";
import { logDownloadReport, runDownload, DownloadError } from "./download.ts";
import { logExportReport, runExport } from "./export.ts";
import { runFavoritesSync } from "./favorites.ts";
import { log, setLogLevel } from "./logger.ts";
import { logFavoritesReport, runFailed, SyncRunner } from "./runner.ts";
import { SyncStore } from "./store.ts";
import { browserLogin, initAuth, NotAuthenticatedError, requireUserCredentials } from "./tidal/auth.ts";
import type { MatchTier } from "./library.ts";
import { DeviceAuthError, DeviceNotAuthenticatedError, DeviceSession } from "./tidal/device-auth.ts";
import type { Quality } from "./tidal/download.ts";

const USAGE = `listenbrainz-tidal-sync

Usage:
  bun run src/index.ts <command> [options]

Commands:
  login      Authorise this app with your TIDAL account (browser, one time only)
  sync       Mirror the ListenBrainz playlists into TIDAL, then favourites back (once)
  favorites  Only mirror the TIDAL collection back to ListenBrainz as loved recordings
  status     Show what is currently mirrored, without contacting TIDAL
  daemon     Sync on a schedule (SYNC_SCHEDULE, default every 6 hours), and serve the
             status dashboard on DASHBOARD_PORT (default 8081)

  export     Write a portable snapshot of your TIDAL curation to DATA_DIR/export:
             every owned playlist and the collection, as JSON plus .m3u8 files,
             with ISRCs so it stays resolvable after tracks are delisted
  download-login
             Authorise a playback session for 'download' (separate from 'login')
  download   Fetch audio for exported tracks into LIBRARY_DIR

Options:
  --force       With 'sync' or 'daemon': re-mirror even if ListenBrainz has no new edition
  --manual      With 'login': paste the redirected URL instead of catching it on a local port
  --unresolved  With 'status': also name the favourites MusicBrainz could not place
  --playlist=N  With 'download': fetch this exported playlist instead of the collection
  --quality=Q   With 'download': hires | lossless | high | low (default TIDAL_DOWNLOAD_QUALITY)
  --limit=N     With 'download': stop after N tracks
  --skip-tier=T With 'download': how closely a file already in LIBRARY_DIR must match
                before the track is skipped — exact | album-agnostic | loose
  --upgrade     With 'download': also replace files TIDAL has a better copy of. The old
                file moves to DATA_DIR/replaced rather than being deleted
  --dry-run     With 'download': list what would be fetched, contacting nothing
  --help        Show this message

Mirroring favourites back needs SYNC_FAVORITES=true and a LISTENBRAINZ_TOKEN.
Downloading needs TIDAL_DEVICE_CLIENT_ID and ffmpeg on PATH.
`;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args.find((arg) => !arg.startsWith("-"));
  const force = args.includes("--force");
  const manual = args.includes("--manual");
  const option = (name: string): string | undefined =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

  if (!command || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  const config = loadConfig();
  setLogLevel(config.logLevel);

  switch (command) {
    case "login":
      return await commandLogin(config, manual);
    case "sync":
      return await commandSync(config, force);
    case "favorites":
    case "favourites":
      return await commandFavorites(config);
    case "status":
      return await commandStatus(config, args.includes("--unresolved"));
    case "daemon":
      return await commandDaemon(config, force);
    case "export":
      return await commandExport(config);
    case "download-login":
      return await commandDownloadLogin(config);
    case "download":
      return await commandDownload(config, {
        quality: (option("quality") ?? config.downloadQuality) as Quality,
        playlist: option("playlist"),
        limit: option("limit") ? Number(option("limit")) : undefined,
        dryRun: args.includes("--dry-run") || config.dryRun,
        skipTier: (option("skip-tier") ?? config.skipTier) as MatchTier,
        upgrade: args.includes("--upgrade") || config.upgrade,
      });
    default:
      console.error(`Unknown command "${command}"\n`);
      console.log(USAGE);
      return 1;
  }
}

async function commandLogin(config: Config, manual: boolean): Promise<number> {
  await initAuth(config);
  await browserLogin(config, manual);
  console.log("Authorised. You can now start the daemon.");
  return 0;
}

async function commandSync(config: Config, force: boolean): Promise<number> {
  await initAuth(config);
  await requireUserCredentials();

  const store = await SyncStore.open(config.dataDir);
  const runner = new SyncRunner(config, store);

  return runFailed(await runner.run("cli", { force })) ? 1 : 0;
}

async function commandFavorites(config: Config): Promise<number> {
  if (!config.syncFavorites) {
    console.error("Favourite syncing is off. Set SYNC_FAVORITES=true and LISTENBRAINZ_TOKEN.");
    return 78; // EX_CONFIG
  }

  await initAuth(config);
  await requireUserCredentials();

  const store = await SyncStore.open(config.dataDir);
  const report = await runFavoritesSync(config, store);
  logFavoritesReport(report);

  return report.failed > 0 ? 1 : 0;
}

async function commandStatus(config: Config, listUnresolved: boolean): Promise<number> {
  const store = await SyncStore.open(config.dataDir);
  const entries = store.allPlaylists();
  const favorites = store.getFavorites();

  if (entries.length === 0 && !favorites) {
    console.log("Nothing mirrored yet. Run `bun run sync`.");
    return 0;
  }

  for (const [sourcePatch, state] of entries) {
    console.log(`${sourcePatch}`);
    console.log(`  TIDAL playlist  ${state.tidalPlaylistId}`);
    console.log(`  Source edition  ${state.lastSourceMbid}`);
    console.log(`  Last synced     ${state.lastSyncedAt}`);
    console.log(`  Tracks          ${state.trackCount} (${state.unmatchedCount} unmatched)`);
    console.log("");
  }

  if (favorites) {
    console.log("favourites (TIDAL collection -> ListenBrainz loves)");
    console.log(`  Last synced     ${favorites.lastSyncedAt}`);
    console.log(`  Collection      ${favorites.collectionTracks} tracks`);
    console.log(`  Resolved        ${favorites.resolved} MusicBrainz recordings`);
    console.log(`  Loved that run  ${favorites.loved}`);

    if (favorites.unresolvedTotal) {
      console.log(`  Unresolved      ${favorites.unresolvedTotal} not found on MusicBrainz`);

      // Hundreds of names is the normal case on a big collection, so only on request.
      if (listUnresolved) {
        const names = favorites.unresolved ?? [];
        for (const track of names) console.log(`                    ${track}`);
        if (favorites.unresolvedTotal > names.length) {
          console.log(`                    … and ${favorites.unresolvedTotal - names.length} more`);
        }
      } else {
        console.log("                  (run with --unresolved to list them)");
      }
    }

    console.log("");
  }

  return 0;
}

async function commandExport(config: Config): Promise<number> {
  await initAuth(config);
  await requireUserCredentials();

  logExportReport(await runExport(config));
  return 0;
}

/**
 * Device flow, polled in the foreground. Unlike `login` this needs no local callback port,
 * which is why it works unchanged inside a container.
 */
async function commandDownloadLogin(config: Config): Promise<number> {
  const session = await DeviceSession.open(config);
  const authorization = await session.requestDeviceCode();

  console.log("");
  console.log("  Open this URL and approve the device:");
  console.log("");
  console.log(`    ${authorization.verificationUriComplete ?? authorization.verificationUri}`);
  console.log("");
  console.log(`  If prompted for a code, enter:  ${authorization.userCode}`);
  console.log("");
  console.log("  Waiting for approval ...");

  await session.pollForToken(authorization);
  console.log("Authorised. You can now run `bun run src/index.ts download`.");
  return 0;
}

async function commandDownload(config: Config, options: Parameters<typeof runDownload>[1]): Promise<number> {
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
    console.error("--limit must be a positive integer");
    return 64; // EX_USAGE
  }

  const report = await runDownload(config, options);
  logDownloadReport(report);
  return report.failed > 0 ? 1 : 0;
}

async function commandDaemon(config: Config, force: boolean): Promise<number> {
  await initAuth(config);
  await requireUserCredentials();

  const store = await SyncStore.open(config.dataDir);
  const runner = new SyncRunner(config, store);
  // Holds the device session and the export/download jobs the dashboard drives. Built even
  // when downloading is unconfigured, so the page can say so rather than omitting the panel.
  const backup = await BackupRunner.create(config);

  // The runner ignores a trigger that arrives mid-run, so a cron tick landing on top of a
  // long run — or of one started from the dashboard — is a no-op rather than a collision.
  const job = new Cron(config.schedule, { timezone: config.timezone }, () => {
    void runner.run("schedule", { force });
  });

  log.info("Daemon started", {
    schedule: config.schedule,
    timezone: config.timezone,
    nextRun: job.nextRun()?.toISOString() ?? "never",
  });

  const dashboard = config.dashboard.enabled
    ? startDashboard({ config, store, runner, backup, nextRun: () => job.nextRun() })
    : undefined;

  // Sync immediately so a fresh container is useful without waiting for the first tick.
  await runner.run("startup", { force });
  log.info("Waiting for next scheduled run", { nextRun: job.nextRun()?.toISOString() ?? "never" });

  const shutdown = (signal: string) => {
    log.info("Shutting down", { signal });
    job.stop();
    void dashboard?.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the process alive; croner holds its own timer but Bun needs a live handle.
  await new Promise<never>(() => {});
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`Configuration error: ${error.message}`);
    console.error("See the environment: block in docker-compose.yml for all settings.");
    process.exitCode = 78; // EX_CONFIG
  } else if (error instanceof NotAuthenticatedError || error instanceof DeviceNotAuthenticatedError) {
    console.error(error.message);
    process.exitCode = 77; // EX_NOPERM
  } else if (error instanceof DeviceAuthError || error instanceof DownloadError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    log.error("Fatal", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    process.exitCode = 1;
  }
}
