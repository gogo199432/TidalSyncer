const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type LogLevel = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

/** One emitted line, kept so the dashboard can show what the process printed. */
export type LogEntry = {
  /** Monotonic within this process. The log page asks for everything after the last it has. */
  seq: number;
  time: string;
  level: LogLevel;
  /** The line exactly as it went to the console, so the page shows the log, not a rendering. */
  text: string;
};

/**
 * How many lines to keep for the log page.
 *
 * A whole-collection download logs a line per track, so this is a window rather than a
 * history — `docker logs` still has everything. Kept in memory on purpose: the daemon
 * already writes its log to stdout, and a second copy on disk would be one more thing to
 * rotate, size and lose track of.
 */
export const LOG_HISTORY_LIMIT = 2000;

const history: LogEntry[] = [];
let sequence = 0;

/**
 * Lines emitted after `since`, oldest first.
 *
 * `oldestSeq` is what the buffer still holds, so a caller that fell further behind than the
 * window can say how much it missed rather than quietly showing a log with a hole in it.
 */
export function recentLogs(since = 0): { entries: LogEntry[]; nextSeq: number; oldestSeq: number } {
  return {
    entries: since > 0 ? history.filter((entry) => entry.seq > since) : [...history],
    nextSeq: sequence,
    oldestSeq: history[0]?.seq ?? sequence + 1,
  };
}

function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString();
  const suffix = fields && Object.keys(fields).length > 0 ? ` ${format(fields)}` : "";
  const line = `${time} ${level.toUpperCase().padEnd(5)} ${message}${suffix}`;
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);

  sequence += 1;
  history.push({ seq: sequence, time, level, text: line });
  // Kept after the console write, so a line is never lost to a slow reader — the page can
  // only ever be behind, never ahead.
  if (history.length > LOG_HISTORY_LIMIT) history.splice(0, history.length - LOG_HISTORY_LIMIT);
}

function format(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => emit("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => emit("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit("error", message, fields),
};
