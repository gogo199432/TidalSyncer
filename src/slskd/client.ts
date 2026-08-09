import { log } from "../logger.ts";

/**
 * The slskd HTTP API — enough of it to search Soulseek and pull one file down.
 *
 * slskd is a headless Soulseek client with a REST API. It is the fallback for tracks TIDAL
 * will not serve: the ones the account is not entitled to, and the ones that have been
 * delisted out of the catalogue entirely.
 *
 * Two things shape this client. First, **almost every field is optional**. The search results
 * are whatever remote peers chose to report about their own files; bitrate, duration and
 * sample rate are frequently absent, and a peer can put anything it likes in any of them. The
 * only things that can be relied on are the username, the filename and the size — so those
 * are the only fields typed as required, and `src/slskd/match.ts` ranks on the rest only when
 * they are there.
 *
 * Second, **the transfer listing's exact shape is not depended on**. slskd nests downloads by
 * user and then by directory, and that nesting has changed across versions. Rather than pin a
 * shape that a slskd upgrade could quietly break, `transfers` walks the response for anything
 * that looks like a transfer. Matching is by filename, which is the one field whose meaning is
 * not going to move.
 *
 * Verified against slskd 0.26.0.
 */

/** A file a peer says it is sharing. Only `filename` and `size` are ever guaranteed. */
export type SlskdFile = {
  /** The peer's own path, backslash-separated. This is the handle for downloading it. */
  filename: string;
  size: number;
  extension?: string;
  bitRate?: number;
  bitDepth?: number;
  sampleRate?: number;
  /** Seconds, when the peer reports it. */
  length?: number;
  isVariableBitRate?: boolean;
};

/** One peer's answer to a search. */
export type SlskdResponse = {
  username: string;
  /** A peer with a free slot starts immediately; without one you join a queue. */
  hasFreeUploadSlot?: boolean;
  queueLength?: number;
  /** Bytes per second, as the peer reports it. */
  uploadSpeed?: number;
  files: SlskdFile[];
};

/** Where a queued download has got to. `state` is slskd's flag string, e.g. "Completed, Succeeded". */
export type SlskdTransfer = {
  id?: string;
  username?: string;
  filename: string;
  state: string;
  size?: number;
  bytesTransferred?: number;
  percentComplete?: number;
};

export class SlskdError extends Error {}

/** slskd renders `TransferStates` as a comma-joined flag string; these read it back. */
export function isFinished(state: string): boolean {
  return state.includes("Completed");
}

export function isSucceeded(state: string): boolean {
  return state.includes("Succeeded");
}

export type SlskdConfig = {
  /** Base URL of the slskd web API, e.g. http://slskd:5030. Empty disables the fallback. */
  url: string;
  apiKey: string;
  /** How long slskd should keep a search open, and how long we wait for it. */
  searchTimeoutMs: number;
  /** Ceiling on one request. A LAN service that has stopped answering must not hang a run. */
  requestTimeoutMs: number;
};

export class SlskdClient {
  constructor(private readonly config: SlskdConfig) {}

  /**
   * Runs one search to completion and returns what came back.
   *
   * The id is ours rather than slskd's so the poll and the cleanup need no round trip to
   * discover it. Searches are deleted afterwards: slskd keeps them indefinitely otherwise, and
   * a scheduled run that leaves one behind per unavailable track fills its database with
   * questions nobody is going to read the answers to.
   */
  async search(text: string): Promise<SlskdResponse[]> {
    const id = crypto.randomUUID();
    const seconds = Math.max(5, Math.round(this.config.searchTimeoutMs / 1000));

    await this.request("POST", "/api/v0/searches", {
      id,
      searchText: text,
      searchTimeout: seconds,
      // Peers that answer with a single unrelated file are noise; so are the ones sharing
      // nothing. slskd's own filtering is cheaper than pulling it all back and discarding it.
      filterResponses: true,
      minimumResponseFileCount: 1,
    });

    try {
      return await this.awaitSearch(id);
    } finally {
      // Best effort: a search left behind is untidy, not broken.
      await this.request("DELETE", `/api/v0/searches/${id}`).catch((error: unknown) => {
        log.debug("Could not delete a finished slskd search", { id, error: String(error) });
      });
    }
  }

  private async awaitSearch(id: string): Promise<SlskdResponse[]> {
    // Generous next to the search timeout itself: slskd finishes when the timeout expires,
    // and this only has to outlast that plus the time to serialise the responses.
    const deadline = Date.now() + this.config.searchTimeoutMs + 15_000;

    while (Date.now() < deadline) {
      await Bun.sleep(1000);

      const search = (await this.request("GET", `/api/v0/searches/${id}?includeResponses=true`)) as {
        isComplete?: boolean;
        state?: string;
        responseCount?: number;
        responses?: SlskdResponse[];
      };

      // `isComplete` is the plain answer to the plain question; the state string is a flags
      // enum kept as the fallback. Note that a search that found nothing still ends as
      // "Completed, TimedOut" — Soulseek searches always expire rather than finish, so
      // treating TimedOut as a failure would call every empty search an error.
      if (search.isComplete ?? (search.state ? isFinished(search.state) : false)) {
        log.debug("slskd search finished", { id, state: search.state, responses: search.responseCount ?? 0 });
        return (search.responses ?? []).filter((response) => response.username && response.files?.length);
      }
    }

    throw new SlskdError(`slskd search ${id} did not finish within ${this.config.searchTimeoutMs}ms`);
  }

  /**
   * Queues one file for download.
   *
   * `destination` is a path relative to slskd's own downloads directory, which is what lets a
   * run put each track somewhere it can find again afterwards — slskd's default layout is the
   * remote peer's, and that tells you nothing about which track you asked for.
   */
  async enqueue(username: string, file: SlskdFile, destination: string): Promise<void> {
    await this.request("POST", "/api/v0/transfers/downloads/batches", {
      username,
      files: [{ filename: file.filename, size: file.size }],
      options: { destination },
    });
  }

  /** Every download slskd is holding for this peer, flattened out of whatever it nests them in. */
  async transfers(username: string): Promise<SlskdTransfer[]> {
    const body = await this.request("GET", `/api/v0/transfers/downloads/${encodeURIComponent(username)}`);
    return collectTransfers(body);
  }

  /** Gives up on a queued or running download. `remove` also drops it from slskd's list. */
  async cancel(username: string, id: string, remove = true): Promise<void> {
    const path = `/api/v0/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(id)}`;
    await this.request("DELETE", `${path}?remove=${remove}`);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = new URL(path, this.config.url).toString();

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          "X-API-Key": this.config.apiKey,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (error) {
      throw new SlskdError(`${method} ${path} could not reach slskd at ${this.config.url}: ${String(error)}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new SlskdError(
        `slskd rejected the API key on ${method} ${path} (${response.status}). Downloads and ` +
          "searches both change state, so the key needs the readwrite role — a read-only key " +
          "can list transfers but not start anything.",
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new SlskdError(`${method} ${path} failed (${response.status}): ${detail.slice(0, 200)}`);
    }

    // DELETE and some POSTs answer 204, and `.json()` on an empty body throws.
    const text = await response.text();
    if (!text) return undefined;

    try {
      return JSON.parse(text);
    } catch {
      throw new SlskdError(`${method} ${path} returned something that is not JSON`);
    }
  }
}

/**
 * Pulls every transfer-shaped object out of a response, however deeply it is nested.
 *
 * slskd groups downloads by user and then by directory, and that grouping is exactly the sort
 * of thing that gets reshaped between versions. Anything with both a `filename` and a `state`
 * is a transfer; nothing else in these payloads has that pair, and looking for it rather than
 * for a path means a slskd upgrade cannot quietly turn a working fallback into one that never
 * notices a download finishing.
 */
export function collectTransfers(body: unknown): SlskdTransfer[] {
  const found: SlskdTransfer[] = [];

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (!node || typeof node !== "object") return;

    const record = node as Record<string, unknown>;
    if (typeof record.filename === "string" && typeof record.state === "string") {
      found.push({
        filename: record.filename,
        state: record.state,
        id: typeof record.id === "string" ? record.id : undefined,
        username: typeof record.username === "string" ? record.username : undefined,
        size: typeof record.size === "number" ? record.size : undefined,
        bytesTransferred: typeof record.bytesTransferred === "number" ? record.bytesTransferred : undefined,
        percentComplete: typeof record.percentComplete === "number" ? record.percentComplete : undefined,
      });
      return;
    }

    for (const value of Object.values(record)) walk(value);
  };

  walk(body);
  return found;
}
