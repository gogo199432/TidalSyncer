import { join } from "node:path";
import type { Config } from "../config.ts";
import { humanizeSourcePatch } from "../listenbrainz.ts";
import { log } from "../logger.ts";
import type { SyncRunner } from "../runner.ts";
import type { SyncStore } from "../store.ts";

export type DashboardDeps = {
  config: Config;
  store: SyncStore;
  runner: SyncRunner;
  /** When the daemon's cron job fires next; `null` if it never will. */
  nextRun: () => Date | null;
};

/** Static files, resolved once. Anything not listed here is a 404, not a path to read. */
const ASSETS: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/dashboard.css": { file: "dashboard.css", type: "text/css; charset=utf-8" },
  "/dashboard.js": { file: "dashboard.js", type: "text/javascript; charset=utf-8" },
};

/**
 * Serves the status page and its two endpoints:
 *
 *   GET  /api/status  everything the page renders
 *   POST /api/run     trigger a sync now (409 while one is already running)
 *
 * There is no authentication — the page can start a sync, so keep it on a network you
 * trust, or bind it to localhost with `DASHBOARD_HOST`.
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
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
