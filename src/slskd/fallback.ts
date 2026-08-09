import type { Dirent } from "node:fs";
import { readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { Config } from "../config.ts";
import { DirectoryNames } from "../directories.ts";
import { libraryPathFor, type ExportedTrack, type Tombstone } from "../export.ts";
import { log } from "../logger.ts";
import { MusicBrainzClient } from "../musicbrainz.ts";
import { isSucceeded, SlskdClient, SlskdError, type SlskdTransfer } from "./client.ts";
import { extensionOf, pick, searchText, type WantedTrack } from "./match.ts";
import { PendingTransfers } from "./pending.ts";

/**
 * The second half of a download run: everything TIDAL would not serve, tried on Soulseek.
 *
 * Two kinds of track end up here, and they arrive knowing very different amounts about
 * themselves. An `unavailable` track has full metadata — TIDAL described it perfectly well
 * and then declined to stream it — so it can be searched for immediately. A tombstoned one
 * has an id and, if the collection listing happened to carry them, a title and an ISRC; the
 * ISRC goes to MusicBrainz to become a name, because a name is the only thing Soulseek
 * understands. Tombstones with neither cannot be looked for at all, and are reported as such
 * rather than quietly dropped.
 *
 * This runs after the TIDAL loop rather than inside it. Soulseek transfers are queued behind
 * strangers' upload slots and move on their own schedule, so mixing them into the per-track
 * loop would stall a run that is otherwise making steady progress.
 */

export type FallbackCandidate = {
  tidalId: string;
  /** Position in the run, so an event lines up with the one the TIDAL pass emitted. */
  index: number;
  /** Full metadata, for a track TIDAL described but would not serve. */
  track?: ExportedTrack;
  /** The scraps left of a delisted one. */
  tombstone?: Tombstone;
};

export type FallbackReport = {
  considered: number;
  /** Fetched from Soulseek and filed into the library. */
  downloaded: number;
  /** Searched, and nothing convincing came back. Worth trying again another day. */
  notFound: number;
  /** No artist and title could be recovered, so there was nothing to search with. */
  unsearchable: number;
  /** Enqueued and still transferring when the run ended. A later run files them. */
  queued: number;
  failed: number;
};

/** What happened to one track, for the caller to turn into an event and a log line. */
export type FallbackOutcome = {
  tidalId: string;
  index: number;
  track: string;
  status: "downloaded" | "not-found" | "unsearchable" | "queued" | "failed";
  detail: string;
  /** Library-relative, set when a file actually landed. */
  path?: string;
};

export type FallbackOptions = {
  onOutcome?: (outcome: FallbackOutcome) => void;
  signal?: AbortSignal;
};

/**
 * How often to ask slskd how a transfer is going. It is a service on your own network and
 * this only runs for tracks TIDAL refused, so the poll is cheap and there are never many.
 */
const TRANSFER_POLL_MS = 1000;

export async function runFallback(
  config: Config,
  candidates: FallbackCandidate[],
  options: FallbackOptions = {},
): Promise<FallbackReport> {
  const report: FallbackReport = {
    considered: candidates.length,
    downloaded: 0,
    notFound: 0,
    unsearchable: 0,
    queued: 0,
    failed: 0,
  };

  const client = new SlskdClient(config.slskd);
  const pending = await PendingTransfers.open(config.dataDir);
  // Same reconciliation the TIDAL half does: prefer the artist folder already on disk.
  const directories = new DirectoryNames(config.libraryDir);

  // Anything a previous run left running comes first: it may already be sitting finished in
  // the library under a stranger's filename, waiting to be given its proper one.
  await filePending(config, client, pending, options);

  if (candidates.length === 0) return report;

  const wanted = await resolveNames(config, candidates);

  log.info("Falling back to Soulseek", {
    tracks: candidates.length,
    searchable: wanted.size,
    stillQueued: pending.size,
  });

  for (const candidate of candidates) {
    if (options.signal?.aborted) break;

    const emit = (outcome: Omit<FallbackOutcome, "tidalId" | "index" | "track">) => {
      const named = wanted.get(candidate.tidalId);
      options.onOutcome?.({
        tidalId: candidate.tidalId,
        index: candidate.index,
        track: named ? `${named.track.artist} - ${named.track.title}` : `TIDAL track ${candidate.tidalId}`,
        ...outcome,
      });
    };

    const entry = wanted.get(candidate.tidalId);
    if (!entry) {
      report.unsearchable += 1;
      emit({ status: "unsearchable", detail: "no artist or title survived, so there is nothing to search for" });
      continue;
    }

    // Already in flight from an earlier run; leave it be rather than queueing a second copy.
    if (pending.has(candidate.tidalId)) {
      report.queued += 1;
      emit({ status: "queued", detail: "still transferring from an earlier run" });
      continue;
    }

    try {
      const target = await directories.resolve(entry.target);
      const outcome = await fetchOne(config, client, pending, candidate.tidalId, { ...entry, target }, options);
      report[outcome.counter] += 1;
      emit({ status: outcome.status, detail: outcome.detail, path: outcome.path });
    } catch (error) {
      report.failed += 1;
      const message = error instanceof SlskdError ? error.message : String(error);
      log.warn("Soulseek fallback failed for a track", { track: entry.track.title, error: message });
      emit({ status: "failed", detail: message });

      // A slskd that has stopped answering will fail every remaining track identically, and
      // there is no point spending a search timeout apiece proving it.
      if (error instanceof SlskdError && /could not reach|rejected the API key/.test(error.message)) {
        log.error("Giving up on the Soulseek fallback for this run", { error: message });
        break;
      }
    }
  }

  return report;
}

type Resolved = { track: WantedTrack; target: string };

/**
 * Works out what to search for, and where the result should end up.
 *
 * The ISRC lookups are batched into one MusicBrainz pass rather than done per track, because
 * MusicBrainz allows one request a second and a collection can have dozens of tombstones.
 */
async function resolveNames(config: Config, candidates: FallbackCandidate[]): Promise<Map<string, Resolved>> {
  const resolved = new Map<string, Resolved>();
  const needLookup: Array<{ tidalId: string; isrc: string }> = [];

  for (const candidate of candidates) {
    const track = candidate.track;
    if (track) {
      const artist = track.artists[0];
      if (artist && track.title) {
        resolved.set(candidate.tidalId, {
          track: { artist, title: track.title, duration: track.duration },
          target: track.path,
        });
      }
      continue;
    }

    const isrc = candidate.tombstone?.isrc;
    if (isrc) needLookup.push({ tidalId: candidate.tidalId, isrc });
  }

  if (needLookup.length === 0) return resolved;

  log.info("Asking MusicBrainz what the delisted tracks were called", { isrcs: needLookup.length });
  const client = new MusicBrainzClient(
    config.musicBrainzApiUrl,
    `listenbrainz-tidal-sync ( ${config.contactEmail} )`,
  );

  const names = await client.namesByIsrc(needLookup.map((entry) => entry.isrc));
  for (const { tidalId, isrc } of needLookup) {
    const name = names.get(isrc);
    if (!name) continue;
    resolved.set(tidalId, {
      track: { artist: name.artist, title: name.title },
      // No album survives a delisting, so these land under "Unknown Album" — which is at
      // least honest, and is where a later re-tag would look for them anyway.
      target: libraryPathFor(name.artist, undefined, name.title),
    });
  }

  return resolved;
}

type FetchResult = {
  status: FallbackOutcome["status"];
  counter: "downloaded" | "notFound" | "queued";
  detail: string;
  path?: string;
};

/** Search, choose, enqueue, and wait — up to a point. */
async function fetchOne(
  config: Config,
  client: SlskdClient,
  pending: PendingTransfers,
  tidalId: string,
  { track, target }: Resolved,
  options: FallbackOptions,
): Promise<FetchResult> {
  const responses = await client.search(searchText(track));
  const candidate = pick(responses, track, config.slskd.losslessOnly);

  if (!candidate) {
    const detail = responses.length === 0
      ? "nobody answered the search"
      : `${responses.length} peers answered, none convincingly`;
    return { status: "not-found", counter: "notFound", detail };
  }

  // Told to land beside where the TIDAL copy would have gone. slskd appends the peer's own
  // directory underneath, which is why the file is hunted for rather than assumed.
  const destination = dirname(target);
  await client.enqueue(candidate.username, candidate.file, destination);
  log.info("Queued a Soulseek download", {
    track: `${track.artist} - ${track.title}`,
    from: candidate.username,
    file: basename(candidate.file.filename.replace(/\\/g, "/")),
    detail: candidate.reason,
  });

  const record = {
    username: candidate.username,
    remoteFilename: candidate.file.filename,
    destination,
    target,
    queuedAt: new Date().toISOString(),
  };

  const finished = await waitForTransfer(config, client, record, options);
  if (!finished) {
    await pending.add(tidalId, record);
    return {
      status: "queued",
      counter: "queued",
      detail: `queued behind ${candidate.reason}; a later run will file it`,
    };
  }

  const path = await fileIntoLibrary(config, record);
  if (!path) {
    return { status: "not-found", counter: "notFound", detail: "slskd reported success but no file appeared" };
  }

  return { status: "downloaded", counter: "downloaded", detail: candidate.reason, path };
}

/**
 * Waits for one transfer, and gives up on the clock rather than on the transfer.
 *
 * Returning false does not mean failure — it means slskd is still working and this run is
 * not going to sit through it. The caller notes it and a later run collects the file.
 */
async function waitForTransfer(
  config: Config,
  client: SlskdClient,
  record: { username: string; remoteFilename: string },
  options: FallbackOptions,
): Promise<boolean> {
  const deadline = Date.now() + config.slskd.transferTimeoutMs;

  while (Date.now() < deadline && !options.signal?.aborted) {
    await Bun.sleep(TRANSFER_POLL_MS);

    const transfer = findTransfer(await client.transfers(record.username), record.remoteFilename);
    // Gone from the list entirely: slskd prunes completed transfers on its own retention
    // schedule, so an absent one has most likely finished and been tidied away.
    if (!transfer) return true;
    if (!transfer.state.includes("Completed")) continue;

    if (isSucceeded(transfer.state)) return true;
    throw new SlskdError(`the transfer ended as "${transfer.state}"`);
  }

  return false;
}

/** slskd reports the peer's path; compare on the basename so separators cannot matter. */
function findTransfer(transfers: SlskdTransfer[], remoteFilename: string): SlskdTransfer | undefined {
  const wanted = baseName(remoteFilename);
  return transfers.find((transfer) => baseName(transfer.filename) === wanted);
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Finds what slskd wrote and gives it the name the library expects.
 *
 * Hunted for rather than assumed: slskd puts the file under `<destination>/<the peer's own
 * folder>` by default, and that layout is a configurable this tool does not own. Matching on
 * the remote basename is exact enough that it cannot pick up a track that was already there.
 */
async function fileIntoLibrary(
  config: Config,
  record: { remoteFilename: string; destination: string; target: string },
): Promise<string | undefined> {
  const root = join(config.slskd.downloadsDir, record.destination);
  const found = await findFile(root, baseName(record.remoteFilename));
  if (!found) {
    log.warn("A Soulseek transfer finished but its file could not be found", {
      looked: root,
      file: baseName(record.remoteFilename),
    });
    return undefined;
  }

  // The peer's extension wins over the export's optimistic `.flac`: what arrived is what
  // arrived, and mislabelling it would defeat the library index on the next run.
  const target = join(config.libraryDir, withExtension(record.target, extname(found)));
  if (target !== found) {
    await rename(found, target);
    await pruneEmpty(dirname(found), root);
  }

  log.info("Filed a Soulseek download into the library", { path: withExtension(record.target, extname(found)) });
  return withExtension(record.target, extname(found));
}

/** Depth-first search for an exact basename. Returns the first match. */
async function findFile(directory: string, name: string): Promise<string | undefined> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(path, name);
      if (found) return found;
    } else if (entry.name === name) {
      return path;
    }
  }

  return undefined;
}

/** Clears the peer-named folders slskd created, up to but not including the album directory. */
async function pruneEmpty(from: string, stopAt: string): Promise<void> {
  let directory = from;

  while (directory.startsWith(stopAt) && directory !== stopAt) {
    try {
      await rm(directory, { recursive: false });
    } catch {
      return; // Not empty, or not ours to remove. Either way, stop.
    }
    directory = dirname(directory);
  }
}

function withExtension(path: string, extension: string): string {
  return path.replace(/\.[^./]*$/, "") + (extension || ".flac");
}

/**
 * Collects whatever previous runs left transferring.
 *
 * Runs before anything is searched for, so a track that finished overnight is filed into the
 * library first and the pass below then sees it as done rather than searching for it again.
 * Nothing here is allowed to throw: a slskd that is down should leave a pending transfer
 * pending, not lose it.
 */
async function filePending(
  config: Config,
  client: SlskdClient,
  pending: PendingTransfers,
  options: FallbackOptions,
): Promise<void> {
  for (const [tidalId, record] of pending.entries()) {
    if (options.signal?.aborted) return;

    try {
      const transfer = findTransfer(await client.transfers(record.username), record.remoteFilename);

      // Still going. Leave it exactly as it is; a later run will ask again.
      if (transfer && !transfer.state.includes("Completed")) continue;

      if (transfer && !isSucceeded(transfer.state)) {
        log.info("A queued Soulseek transfer ended without succeeding; it will be searched for again", {
          track: record.target,
          state: transfer.state,
        });
        await pending.remove(tidalId);
        continue;
      }

      const path = await fileIntoLibrary(config, record);
      if (path) {
        await pending.remove(tidalId);
        continue;
      }

      // slskd no longer knows about it and no file turned up. Holding the note for ever would
      // stop the track ever being retried, so let it go and search again.
      if (!transfer) {
        log.info("A queued Soulseek transfer vanished without leaving a file", { track: record.target });
        await pending.remove(tidalId);
      }
    } catch (error) {
      log.warn("Could not check a queued Soulseek transfer", {
        track: record.target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
