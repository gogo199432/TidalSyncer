import { join } from "node:path";
import { BackupError, type BackupRunner, type DownloadRequest } from "../backup.ts";
import type { Config } from "../config.ts";
import { humanizeSourcePatch } from "../listenbrainz.ts";
import type { MatchTier } from "../library.ts";
import { log } from "../logger.ts";
import type { SyncRunner } from "../runner.ts";
import type { SyncStore } from "../store.ts";
import { QUALITIES, type Quality } from "../tidal/download.ts";

export type DashboardDeps = {
  config: Config;
  store: SyncStore;
  runner: SyncRunner;
  /** Device login, export and download — the whole backup side of the page. */
  backup: BackupRunner;
  /** When the daemon's cron job fires next; `null` if it never will. */
  nextRun: () => Date | null;
};

const SKIP_TIERS: MatchTier[] = ["exact", "album-agnostic", "loose"];

/** Static files, resolved once. Anything not listed here is a 404, not a path to read. */
const ASSETS: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/dashboard.css": { file: "dashboard.css", type: "text/css; charset=utf-8" },
  "/dashboard.js": { file: "dashboard.js", type: "text/javascript; charset=utf-8" },
};

/**
 * Serves the status page and its endpoints:
 *
 *   GET  /api/status           everything the page renders
 *   POST /api/run              trigger a sync now (409 while one is already running)
 *   POST /api/backup/login     start the TIDAL device flow; returns the code to display
 *   POST /api/backup/export    snapshot playlists and the collection to DATA_DIR/export
 *   POST /api/backup/download  fetch audio into LIBRARY_DIR
 *   POST /api/backup/stop      stop a running download after the current track
 *
 * There is no authentication. That already mattered — the page can start a sync — and it
 * matters more now: these endpoints spend a TIDAL session, write files, and display a device
 * code that whoever can see it could approve with their own account. Keep it on a network
 * you trust, or bind it to localhost with `DASHBOARD_HOST`.
 */
export function startDashboard(deps: DashboardDeps): Bun.Server<undefined> {
  const { config } = deps;
  const publicDir = join(import.meta.dir, "public");

  const server = Bun.serve({
    hostname: config.dashboard.host,
    port: config.dashboard.port,
    fetch: async (request) => {
      const url = new URL(request.url);

      if (url.pathname === "/api/status" && request.method === "GET") {
        return json(buildStatus(deps));
      }

      if (url.pathname === "/api/run") {
        if (request.method !== "POST") return json({ error: "Use POST" }, 405);
        return triggerRun(deps, url);
      }

      if (url.pathname.startsWith("/api/backup/")) {
        if (request.method !== "POST") return json({ error: "Use POST" }, 405);
        return await handleBackup(deps, url.pathname.slice("/api/backup/".length), request);
      }

      const asset = ASSETS[url.pathname];
      if (!asset || request.method !== "GET") return json({ error: "Not found" }, 404);

      return new Response(Bun.file(join(publicDir, asset.file)), {
        headers: { "Content-Type": asset.type, "Cache-Control": "no-cache" },
      });
    },
  });

  log.info("Dashboard listening", {
    url: `http://${config.dashboard.host}:${config.dashboard.port}/`,
  });

  return server;
}

function triggerRun(deps: DashboardDeps, url: URL): Response {
  if (deps.runner.running) {
    return json({ started: false, reason: "already-running" }, 409);
  }

  const force = url.searchParams.get("force") === "true";
  log.info("Sync requested from the dashboard", { force });

  // Deliberately not awaited: a sync takes minutes, and the page polls /api/status for
  // progress. Errors are swallowed by the runner and surface as the run's `error`.
  void deps.runner.run("manual", { force });

  return json({ started: true, force }, 202);
}

async function handleBackup(deps: DashboardDeps, action: string, request: Request): Promise<Response> {
  const { backup } = deps;

  switch (action) {
    case "login":
      try {
        return json(await backup.startLogin(), 202);
      } catch (error) {
        // A refused device request is the expected failure here (no client id, or a client
        // id TIDAL will not accept), so report it rather than letting it 500.
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: message }, error instanceof BackupError ? 409 : 502);
      }

    case "export":
      return backup.startExport()
        ? json({ started: true }, 202)
        : json({ started: false, reason: "already-running" }, 409);

    case "download": {
      const parsed = await parseDownloadRequest(deps, request);
      if ("error" in parsed) return json({ error: parsed.error }, 400);

      // A dry run only reads the export and the library, so it stays available while signed
      // out — that is exactly when you want to see how much there is to do.
      if (!parsed.request.dryRun && backup.snapshot().auth.state !== "authorised") {
        return json({ error: "No playback session. Authorise the device first." }, 409);
      }

      return backup.startDownload(parsed.request)
        ? json({ started: true, request: parsed.request }, 202)
        : json({ started: false, reason: "already-running" }, 409);
    }

    case "stop":
      return backup.stop()
        ? json({ stopping: true }, 202)
        : json({ stopping: false, reason: "not-running" }, 409);

    default:
      return json({ error: "Not found" }, 404);
  }
}

/** Validates the form the page posts, so a bad field is a 400 and never a crashed daemon. */
async function parseDownloadRequest(
  deps: DashboardDeps,
  request: Request,
): Promise<{ request: DownloadRequest } | { error: string }> {
  let body: Record<string, unknown>;
  try {
    body = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return { error: "Body must be JSON" };
  }

  const quality = (body.quality as string) ?? deps.config.downloadQuality;
  if (!QUALITIES.includes(quality as Quality)) {
    return { error: `quality must be one of ${QUALITIES.join(", ")}` };
  }

  const skipTier = (body.skipTier as string) ?? deps.config.skipTier;
  if (!SKIP_TIERS.includes(skipTier as MatchTier)) {
    return { error: `skipTier must be one of ${SKIP_TIERS.join(", ")}` };
  }

  let limit: number | undefined;
  if (body.limit !== undefined && body.limit !== null && body.limit !== "") {
    limit = Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1) return { error: "limit must be a positive integer" };
  }

  const playlist = typeof body.playlist === "string" && body.playlist ? body.playlist : undefined;

  return {
    request: {
      quality: quality as Quality,
      skipTier: skipTier as MatchTier,
      limit,
      playlist,
      dryRun: Boolean(body.dryRun) || deps.config.dryRun,
    },
  };
}

function buildStatus(deps: DashboardDeps) {
  const { config, store, runner } = deps;
  const snapshot = runner.snapshot();
  const lastOutcomes = new Map(
    (snapshot.lastSync?.outcomes ?? []).map((outcome) => [outcome.sourcePatch, outcome]),
  );

  const mirrored = store.allPlaylists().map(([sourcePatch, state]) => {
    const outcome = lastOutcomes.get(sourcePatch);
    return {
      sourcePatch,
      title: humanizeSourcePatch(sourcePatch),
      tidalPlaylistId: state.tidalPlaylistId,
      tidalUrl: `https://tidal.com/playlist/${state.tidalPlaylistId}`,
      listenBrainzUrl: `https://listenbrainz.org/playlist/${state.lastSourceMbid}/`,
      lastSyncedAt: state.lastSyncedAt,
      trackCount: state.trackCount,
      unmatchedCount: state.unmatchedCount,
      /** Only set once this process has run a sync; `null` after a restart. */
      lastStatus: outcome?.status ?? null,
      unmatched: outcome?.unmatched ?? [],
      inCollection: outcome?.inCollection ?? 0,
    };
  });

  // Configured families ListenBrainz has not given us yet still deserve a card, so the
  // page shows the full expected set rather than silently omitting them.
  const known = new Set(mirrored.map((playlist) => playlist.sourcePatch));
  const pending = config.sourcePatchAllowlist
    .filter((sourcePatch) => !known.has(sourcePatch))
    .map((sourcePatch) => ({
      sourcePatch,
      title: humanizeSourcePatch(sourcePatch),
      tidalPlaylistId: null,
      tidalUrl: null,
      listenBrainzUrl: null,
      lastSyncedAt: null,
      trackCount: 0,
      unmatchedCount: 0,
      lastStatus: lastOutcomes.get(sourcePatch)?.status ?? null,
      unmatched: [],
      inCollection: 0,
    }));

  const playlists = [...mirrored, ...pending].sort((a, b) => a.title.localeCompare(b.title));
  const favoritesState = store.getFavorites();

  return {
    now: new Date().toISOString(),
    user: config.listenBrainzUser,
    dryRun: config.dryRun,
    schedule: {
      cron: config.schedule,
      timezone: config.timezone,
      nextRun: deps.nextRun()?.toISOString() ?? null,
    },
    running: snapshot.running,
    runningSince: snapshot.runningSince ?? null,
    runningTrigger: snapshot.runningTrigger ?? null,
    lastRun: snapshot.lastRun ?? store.recentRuns()[0] ?? null,
    playlists,
    totals: {
      families: playlists.length,
      tracks: playlists.reduce((sum, playlist) => sum + playlist.trackCount, 0),
      unmatched: playlists.reduce((sum, playlist) => sum + playlist.unmatchedCount, 0),
    },
    favorites: {
      enabled: config.syncFavorites,
      lastSyncedAt: favoritesState?.lastSyncedAt ?? null,
      collectionTracks: favoritesState?.collectionTracks ?? 0,
      resolved: favoritesState?.resolved ?? 0,
      loved: favoritesState?.loved ?? 0,
      /** From this process's last run only, so it is absent after a restart. */
      alreadyLoved: snapshot.lastFavorites?.alreadyLoved ?? null,
      /**
       * Tracks in the collection that MusicBrainz could not place. `names` is capped by
       * the store, so it can be shorter than `count`.
       */
      unresolved: {
        count: favoritesState?.unresolvedTotal ?? snapshot.lastFavorites?.unresolved.length ?? 0,
        names: favoritesState?.unresolved ?? snapshot.lastFavorites?.unresolved ?? [],
      },
    },
    runs: store.recentRuns(),
    /** Never carries a token — only whether one exists, and the device code while pending. */
    backup: deps.backup.snapshot(),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
