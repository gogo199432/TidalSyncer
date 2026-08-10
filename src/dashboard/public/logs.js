/**
 * Tails /api/logs.
 *
 * Asks only for what it has not seen — the daemon hands out a sequence number with every
 * line — so a page left open all day costs one small request per poll rather than the whole
 * buffer each time. New lines are appended to the <pre>; the list is only rebuilt when the
 * filters change, so following a running download does not re-lay-out a thousand rows a
 * second.
 */

const FOLLOWING_POLL_MS = 2_000;
const PAUSED_POLL_MS = 10_000;

const $ = (id) => document.getElementById(id);
const root = document.documentElement;

const LEVELS = ["debug", "info", "warn", "error"];
const LOCALE = "en-GB";

/** Everything fetched this session, oldest first, trimmed to what the daemon itself keeps. */
let entries = [];
let capacity = 2000;
let since = 0;
let pollTimer;

/** Show this level and worse. Not sent to the daemon: it has already written what it wrote. */
let minLevel = "debug";
let needle = "";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/* ---------- filtering ---------- */

function shows(entry) {
  if (LEVELS.indexOf(entry.level) < LEVELS.indexOf(minLevel)) return false;
  return needle === "" || entry.text.toLowerCase().includes(needle);
}

function line(entry) {
  // `dropped` markers are the page's own words, not the daemon's, and read as such.
  const node = el("span", entry.gap ? "log-line log-line-gap" : `log-line log-line-${entry.level}`, entry.text);
  return [node, document.createTextNode("\n")];
}

/* ---------- rendering ---------- */

function rebuild() {
  const log = $("log");
  log.replaceChildren();
  append(entries);
}

function append(fresh) {
  const log = $("log");
  const shown = fresh.filter(shows);
  if (shown.length === 0) return;

  const batch = document.createDocumentFragment();
  for (const entry of shown) batch.append(...line(entry));
  log.append(batch);
}

function refreshChrome() {
  const shown = entries.filter(shows).length;
  const filtered = shown !== entries.length;

  $("empty-note").hidden = entries.length === 0 ? false : shown > 0;
  $("empty-note").textContent =
    entries.length === 0
      ? "Nothing logged yet. The daemon writes a line when it starts a run, and one per track while it downloads."
      : "No line matches this filter.";

  $("count-line").textContent = filtered
    ? `${shown} of ${entries.length} lines shown`
    : `${entries.length} lines kept`;
  $("updated-line").textContent = `updated ${new Date().toLocaleTimeString(LOCALE)}`;
}

function renderLevels() {
  const container = $("levels");
  container.replaceChildren();

  for (const level of LEVELS) {
    const button = el("button", `chip chip-level chip-${level}${level === minLevel ? " is-on" : ""}`, level);
    button.type = "button";
    button.addEventListener("click", () => {
      minLevel = level;
      renderLevels();
      rebuild();
      refreshChrome();
      stick();
    });
    container.append(button);
  }
}

/* ---------- following ---------- */

/** True when the view is at the bottom, give or take a line. */
function atBottom() {
  const log = $("log");
  return log.scrollHeight - log.scrollTop - log.clientHeight < 24;
}

function stick() {
  if (!$("follow").checked) return;
  const log = $("log");
  log.scrollTop = log.scrollHeight;
}

/* ---------- polling ---------- */

async function poll() {
  clearTimeout(pollTimer);

  try {
    const response = await fetch(`/api/logs?since=${since}`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const payload = await response.json();

    root.dataset.state = "idle";
    capacity = payload.capacity ?? capacity;
    $("capacity").textContent = capacity;
    $("level").textContent = payload.level;
    $("stream-note").textContent = `keeping the last ${capacity} lines · level ${payload.level}`;

    const fresh = [];
    // Lines that fell out of the buffer while this page was not looking. Said once, in place,
    // rather than leaving two unrelated timestamps looking consecutive.
    if (payload.dropped > 0) {
      fresh.push({ seq: `gap-${since}`, level: "warn", gap: true, text: `… ${payload.dropped} lines dropped` });
    }
    fresh.push(...payload.entries);
    since = payload.nextSeq;

    if (fresh.length > 0) {
      const wasAtBottom = atBottom();
      entries.push(...fresh);

      // Trim to what the daemon holds, and rebuild rather than append when that trimmed
      // anything — the <pre> would otherwise grow for ever on a long-lived page.
      if (entries.length > capacity) {
        entries = entries.slice(-capacity);
        rebuild();
      } else {
        append(fresh);
      }

      if (wasAtBottom) stick();
    }

    refreshChrome();
    pollTimer = setTimeout(poll, $("follow").checked ? FOLLOWING_POLL_MS : PAUSED_POLL_MS);
  } catch (error) {
    root.dataset.state = "offline";
    $("stream-note").textContent = `Cannot reach the daemon — ${error.message}`;
    pollTimer = setTimeout(poll, FOLLOWING_POLL_MS);
  }
}

$("filter").addEventListener("input", (event) => {
  needle = event.target.value.trim().toLowerCase();
  rebuild();
  refreshChrome();
  stick();
});

$("follow").addEventListener("change", () => {
  stick();
  // Turning follow back on should catch up now, not at the end of the slow poll it was on.
  if ($("follow").checked) void poll();
});

// Scrolling away from the bottom is how anyone reading a live log says "hold still".
$("log").addEventListener("scroll", () => {
  if ($("follow").checked && !atBottom()) $("follow").checked = false;
});

renderLevels();
poll();
