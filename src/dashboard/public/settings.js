/**
 * The settings page. Reads /api/settings, renders whatever the daemon says it has — the field
 * registry lives in src/settings.ts, so this file never lists a setting of its own — and posts
 * back only what changed.
 *
 * Deliberately not polling: this is a form, and a background repaint would overwrite what
 * someone is halfway through typing.
 */

const $ = (id) => document.getElementById(id);
const root = document.documentElement;

/** The daemon's last word. Every comparison for "has this changed" is against this. */
let snapshot = null;
/** key -> { field, read(), initial, row } for the controls currently on the page. */
const controls = new Map();
/** Settings the user has asked to hand back to the environment; posted as null. */
const resets = new Set();

const LOCALE = "en-GB";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/* ---------- values ---------- */

/**
 * Mirrors the tidying `SettingsService` does on save, so a field only counts as changed when
 * it would actually store something different. Without it `SYNC_FAVORITES=yes` in the
 * environment would read as an edit the moment the page drew the checkbox as "true".
 */
function normalize(field, value) {
  const trimmed = String(value ?? "").trim();

  switch (field.kind) {
    case "boolean":
      return ["1", "true", "yes"].includes(trimmed.toLowerCase()) ? "true" : "false";
    case "list":
      return trimmed
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .join(",");
    case "select": {
      const match = field.options?.find((option) => option.toLowerCase() === trimmed.toLowerCase());
      return match ?? trimmed;
    }
    default:
      return trimmed;
  }
}

/**
 * What a control should show.
 *
 * A text box left empty says "unset" perfectly well, with the built-in default as its
 * placeholder. A checkbox and a select cannot be empty — they always claim something — so
 * when neither layer sets the value they have to claim what the daemon will actually do,
 * which is the built-in default. Drawing `BACKUP_ON_SCHEDULE` as "off" because nobody set it
 * would be the page lying about a backup that does in fact run.
 */
function shown(field) {
  // Tested before normalising, because a boolean normalises an unset value to "false" — which
  // is a claim, not the absence of one.
  if (field.value) return normalize(field, field.value);
  return ["boolean", "select"].includes(field.kind) ? normalize(field, field.fallback) : "";
}

/**
 * What to post: only the fields that moved, plus a null for each reset.
 *
 * Measured against what the control was drawn with rather than against the setting's stored
 * value, which are not always the same string: a select whose setting is unset still has to
 * show *something*, and a secret is always drawn empty. Comparing against the drawing is what
 * makes "unsaved changes" mean the page differs from the daemon.
 */
function patch() {
  const changes = {};

  for (const [key, control] of controls) {
    if (resets.has(key)) {
      changes[key] = null;
      continue;
    }

    const value = control.read();
    if (value !== control.initial) changes[key] = value;
  }

  return changes;
}

/* ---------- rendering ---------- */

function render(next) {
  snapshot = next;
  resets.clear();
  controls.clear();

  const container = $("groups");
  container.replaceChildren();
  for (const group of snapshot.groups) container.append(renderGroup(group));

  $("loading").hidden = true;
  $("savebar").hidden = false;
  $("settings-path").textContent = snapshot.path;
  $("saved-line").textContent = snapshot.updatedAt
    ? `Last saved ${new Date(snapshot.updatedAt).toLocaleString(LOCALE)}.`
    : "Nothing saved here yet — every value below is coming from the environment.";

  renderFooter();
  refreshSaveState();
}

function renderFooter() {
  const find = (key) =>
    snapshot.groups.flatMap((group) => group.fields).find((field) => field.key === key);
  const schedule = find("SYNC_SCHEDULE");
  const timezone = find("TZ");

  $("schedule-line").textContent = `${schedule?.value || schedule?.fallback} · ${timezone?.value || timezone?.fallback}`;
  $("updated-line").textContent = `read ${new Date().toLocaleTimeString(LOCALE)}`;
}

function renderGroup(group) {
  const panel = el("section", "panel");
  const head = el("div", "panel-head");
  head.append(el("h2", null, group.name), el("p", "panel-note", group.note));

  const list = el("div", "settings-list");
  for (const field of group.fields) list.append(renderSetting(field));

  panel.append(head, list);
  return panel;
}

const SOURCE_CHIP = {
  file: ["good", "saved here"],
  env: ["idle", "from the environment"],
  default: ["idle", "built-in default"],
};

function renderSetting(field) {
  const row = el("div", "setting");
  const id = `set-${field.key}`;

  const label = el("div", "setting-label");
  const caption = el("label", "setting-name", field.label);
  caption.htmlFor = id;
  const [tone, text] = SOURCE_CHIP[field.source];

  const badges = el("div", "setting-badges");
  badges.append(el("span", `chip chip-${tone}`, text));
  if (field.restart) {
    const restart = el("span", "chip chip-warn", "needs a restart");
    restart.title = "Read once while starting up. Saving it keeps it for the next start.";
    badges.append(restart);
  }
  label.append(caption, el("p", "setting-key", field.key), badges);

  const control = el("div", "setting-control");
  const input = buildInput(field, id);
  control.append(input.node, el("p", "setting-help", field.help));

  const origin = el("p", "setting-origin");
  origin.append(originText(field));

  // Only worth offering when there is an override to drop; the row says where the value came
  // from either way.
  if (field.overridden) {
    const reset = el("button", "link-button", "reset");
    reset.type = "button";
    reset.addEventListener("click", () => {
      resets.add(field.key);
      input.set(field.envValue);
      row.classList.add("is-reset");
      reset.remove();
      refreshSaveState();
    });
    origin.append(" · ", reset);
  }

  control.append(origin);
  row.append(label, control);
  controls.set(field.key, { field, read: input.read, initial: input.read(), row });
  return row;
}

/** Says what a reset would fall back to — the point of the environment layer being visible. */
function originText(field) {
  if (field.kind === "secret") {
    const stored = field.overridden ? "Saved here" : field.set ? "Set in the environment" : "Not set";
    return `${stored} · write-only: it is never sent back to this page`;
  }
  if (field.overridden) {
    return field.envValue
      ? `The environment says "${field.envValue}"`
      : "The environment does not set this";
  }
  // Nothing to add: the chip says the value is the built-in default, and the control is
  // already showing it — as a placeholder in a text box, as its own state in a checkbox.
  return "";
}

function buildInput(field, id) {
  if (field.kind === "boolean") {
    const wrap = el("label", "toggle toggle-tight");
    const box = el("input");
    box.type = "checkbox";
    box.id = id;
    box.checked = shown(field) === "true";
    const state = el("span", null, box.checked ? "on" : "off");
    wrap.append(box, state);

    box.addEventListener("change", () => {
      state.textContent = box.checked ? "on" : "off";
      refreshSaveState();
    });

    return {
      node: wrap,
      read: () => (box.checked ? "true" : "false"),
      set: (value) => {
        box.checked = (value ? normalize(field, value) : shown({ ...field, value: "" })) === "true";
        state.textContent = box.checked ? "on" : "off";
      },
    };
  }

  if (field.kind === "select") {
    const select = el("select");
    select.id = id;
    for (const option of field.options ?? []) {
      const node = el("option", null, option);
      node.value = option;
      select.append(node);
    }
    select.value = shown(field);
    select.addEventListener("change", () => refreshSaveState());
    return {
      node: select,
      read: () => select.value,
      set: (value) => {
        select.value = normalize(field, value) || shown({ ...field, value: "" });
      },
    };
  }

  const input = el("input");
  input.id = id;
  input.type = field.kind === "number" ? "number" : field.kind === "secret" ? "password" : "text";
  if (field.kind === "number") input.step = "1";
  if (field.kind === "secret") {
    input.autocomplete = "new-password";
    input.placeholder = field.set ? "•••••••• unchanged" : "not set";
  } else {
    input.value = field.value;
    input.placeholder = field.fallback;
  }
  input.addEventListener("input", () => refreshSaveState());

  return {
    node: input,
    read: () => input.value.trim(),
    set: (value) => {
      input.value = value;
    },
  };
}

/* ---------- saving ---------- */

/**
 * `quiet` leaves the note alone, for the one case where it already says something the count
 * must not overwrite: why a save was refused.
 */
function refreshSaveState(quiet = false) {
  const changes = Object.keys(patch());
  const note = $("save-note");

  for (const [key, control] of controls) {
    control.row.classList.toggle("is-changed", changes.includes(key) && !resets.has(key));
  }

  $("save-button").disabled = changes.length === 0;
  $("discard-button").disabled = changes.length === 0;
  if (quiet) return;

  note.className = "savebar-note";
  note.textContent =
    changes.length > 0
      ? `${changes.length} unsaved ${changes.length === 1 ? "change" : "changes"}`
      : "No changes";
}

async function save() {
  const changes = patch();
  const note = $("save-note");
  const button = $("save-button");

  button.disabled = true;
  note.className = "savebar-note";
  note.textContent = "Saving…";

  try {
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: changes }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `status ${response.status}`);

    // Which of the saved settings the running daemon cannot act on until it is restarted —
    // worth saying now rather than leaving someone waiting for a change that will not come.
    const saved = Object.keys(changes);
    const restart = snapshot.groups
      .flatMap((group) => group.fields)
      .filter((field) => saved.includes(field.key) && field.restart)
      .map((field) => field.key);

    render(payload);
    note.className = "savebar-note is-good";
    note.textContent = restart.length
      ? `Saved. ${restart.join(", ")} ${restart.length === 1 ? "takes" : "take"} effect when the daemon restarts.`
      : "Saved. The daemon is using these now.";
  } catch (error) {
    // Nothing was written — the daemon validates the whole overlay before it saves any of it —
    // so the form keeps every edit, and the note keeps the reason.
    refreshSaveState(true);
    note.className = "savebar-note is-bad";
    note.textContent = error.message;
  }
}

$("save-button").addEventListener("click", () => void save());
$("discard-button").addEventListener("click", () => {
  render(snapshot);
  $("save-note").textContent = "Changes discarded";
});

/* ---------- load ---------- */

async function load() {
  try {
    const response = await fetch("/api/settings", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`status ${response.status}`);
    render(await response.json());
    root.dataset.state = "idle";
  } catch (error) {
    root.dataset.state = "offline";
    $("loading").textContent = `Cannot reach the daemon — ${error.message}`;
  }
}

load();
