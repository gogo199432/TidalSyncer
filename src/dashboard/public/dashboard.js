/**
 * Polls /api/status and paints the page. Slow when idle, quick while a sync is running,
 * with the countdown ticking locally in between so the clock never looks frozen.
 */

const IDLE_POLL_MS = 15_000;
const RUNNING_POLL_MS = 2_000;
/** Matches the store's run-history limit, so the strip is full once history is. */
const HISTORY_SLOTS = 30;

const $ = (id) => document.getElementById(id);
const root = document.documentElement;

/** Server time minus browser time, so a wrong client clock cannot skew the countdown. */
let clockOffsetMs = 0;
let nextRunAt = null;
let pollTimer;

/* ---------- formatting ---------- */

/** Fixed rather than the browser's, so times read in the same language as the page. */
const LOCALE = "en-GB";

const relative = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });
const UNITS = [
  ["year", 31_536_000_000],
  ["month", 2_592_000_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1000],
];

function ago(iso) {
  if (!iso) return "never";
  const delta = new Date(iso).getTime() - serverNow();
  for (const [unit, ms] of UNITS) {
    if (Math.abs(delta) >= ms || unit === "second") {
      return relative.format(Math.round(delta / ms), unit);
    }
  }
  return "just now";
}

function serverNow() {
  return Date.now() + clockOffsetMs;
}

function duration(ms) {
  if (ms == null) return "–";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const seconds = String(total % 60).padStart(2, "0");
  return `${String(hours).padStart(2, "0")}:${minutes}:${seconds}`;
}

function localTime(iso) {
  return new Date(iso).toLocaleString(LOCALE, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/* ---------- small DOM helpers ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function link(href, text) {
  const anchor = el("a", null, text);
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noreferrer noopener";
  return anchor;
}

function figure(value, label, quiet) {
  const wrap = el("div");
  wrap.append(el("p", `figure-value${quiet ? " is-quiet" : ""}`, value), el("p", "figure-label", label));
  return wrap;
}

/* ---------- rendering ---------- */

/** Worst thing that happened in a run, which is what its colour should say. */
function runTone(run) {
  if (!run) return "idle";
  if (run.error || run.playlists.failed > 0 || (run.favorites?.failed ?? 0) > 0) return "bad";
  if (run.playlists.skipped > 0) return "warn";
  return "good";
}

const OUTCOME_TONE = { synced: "good", unchanged: "good", skipped: "warn", failed: "bad" };

const painted = new Map();

function repaint(key, data, paint) {
  // The minute bucket keeps "synced 3 minutes ago" honest without repainting every poll.
  const signature = `${Math.floor(serverNow() / 60_000)}:${JSON.stringify(data)}`;
  if (painted.get(key) === signature) return;
  painted.set(key, signature);
  tooltip.hidden = true;
  paint(data);
}

function render(status) {
  root.dataset.state = status.running ? "running" : "idle";

  $("who").textContent = `listenbrainz/${status.user}`;
  $("dry-run-pill").hidden = !status.dryRun;

  renderSchedule(status);
  renderRunState(status);
  renderTiles(status);
  // These three rebuild their DOM, so only touch them when their data actually moved —
  // otherwise a poll every 15s would yank the card out from under the pointer.
  repaint("playlists", status.playlists, renderPlaylists);
  repaint("favorites", status.favorites, renderFavorites);
  repaint("runs", status.runs, renderHistory);
  // Not behind `repaint`: the progress line moves every poll while a download runs, and the
  // guard's minute-bucket signature would hold it still for up to a minute.
  renderBackup(status.backup);

  $("schedule-line").textContent = `${status.schedule.cron} · ${status.schedule.timezone}`;
  $("updated-line").textContent = `updated ${new Date().toLocaleTimeString(LOCALE)}`;
}

function renderSchedule(status) {
  nextRunAt = status.schedule.nextRun ? new Date(status.schedule.nextRun).getTime() : null;
  tickCountdown();

  $("next-detail").textContent = nextRunAt
    ? `${localTime(status.schedule.nextRun)} · ${status.schedule.timezone}`
    : "No further runs scheduled";
}

function tickCountdown() {
  const countdown = $("countdown");
  if (nextRunAt == null) {
    countdown.textContent = "--:--:--";
    return;
  }
  const remaining = nextRunAt - serverNow();
  countdown.textContent = remaining <= 0 ? "00:00:00" : clock(remaining);
  countdown.classList.toggle("is-due", remaining <= 0);
}

function renderRunState(status) {
  const button = $("run-now");
  button.disabled = status.running;
  button.querySelector(".run-button-label").textContent = status.running ? "Syncing" : "Sync now";

  const state = $("run-state");
  if (status.running) {
    const trigger = status.runningTrigger === "manual" ? "started by hand" : `${status.runningTrigger} run`;
    state.textContent = `Running — ${trigger}, ${ago(status.runningSince)}`;
    return;
  }

  const last = status.lastRun;
  if (!last) {
    state.textContent = "Idle · nothing synced yet";
    return;
  }
  state.textContent = last.error
    ? `Last run failed ${ago(last.startedAt)} — ${last.error}`
    : `Idle · last run ${ago(last.startedAt)} in ${duration(last.durationMs)}`;
}

function renderTiles(status) {
  const { totals, lastRun } = status;

  $("stat-families").textContent = totals.families;
  $("stat-families-note").textContent = totals.families === 1 ? "family" : "families";

  $("stat-tracks").textContent = totals.tracks;
  $("stat-tracks-note").textContent = "mirrored to TIDAL";

  $("stat-unmatched").textContent = totals.unmatched;
  $("stat-unmatched-note").textContent = "not found on TIDAL";

  $("stat-last").textContent = lastRun ? duration(lastRun.durationMs) : "–";
  $("stat-last-note").textContent = lastRun ? ago(lastRun.startedAt) : "never run";
}

function renderPlaylists(playlists) {
  const container = $("playlists");
  container.replaceChildren();

  if (playlists.length === 0) {
    container.append(el("p", "empty", "Nothing mirrored yet — the first sync will fill this in."));
    return;
  }

  for (const playlist of playlists) {
    container.append(playlistCard(playlist));
  }
}

function playlistCard(playlist) {
  const synced = Boolean(playlist.lastSyncedAt);
  const tone = playlist.lastStatus ? OUTCOME_TONE[playlist.lastStatus] : synced ? "idle" : "idle";
  const label = playlist.lastStatus ?? (synced ? "mirrored" : "pending");

  const card = el("article", "card");
  if (tone !== "idle") {
    card.style.setProperty("--edge", `var(--${tone === "good" ? "tide" : tone === "warn" ? "amber" : "coral"})`);
  }

  const top = el("div", "card-top");
  top.append(el("h3", "card-title", playlist.title), el("span", `chip chip-${tone}`, label));

  const figures = el("div", "card-figures");
  figures.append(
    figure(playlist.trackCount, "tracks"),
    figure(playlist.unmatchedCount, "unmatched", playlist.unmatchedCount === 0),
  );
  if (playlist.inCollection > 0) {
    figures.append(figure(playlist.inCollection, "owned"));
  }

  const foot = el("div", "card-foot");
  foot.append(el("span", null, synced ? `synced ${ago(playlist.lastSyncedAt)}` : "not synced yet"));

  const links = el("div", "card-links");
  if (playlist.tidalUrl) links.append(link(playlist.tidalUrl, "TIDAL"));
  if (playlist.listenBrainzUrl) links.append(link(playlist.listenBrainzUrl, "source"));
  foot.append(links);

  card.append(top, figures, foot);

  if (playlist.unmatched.length > 0) {
    attachTooltip(card, `Unmatched this run\n${playlist.unmatched.slice(0, 12).join("\n")}`);
  }

  return card;
}

function renderFavorites(favorites) {
  $("favorites-panel").hidden = !favorites.enabled;
  if (!favorites.enabled) return;

  const readout = $("favorites");
  readout.replaceChildren();

  const entry = (label, value, note) => {
    const block = el("div");
    block.append(el("p", "label", label), el("p", "readout-value", value));
    if (note) block.append(el("p", "tile-note", note));
    readout.append(block);
  };

  entry("Collection", favorites.collectionTracks, "tracks on TIDAL");
  entry("Resolved", favorites.resolved, "MusicBrainz recordings");
  entry("Loved", favorites.loved, "on the last run");
  entry("Unresolved", favorites.unresolved.count, "not on MusicBrainz");
  entry(
    "Last synced",
    favorites.lastSyncedAt ? localTime(favorites.lastSyncedAt) : "never",
    favorites.lastSyncedAt ? ago(favorites.lastSyncedAt) : "",
  );

  renderUnresolved(favorites.unresolved);
}

let unresolvedOpen = false;

/**
 * The tracks MusicBrainz could not place, behind a disclosure — the count belongs in the
 * readout, but a few hundred names must not be the tallest thing on the page.
 */
function renderUnresolved(unresolved) {
  const container = $("unresolved");
  container.replaceChildren();
  if (unresolved.count === 0) return;

  const details = el("details", "disclosure");
  // A repaint rebuilds this node, so carry the open state across rather than snapping a
  // list the user is reading shut.
  details.open = unresolvedOpen;
  details.addEventListener("toggle", () => {
    unresolvedOpen = details.open;
  });

  const summary = el("summary", null, `${plural(unresolved.count, "track")} MusicBrainz could not place`);
  const list = el("ul", "disclosure-list");

  for (const name of unresolved.names) {
    const item = el("li", null, name);
    // The list clips long titles to keep the columns even; the tooltip carries the rest.
    item.title = name;
    list.append(item);
  }
  if (unresolved.count > unresolved.names.length) {
    list.append(el("li", "is-muted", `… and ${unresolved.count - unresolved.names.length} more`));
  }

  details.append(summary, list);
  container.append(details);
}

function renderHistory(runs) {
  const bars = $("history-bars");
  bars.replaceChildren();

  if (runs.length === 0) {
    $("history-note").textContent = "no runs recorded yet";
    bars.append(el("p", "empty", "The first run will start the history."));
    return;
  }

  $("history-note").textContent = `${plural(runs.length, "run")} · newest on the right`;
  const longest = Math.max(...runs.map((run) => run.durationMs), 1);

  // Empty slots for the runs not recorded yet, so the strip always spans the panel and a
  // young history looks deliberate rather than stranded in the corner.
  for (let slot = runs.length; slot < HISTORY_SLOTS; slot += 1) {
    bars.append(el("div", "bar bar-empty"));
  }

  // Oldest to newest, so the strip reads left to right like a timeline.
  for (const run of [...runs].reverse()) {
    const tone = runTone(run);
    const bar = el("div", `bar bar-${tone}`);
    bar.style.height = `${Math.max(6, Math.round((run.durationMs / longest) * 100))}%`;
    attachTooltip(bar, describeRun(run));
    bars.append(bar);
  }
}

function describeRun(run) {
  const counts = Object.entries(run.playlists)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `${value} ${key}`)
    .join(" · ");

  const lines = [
    `${localTime(run.startedAt)} · ${run.trigger}`,
    `${duration(run.durationMs)} — ${counts || "no playlists"}`,
  ];
  if (run.favorites) {
    lines.push(`favourites: ${run.favorites.loved} loved of ${run.favorites.recordings}`);
  }
  if (run.error) lines.push(`failed: ${run.error}`);
  return lines.join("\n");
}

/* ---------- backup ---------- */

/** Set once, then left alone — repainting a field the user is editing would fight them. */
let backupDefaultsApplied = false;
/** Rebuild the source list only when the export actually changed. */
let playlistSignature = "";

function chip(id, tone, label) {
  const node = $(id);
  node.className = `chip chip-${tone}`;
  node.textContent = label;
}

function readout(id, entries) {
  const node = $(id);
  node.hidden = entries.length === 0;
  node.replaceChildren();

  for (const [label, value, note] of entries) {
    const block = el("div");
    block.append(el("p", "label", label), el("p", "readout-value", String(value)));
    if (note) block.append(el("p", "tile-note", note));
    node.append(block);
  }
}

function renderBackup(backup) {
  if (!backup) return;
  renderAuthStep(backup);
  renderExportStep(backup);
  renderDownloadStep(backup);
}

function renderAuthStep(backup) {
  const { state, verificationUri, userCode, expiresAt, error } = backup.auth;
  const step = $("step-auth");
  const button = $("auth-button");
  const label = button.querySelector(".run-button-label");

  step.classList.toggle("is-done", state === "authorised");
  step.classList.remove("is-waiting");
  $("device").hidden = state !== "pending";

  if (state === "pending") {
    $("device-link").href = verificationUri;
    $("device-link").textContent = verificationUri;
    $("device-code").textContent = userCode;
    const remaining = new Date(expiresAt).getTime() - serverNow();
    $("device-expiry").textContent =
      remaining > 0 ? `Code expires in ${clock(remaining)}` : "Code expired — start again.";
  }

  const view = {
    unconfigured: {
      tone: "idle",
      chip: "off",
      note:
        "TIDAL_DEVICE_CLIENT_ID is not set, so downloading is switched off. The developer-portal " +
        "client used for syncing cannot do this — see .env.example.",
      button: "Authorise",
      disabled: true,
    },
    "signed-out": {
      tone: "idle",
      chip: "signed out",
      note: "Authorising opens a code you approve on tidal.com. It is separate from the sync login.",
      button: "Authorise",
      disabled: false,
    },
    pending: {
      tone: "warn",
      chip: "waiting",
      note: "Waiting for you to approve the device…",
      button: "Waiting",
      disabled: true,
    },
    authorised: {
      tone: "good",
      chip: "authorised",
      note: "A playback session is stored. It refreshes itself; re-authorise only if it stops working.",
      button: "Re-authorise",
      disabled: false,
    },
    failed: {
      tone: "bad",
      chip: "failed",
      note: error ?? "Authorisation failed.",
      button: "Try again",
      disabled: false,
    },
  }[state];

  chip("auth-chip", view.tone, view.chip);
  $("auth-note").textContent = view.note;
  label.textContent = view.button;
  button.disabled = view.disabled;
}

function renderExportStep(backup) {
  const running = backup.running === "export";
  const { summary, lastRunAt, error } = backup.export;
  const step = $("step-export");

  step.classList.toggle("is-done", Boolean(summary) && !error);
  $("export-button").disabled = Boolean(backup.running);
  $("export-button").querySelector(".run-button-label").textContent = running ? "Exporting" : "Export now";

  if (running) {
    chip("export-chip", "warn", "running");
    $("export-note").textContent = "Reading playlists, the collection and every track's metadata…";
  } else if (error) {
    chip("export-chip", "bad", "failed");
    $("export-note").textContent = error;
  } else if (summary) {
    chip("export-chip", "good", "ready");
    $("export-note").textContent = `Snapshot taken ${ago(summary.exportedAt)}. Re-run it whenever your playlists change.`;
  } else {
    chip("export-chip", "idle", "never run");
    $("export-note").textContent =
      "Playlists, the collection and every ISRC — written to DATA_DIR/export. Downloading reads this.";
  }

  if (lastRunAt && !summary && !error) $("export-note").textContent = "Export produced nothing.";

  readout(
    "export-readout",
    summary
      ? [
          ["Playlists", summary.stats.playlists],
          ["Favourites", summary.stats.favorites, "tracks"],
          ["Unique", summary.stats.uniqueTracks, "tracks"],
          ["With ISRC", summary.stats.withIsrc, "re-resolvable"],
          ["Unresolved", summary.stats.unresolved, "tombstoned"],
        ]
      : [],
  );
}

function renderDownloadStep(backup) {
  const { summary } = backup.export;
  const { progress, report, request, error } = backup.download;
  const running = backup.running === "download";
  const step = $("step-download");

  applyDownloadDefaults(backup);
  syncPlaylistOptions(summary);

  // Everything downstream needs the export, dry runs included — the run is driven from it.
  const blocked = !summary
    ? "Run the export first — the download works from that snapshot, not from TIDAL directly."
    : !backup.ffmpeg
      ? "ffmpeg is not on PATH. FLAC arrives inside an MP4 container and cannot be unwrapped without it; the AAC tiers still work."
      : null;

  step.classList.toggle("is-waiting", !summary);
  for (const id of ["field-playlist", "field-quality", "field-skip-tier", "field-limit", "field-dry-run"]) {
    $(id).disabled = running;
  }

  const dryRun = $("field-dry-run").checked;
  const needsAuth = !dryRun && backup.auth.state !== "authorised";

  const button = $("download-button");
  button.disabled = running || Boolean(backup.running) || !summary || needsAuth;
  button.querySelector(".run-button-label").textContent = running ? "Downloading" : "Start download";
  button.querySelector(".run-button-spinner").classList.toggle("is-spinning", running);

  const stop = $("stop-button");
  stop.hidden = !running;
  stop.disabled = backup.stopping;
  stop.querySelector(".run-button-label").textContent = backup.stopping ? "Stopping" : "Stop";

  $("download-progress").hidden = !running || !progress;
  if (running && progress) {
    $("progress-fill").style.width = `${Math.round((progress.index / progress.total) * 100)}%`;
    $("progress-line").textContent = `${progress.index} / ${progress.total} · ${progress.track}`;
  }

  if (running) {
    chip("download-chip", "warn", request?.dryRun ? "dry run" : "running");
    $("download-note").textContent = `Writing to ${backup.libraryDir} · ${backup.defaults.delayMs}ms between tracks`;
  } else if (error) {
    chip("download-chip", "bad", "failed");
    $("download-note").textContent = error;
  } else if (needsAuth) {
    chip("download-chip", "idle", "needs a session");
    $("download-note").textContent = "Authorise a playback session above, or tick dry run to see the plan first.";
  } else if (blocked) {
    chip("download-chip", "idle", summary ? "no ffmpeg" : "needs an export");
    $("download-note").textContent = blocked;
  } else if (report) {
    chip("download-chip", report.failed > 0 ? "bad" : report.stopped ? "warn" : "good", report.stopped ? "stopped" : "done");
    $("download-note").textContent = describeReport(report, request, backup);
  } else {
    chip("download-chip", "idle", "idle");
    $("download-note").textContent = `Writing to ${backup.libraryDir}. A dry run contacts nothing.`;
  }

  readout(
    "download-readout",
    report
      ? [
          ["Downloaded", report.downloaded],
          ["Skipped", report.skipped, "already on disk"],
          ["Unavailable", report.unavailable, "preview only"],
          ["Failed", report.failed],
          ["Total", report.total, "considered"],
        ]
      : [],
  );
}

function describeReport(report, request, backup) {
  const parts = [];
  if (request?.dryRun) parts.push("Dry run — nothing was written.");
  if (report.stopped) parts.push("Stopped before the end of the list.");

  const tiers = report.skippedByTier;
  if (tiers && report.skipped > 0) {
    parts.push(
      `Skips matched: ${tiers.exact} exact, ${tiers["album-agnostic"]} album-agnostic, ${tiers.loose} loose.`,
    );
  }
  if (tiers?.loose > 0) {
    parts.push("Loose matches ignore bracketed suffixes, so a (Live) take can cover a studio one.");
  }
  if (report.unavailable > 0) {
    parts.push(`${plural(report.unavailable, "track")} were preview-only — the account is not entitled to them.`);
  }
  if (parts.length === 0) parts.push(`Everything in ${backup.libraryDir} is up to date.`);
  return parts.join(" ");
}

/** Seeds the form from the daemon's configured defaults, once, on the first status. */
function applyDownloadDefaults(backup) {
  if (backupDefaultsApplied) return;
  backupDefaultsApplied = true;
  $("field-quality").value = backup.defaults.quality;
  $("field-skip-tier").value = backup.defaults.skipTier;
}

function syncPlaylistOptions(summary) {
  const names = summary ? summary.playlists.map((playlist) => playlist.name) : [];
  const signature = names.join(" ");
  if (signature === playlistSignature) return;
  playlistSignature = signature;

  const select = $("field-playlist");
  const chosen = select.value;
  select.replaceChildren();

  const collection = el("option", null, "Collection (favourites)");
  collection.value = "";
  select.append(collection);

  for (const playlist of summary?.playlists ?? []) {
    const option = el("option", null, `${playlist.name} — ${plural(playlist.trackCount, "track")}`);
    option.value = playlist.name;
    select.append(option);
  }

  // Keep the user's choice across a re-export that still has that playlist.
  if (names.includes(chosen)) select.value = chosen;
}

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? payload.reason ?? `status ${response.status}`);
  return payload;
}

/** Reports a failed action in the step's own note, rather than a dialog or a silent no-op. */
async function action(noteId, run) {
  try {
    await run();
  } catch (error) {
    $(noteId).textContent = error.message;
  }
  setTimeout(refresh, 250);
}

$("auth-button").addEventListener("click", () => {
  $("auth-button").disabled = true;
  void action("auth-note", () => post("/api/backup/login"));
});

$("export-button").addEventListener("click", () => {
  $("export-button").disabled = true;
  void action("export-note", () => post("/api/backup/export"));
});

$("download-button").addEventListener("click", () => {
  $("download-button").disabled = true;
  void action("download-note", () =>
    post("/api/backup/download", {
      playlist: $("field-playlist").value || undefined,
      quality: $("field-quality").value,
      skipTier: $("field-skip-tier").value,
      limit: $("field-limit").value || undefined,
      dryRun: $("field-dry-run").checked,
    }),
  );
});

$("stop-button").addEventListener("click", () => {
  $("stop-button").disabled = true;
  void action("download-note", () => post("/api/backup/stop"));
});

// The button's enabled state depends on this, and waiting for the next poll to reflect a
// click of the checkbox feels broken.
$("field-dry-run").addEventListener("change", () => void refresh());

/* ---------- tooltip ---------- */

const tooltip = $("tooltip");

function attachTooltip(target, text) {
  target.addEventListener("pointerenter", () => {
    tooltip.textContent = text;
    tooltip.hidden = false;
  });
  target.addEventListener("pointermove", (event) => {
    const margin = 14;
    const x = Math.min(event.clientX + margin, window.innerWidth - tooltip.offsetWidth - margin);
    const y = Math.max(margin, event.clientY - tooltip.offsetHeight - margin);
    tooltip.style.transform = `translate(${Math.max(margin, x)}px, ${y}px)`;
  });
  target.addEventListener("pointerleave", () => {
    tooltip.hidden = true;
  });
}

/* ---------- polling ---------- */

async function refresh() {
  clearTimeout(pollTimer);
  try {
    const response = await fetch("/api/status", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`status ${response.status}`);

    const status = await response.json();
    clockOffsetMs = new Date(status.now).getTime() - Date.now();
    render(status);

    // A download moves a track at a time and a pending device code expires in minutes, so
    // either one earns the fast poll just as much as a running sync does.
    const busy =
      status.running || Boolean(status.backup?.running) || status.backup?.auth.state === "pending";
    pollTimer = setTimeout(refresh, busy ? RUNNING_POLL_MS : IDLE_POLL_MS);
  } catch (error) {
    root.dataset.state = "offline";
    $("run-state").textContent = `Cannot reach the daemon — ${error.message}`;
    pollTimer = setTimeout(refresh, RUNNING_POLL_MS);
  }
}

$("run-now").addEventListener("click", async () => {
  const button = $("run-now");
  button.disabled = true;
  try {
    const response = await fetch("/api/run", { method: "POST" });
    if (response.status === 409) $("run-state").textContent = "A sync is already running.";
  } catch (error) {
    $("run-state").textContent = `Could not start a sync — ${error.message}`;
  }
  // The run is asynchronous; the next poll picks up that it started.
  setTimeout(refresh, 250);
});

setInterval(tickCountdown, 1000);
refresh();
