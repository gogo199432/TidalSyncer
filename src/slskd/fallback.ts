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
import { PendingTransfers, type PendingTransfer } from "./pending.ts";

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
  /**
   * Already on disk, so not fetched again. Almost always something a previous run's fallback
   * put there: a delisted track is a bare id in the snapshot, so the TIDAL pass cannot look
   * it up in the library and only the recovered name can.
   */
  alreadyPresent: number;
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
  status: "downloaded" | "present" | "not-found" | "unsearchable" | "queued" | "failed";
  detail: string;
  /** Library-relative, set when a file actually landed. */
  path?: string;
};

export type FallbackOptions = {
  onOutcome?: (outcome: FallbackOutcome) => void;
  signal?: AbortSignal;
  /**
   * Whether the library already holds this recording, answered against the index the TIDAL
   * pass built. A callback rather than the index itself, so this module needs no opinion
   * about how the library is indexed; it returns the path of the file that already covers it.
   *
   * Without this the fallback re-fetches a delisted track on *every* run. The snapshot keeps
   * calling it a bare id, so the TIDAL pass has nothing to look it up in the library with —
   * only the name recovered from MusicBrainz here can find what an earlier run downloaded.
   */
  alreadyHave?: (track: { artists: string[]; title: string; album?: string }) => string | undefined;
};

/**
 * How often to ask slskd how the queued transfers are going while draining them.
 *
 * Slower than a per-track poll would need to be, because one cycle now asks about every peer
 * at once and the thing being waited on is a stranger deciding to open an upload slot.
 */
const DRAIN_POLL_MS = 2000;

export async function runFallback(
  config: Config,
  candidates: FallbackCandidate[],
  options: FallbackOptions = {},
): Promise<FallbackReport> {
  const report: FallbackReport = {
    considered: candidates.length,
    downloaded: 0,
    alreadyPresent: 0,
    notFound: 0,
    unsearchable: 0,
    queued: 0,
    failed: 0,
  };

  const client = new SlskdClient(config.slskd);
  const pending = await PendingTransfers.open(config.dataDir);
  // Same reconciliation the TIDAL half does: prefer the artist folder already on disk.
  const directories = new DirectoryNames(config.libraryDir);
  // Queued this run, awaited together once the whole list has been sent.
  const waiting = new Map<
    string,
    { record: PendingTransfer; onFiled: (path: string) => void; onFailed: (why: string) => void }
  >();

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

    // And already *finished* by an earlier run. This is the only place the check can happen
    // for a delisted track: the TIDAL pass never had a name to look one up with, so without
    // it every run re-searched and re-downloaded the same tracks from the same strangers.
    const have = options.alreadyHave?.({ artists: [entry.track.artist], title: entry.track.title });
    if (have) {
      report.alreadyPresent += 1;
      log.debug("Skipping a Soulseek fetch; the library already has it", {
        track: `${entry.track.artist} - ${entry.track.title}`,
        path: have,
      });
      emit({ status: "present", detail: `already in the library at ${have}` });
      continue;
    }

    try {
      const target = await directories.resolve(entry.target);
      const result = await enqueueOne(config, client, candidate.tidalId, { ...entry, target });

      if (result.status === "not-found") {
        report.notFound += 1;
        emit({ status: "not-found", detail: result.detail });
        continue;
      }

      // Written down before anything is awaited, so a run killed between here and the drain
      // still leaves the transfer collectable rather than orphaned on slskd.
      await pending.add(candidate.tidalId, result.record);
      waiting.set(candidate.tidalId, {
        record: result.record,
        onFiled: (path) => {
          report.downloaded += 1;
          emit({ status: "downloaded", detail: result.detail, path });
        },
        onFailed: (why) => {
          report.failed += 1;
          emit({ status: "failed", detail: why });
        },
      });
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

  // Everything is queued; now watch the lot of them together.
  await drain(config, client, pending, waiting, options);

  // Whatever is still going when the budget expires stays in the ledger. That is not a
  // failure — a peer's queue is a third party's business, and the next run collects it.
  for (const [tidalId, entry] of waiting) {
    report.queued += 1;
    const candidate = candidates.find((c) => c.tidalId === tidalId);
    options.onOutcome?.({
      tidalId,
      index: candidate?.index ?? 0,
      track: wanted.get(tidalId)
        ? `${wanted.get(tidalId)!.track.artist} - ${wanted.get(tidalId)!.track.title}`
        : `TIDAL track ${tidalId}`,
      status: "queued",
      detail: `still queued on slskd (${entry.record.username}); a later run will file it`,
    });
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
      // MusicBrainz knows which release the recording belongs to, so a delisted track lands
      // beside the rest of its album rather than in a heap under "Unknown Album".
      target: libraryPathFor(name.artist, name.album, name.title),
    });
  }

  return resolved;
}

type EnqueueResult =
  | { status: "queued"; record: PendingTransfer; detail: string }
  | { status: "not-found"; detail: string };

/**
 * Searches, chooses, and queues — without waiting for a byte of it.
 *
 * Waiting used to happen here, per track, which made one peer's queue everybody's problem: a
 * track sitting in "Queued, Remotely" behind a stranger's upload slots held up every track
 * after it, and ten of those was ten times the timeout spent doing nothing. Whether a
 * transfer starts is entirely a third party's decision, so it cannot be on the critical path.
 */
async function enqueueOne(
  config: Config,
  client: SlskdClient,
  tidalId: string,
  { track, target }: Resolved,
): Promise<EnqueueResult> {
  const responses = await client.search(searchText(track));
  const candidate = pick(responses, track, config.slskd.losslessOnly);

  if (!candidate) {
    return {
      status: "not-found",
      detail: responses.length === 0
        ? "nobody answered the search"
        : `${responses.length} peers answered, none convincingly`,
    };
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

  return {
    status: "queued",
    detail: candidate.reason,
    record: {
      username: candidate.username,
      remoteFilename: candidate.file.filename,
      destination,
      target,
      queuedAt: new Date().toISOString(),
    },
  };
}

/**
 * Watches everything queued this run at once, until they are all done or the budget runs out.
 *
 * One budget for the whole batch rather than one per track: the point of queueing everything
 * first is that the waiting overlaps, and a per-track timeout would put it back end to end.
 * Whatever is still going when the time is up stays in the ledger for a later run — nothing
 * is cancelled, because a transfer that has been queued for an hour is often about to start.
 */
async function drain(
  config: Config,
  client: SlskdClient,
  pending: PendingTransfers,
  waiting: Map<string, { record: PendingTransfer; onFiled: (path: string) => void; onFailed: (why: string) => void }>,
  options: FallbackOptions,
): Promise<void> {
  if (waiting.size === 0) return;

  const deadline = Date.now() + config.slskd.transferTimeoutMs;
  // Scaled to the budget so a short one still gets several looks rather than one; capped so a
  // long one does not turn into a busy loop against slskd.
  const poll = Math.max(250, Math.min(DRAIN_POLL_MS, Math.floor(config.slskd.transferTimeoutMs / 4)));

  log.info("Waiting on Soulseek transfers", {
    transfers: waiting.size,
    budgetMs: config.slskd.transferTimeoutMs,
    pollMs: poll,
  });

  while (waiting.size > 0 && Date.now() < deadline && !options.signal?.aborted) {
    await Bun.sleep(poll);

    // One request per peer rather than one per transfer: several tracks often come from the
    // same well-stocked share, and slskd answers for all of that peer's downloads at once.
    const byUser = new Map<string, SlskdTransfer[]>();
    for (const { record } of waiting.values()) {
      if (byUser.has(record.username)) continue;
      try {
        byUser.set(record.username, await client.transfers(record.username));
      } catch (error) {
        log.debug("Could not poll a peer's transfers", { user: record.username, error: String(error) });
      }
    }

    for (const [tidalId, entry] of [...waiting]) {
      const transfers = byUser.get(entry.record.username);
      if (!transfers) continue;

      const transfer = findTransfer(transfers, entry.record.remoteFilename);
      // Gone from the list entirely: slskd prunes completed transfers on its own retention
      // schedule, so an absent one has most likely finished and been tidied away.
      const finished = !transfer || transfer.state.includes("Completed");
      if (!finished) continue;

      waiting.delete(tidalId);

      if (transfer && !isSucceeded(transfer.state)) {
        await pending.remove(tidalId);
        entry.onFailed(`the transfer ended as "${transfer.state}"`);
        continue;
      }

      const path = await fileIntoLibrary(config, entry.record);
      await pending.remove(tidalId);
      if (path) entry.onFiled(path);
      else entry.onFailed("slskd reported success but no file appeared");
    }
  }
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
