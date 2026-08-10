import { afterAll, describe, expect, test } from "bun:test";
import { log, LOG_HISTORY_LIMIT, recentLogs, setLogLevel } from "./logger.ts";

/**
 * The log page reads this buffer, so what matters is that it holds exactly what the process
 * printed — no more, and nothing the console did not get.
 *
 * Every assertion is relative to a sequence number taken at the start of the test: the buffer
 * is process-wide, and anything else that logs while the suite runs lands in it too.
 */

/** Emits with the console quiet, for the tests that need hundreds of lines. */
function quietly(run: () => void): void {
  const { log: out, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    run();
  } finally {
    console.log = out;
    console.error = error;
  }
}

afterAll(() => {
  setLogLevel("info");
});

describe("what the buffer keeps", () => {
  test("keeps the line as the console got it, fields and all", () => {
    setLogLevel("info");
    const from = recentLogs().nextSeq;

    quietly(() => log.info("Download complete", { total: 3, stopped: false }));

    const entry = recentLogs(from).entries[0]!;
    expect(entry.level).toBe("info");
    expect(entry.text).toContain("INFO  Download complete total=3 stopped=false");
    // The timestamp is the line's own, not the moment the page asked for it.
    expect(entry.text.startsWith(entry.time)).toBe(true);
  });

  test("holds nothing the level kept off the console", () => {
    setLogLevel("warn");
    const from = recentLogs().nextSeq;

    quietly(() => {
      log.debug("not written");
      log.info("not written either");
      log.warn("written");
    });

    expect(recentLogs(from).entries.map((entry) => entry.level)).toEqual(["warn"]);
  });

  test("`since` returns only what the caller has not seen", () => {
    setLogLevel("info");
    const from = recentLogs().nextSeq;

    quietly(() => log.info("first"));
    const after = recentLogs(from);
    expect(after.entries).toHaveLength(1);

    quietly(() => log.info("second"));
    const next = recentLogs(after.nextSeq);
    expect(next.entries.map((entry) => entry.text.endsWith("second"))).toEqual([true]);
  });

  // A whole-collection download logs a line per track, so the window has to be a window.
  test("drops the oldest lines rather than growing without end", () => {
    setLogLevel("info");
    const from = recentLogs().nextSeq;

    quietly(() => {
      for (let index = 0; index < LOG_HISTORY_LIMIT + 50; index += 1) log.info(`line ${index}`);
    });

    const all = recentLogs();
    expect(all.entries).toHaveLength(LOG_HISTORY_LIMIT);
    // What fell out is visible in `oldestSeq`, which is how the page knows to say so rather
    // than running two distant timestamps together.
    expect(all.oldestSeq).toBeGreaterThan(from);
    expect(recentLogs(from).entries).toHaveLength(LOG_HISTORY_LIMIT);
  });
});
