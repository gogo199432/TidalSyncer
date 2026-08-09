import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../config.ts";
import type { ExportedTrack } from "../export.ts";
import { runFallback, type FallbackOutcome } from "./fallback.ts";

/**
 * The whole fallback, against a fake slskd that behaves like the real one: it accepts a
 * search, answers with peers, accepts an enqueue, and — crucially — actually writes the file
 * where slskd would write it, under the peer's own folder beneath the destination. That last
 * detail is the one this tool does not control and has to cope with.
 */

const TRACK: ExportedTrack = {
  tidalId: "3",
  title: "Glory Box",
  artists: ["Portishead"],
  album: "Dummy",
  duration: 301,
  path: "Portishead/Dummy/Glory Box.flac",
};

/** What the fake slskd will do next. Each test sets these before calling runFallback. */
let responses: unknown[] = [];
/** "succeed" writes the file and reports success; "slow" never finishes; "error" fails it. */
let transferMode: "succeed" | "slow" | "error" = "succeed";
let enqueued: Array<{ username: string; filename: string; destination: string }> = [];
let searches: string[] = [];

let root: string;
let config: Config;
let server: Bun.Server<undefined>;

/** Where the fake writes, mirroring slskd's `${SOURCE_DIRECTORY}` layout. */
function landingPath(destination: string, filename: string): string {
  const parts = filename.split("\\");
  const peerFolder = parts.length > 1 ? parts[parts.length - 2]! : "shared";
  return join(root, "library", destination, peerFolder, parts[parts.length - 1]!);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "slskd-fallback-"));
  await mkdir(join(root, "library"), { recursive: true });
  await mkdir(join(root, "data"), { recursive: true });
  responses = [];
  transferMode = "succeed";
  enqueued = [];
  searches = [];

  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/api/v0/searches" && request.method === "POST") {
        searches.push(((await request.json()) as { searchText: string }).searchText);
        return Response.json({ id: "x" });
      }
      if (path.startsWith("/api/v0/searches/") && request.method === "GET") {
        return Response.json({ isComplete: true, state: "Completed, TimedOut", responses });
      }
      if (path.startsWith("/api/v0/searches/") && request.method === "DELETE") {
        return new Response(null, { status: 204 });
      }

      if (path === "/api/v0/transfers/downloads/batches" && request.method === "POST") {
        const body = (await request.json()) as {
          username: string;
          files: Array<{ filename: string }>;
          options: { destination: string };
        };
        const filename = body.files[0]!.filename;
        enqueued.push({ username: body.username, filename, destination: body.options.destination });

        if (transferMode === "succeed") {
          const target = landingPath(body.options.destination, filename);
          await mkdir(join(target, ".."), { recursive: true });
          await writeFile(target, "audio bytes");
        }
        return Response.json({ id: "batch" });
      }

      if (path.startsWith("/api/v0/transfers/downloads/") && request.method === "GET") {
        const last = enqueued.at(-1);
        if (!last) return Response.json([]);
        const state =
          transferMode === "succeed"
            ? "Completed, Succeeded"
            : transferMode === "error"
              ? "Completed, Errored"
              : "InProgress";
        // Nested the way slskd nests it, to exercise the flattening.
        return Response.json([
          { directory: "whatever", files: [{ id: "t1", filename: last.filename, state }] },
        ]);
      }

      return new Response("not found", { status: 404 });
    },
  });

  Object.assign(process.env, {
    LISTENBRAINZ_USER: "tester",
    TIDAL_CLIENT_ID: "c",
    TIDAL_CLIENT_SECRET: "s",
    DATA_DIR: join(root, "data"),
    LIBRARY_DIR: join(root, "library"),
    SLSKD_URL: `http://127.0.0.1:${server.port}`,
    SLSKD_API_KEY: "test-key-at-least-16-chars",
    SLSKD_SEARCH_TIMEOUT_MS: "5000",
    // Short, so the "still queued" path is reachable without the test taking minutes.
    SLSKD_TRANSFER_TIMEOUT_MS: "2500",
    LOG_LEVEL: "error",
  });
  config = loadConfig();
});

afterEach(async () => {
  await server.stop(true);
  await rm(root, { recursive: true, force: true });
});

afterAll(() => {
  for (const key of ["SLSKD_URL", "SLSKD_API_KEY", "SLSKD_SEARCH_TIMEOUT_MS", "SLSKD_TRANSFER_TIMEOUT_MS"]) {
    delete process.env[key];
  }
});

const peer = (username: string, filename: string, extra: Record<string, unknown> = {}) => ({
  username,
  hasFreeUploadSlot: true,
  queueLength: 0,
  uploadSpeed: 1_000_000,
  files: [{ filename, size: 40 * 1024 * 1024, ...extra }],
});

const collect = async () => {
  const outcomes: FallbackOutcome[] = [];
  const report = await runFallback(config, [{ tidalId: "3", index: 1, track: TRACK }], {
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  return { report, outcomes };
};

const libraryFiles = async (): Promise<string[]> => {
  const found: string[] = [];
  const walk = async (directory: string, prefix: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const next = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), next);
      else found.push(next);
    }
  };
  await walk(join(root, "library"), "");
  return found.sort();
};

describe("a track TIDAL would not serve", () => {
  test("is searched for, fetched, and filed under the name the library expects", async () => {
    responses = [peer("goodpeer", "@@x\\Portishead - Dummy\\05 Glory Box.flac")];

    const { report, outcomes } = await collect();

    expect(searches).toEqual(["portishead glory box"]);
    expect(enqueued[0]).toMatchObject({ username: "goodpeer", destination: "Portishead/Dummy" });
    expect(report.downloaded).toBe(1);
    expect(outcomes[0]?.status).toBe("downloaded");

    // The peer's filename and folder are gone; what is left is the library's own layout.
    expect(await libraryFiles()).toEqual(["Portishead/Dummy/Glory Box.flac"]);
    expect(await readFile(join(root, "library", TRACK.path), "utf8")).toBe("audio bytes");
  });

  test("keeps the extension that actually arrived rather than the one the export assumed", async () => {
    responses = [peer("goodpeer", "@@x\\Portishead\\Glory Box.mp3")];

    await collect();

    // export.json always says .flac; writing an mp3 under that name would defeat the library
    // index and lie to whatever is serving the files.
    expect(await libraryFiles()).toEqual(["Portishead/Dummy/Glory Box.mp3"]);
  });

  test("reports nothing found rather than taking the nearest thing", async () => {
    responses = [peer("peer", "@@x\\Portishead\\Sour Times.flac")];

    const { report, outcomes } = await collect();

    expect(report.notFound).toBe(1);
    expect(report.downloaded).toBe(0);
    expect(enqueued).toHaveLength(0);
    expect(outcomes[0]?.detail).toContain("none convincingly");
  });

  test("says so plainly when nobody answers at all", async () => {
    responses = [];
    const { report, outcomes } = await collect();
    expect(report.notFound).toBe(1);
    expect(outcomes[0]?.detail).toContain("nobody answered");
  });
});

describe("transfers that do not finish while the run is waiting", () => {
  test("are left running and written down, not cancelled", async () => {
    responses = [peer("slowpeer", "@@x\\Portishead\\Glory Box.flac")];
    transferMode = "slow";

    const { report, outcomes } = await collect();

    // Cancelling would mean never getting the slow ones, which for a track TIDAL will not
    // serve usually means never getting it at all.
    expect(report.queued).toBe(1);
    expect(outcomes[0]?.status).toBe("queued");

    const ledger = JSON.parse(await readFile(join(root, "data", "slskd-pending.json"), "utf8"));
    expect(ledger.transfers["3"]).toMatchObject({
      username: "slowpeer",
      target: "Portishead/Dummy/Glory Box.flac",
    });
  }, 20_000);

  test("are filed by the next run once they have finished", async () => {
    responses = [peer("slowpeer", "@@x\\Portishead\\Glory Box.flac")];
    transferMode = "slow";
    await collect();
    expect(await libraryFiles()).toEqual([]);

    // The transfer finished between runs, so the file is now sitting there under the peer's
    // name and the next run's first job is to give it the right one.
    transferMode = "succeed";
    const target = landingPath("Portishead/Dummy", "@@x\\Portishead\\Glory Box.flac");
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "audio bytes");

    const report = await runFallback(config, [], {});

    expect(await libraryFiles()).toEqual(["Portishead/Dummy/Glory Box.flac"]);
    const ledger = JSON.parse(await readFile(join(root, "data", "slskd-pending.json"), "utf8"));
    expect(ledger.transfers).toEqual({});
    expect(report.considered).toBe(0);
  });

  test("are not queued a second time while still in flight", async () => {
    responses = [peer("slowpeer", "@@x\\Portishead\\Glory Box.flac")];
    transferMode = "slow";
    await collect();
    expect(enqueued).toHaveLength(1);

    const { report } = await collect();

    expect(enqueued).toHaveLength(1);
    expect(report.queued).toBe(1);
  }, 20_000);
});

describe("a transfer that goes wrong", () => {
  test("is reported as failed rather than left looking queued", async () => {
    responses = [peer("badpeer", "@@x\\Portishead\\Glory Box.flac")];
    transferMode = "error";

    const { report, outcomes } = await collect();

    expect(report.failed).toBe(1);
    expect(outcomes[0]?.detail).toContain("Completed, Errored");
  }, 20_000);
});

describe("a delisted track", () => {
  test("with nothing left to search for is reported, not silently dropped", async () => {
    const report = await runFallback(config, [{ tidalId: "99", index: 1, tombstone: { title: "Gone" } }], {});

    // A title with no artist is not something to search Soulseek with, and guessing would put
    // a stranger's unrelated file in the library.
    expect(report.unsearchable).toBe(1);
    expect(searches).toHaveLength(0);
  });
});
