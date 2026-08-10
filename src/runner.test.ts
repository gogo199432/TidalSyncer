import { describe, expect, test } from "bun:test";
import { runFailed, syncOnStartup } from "./runner.ts";
import type { RunRecord } from "./store.ts";

/**
 * The startup sync runs in a container's first second, which is exactly when its network may
 * not be up yet — so it has to survive a failure that will not still be true in ten seconds.
 */

function record(error?: string): RunRecord {
  return {
    startedAt: new Date().toISOString(),
    durationMs: 1,
    trigger: "startup",
    playlists: { synced: 0, unchanged: 3, skipped: 0, failed: 0 },
    ...(error ? { error } : {}),
  };
}

/** A runner that answers with the given outcomes in order, counting the calls. */
function stub(outcomes: (RunRecord | undefined)[]) {
  const triggers: string[] = [];
  return {
    triggers,
    run: async (trigger: string) => {
      triggers.push(trigger);
      return outcomes[triggers.length - 1];
    },
  };
}

// The delays are the real ones in production; a test that waited them out would take a minute.
const QUICK = [1, 1, 1];

describe("the startup sync", () => {
  test("runs once when it gets through", async () => {
    const runner = stub([record()]);
    await syncOnStartup(runner as never, {}, QUICK);
    expect(runner.triggers).toEqual(["startup"]);
  });

  test("retries a run that failed outright, and stops as soon as one lands", async () => {
    const runner = stub([record("Unable to connect"), record("Unable to connect"), record()]);
    const result = await syncOnStartup(runner as never, {}, QUICK);

    expect(runner.triggers).toHaveLength(3);
    expect(result?.error).toBeUndefined();
  });

  test("gives up after the last delay rather than retrying an offline host for ever", async () => {
    const runner = stub(Array.from({ length: 10 }, () => record("Unable to connect")));
    const result = await syncOnStartup(runner as never, {}, QUICK);

    // One attempt per delay, plus the first one that is not a retry.
    expect(runner.triggers).toHaveLength(QUICK.length + 1);
    expect(result?.error).toBe("Unable to connect");
  });

  // A run that finished but had one playlist fail has already done most of its work; doing it
  // again would re-mirror the families that went fine.
  test("leaves a run that merely had a playlist fail to the schedule", async () => {
    const partial = record();
    partial.playlists = { synced: 1, unchanged: 1, skipped: 0, failed: 1 };
    const runner = stub([partial]);

    await syncOnStartup(runner as never, {}, QUICK);
    expect(runner.triggers).toHaveLength(1);
    expect(runFailed(partial)).toBe(true);
  });

  test("does not retry when another run was already in flight", async () => {
    // `undefined` is the runner refusing to start a second run, not a failure to retry.
    const runner = stub([undefined]);
    await syncOnStartup(runner as never, {}, QUICK);
    expect(runner.triggers).toHaveLength(1);
  });
});
