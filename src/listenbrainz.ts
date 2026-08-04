import { log } from "./logger.ts";

const JSPF_PLAYLIST_EXT = "https://musicbrainz.org/doc/jspf#playlist";
const JSPF_TRACK_EXT = "https://musicbrainz.org/doc/jspf#track";

type JspfPlaylistExtension = {
  additional_metadata?: {
    algorithm_metadata?: { source_patch?: string };
    expires_at?: string;
  };
  created_for?: string;
  last_modified_at?: string;
  public?: boolean;
};

type JspfTrackExtension = {
  added_at?: string;
  additional_metadata?: {
    artists?: Array<{ artist_credit_name?: string; artist_mbid?: string; join_phrase?: string }>;
  };
};

type JspfTrack = {
  album?: string;
  creator?: string;
  duration?: number;
  title?: string;
  identifier?: string | string[];
  extension?: Record<string, JspfTrackExtension>;
};

type JspfPlaylist = {
  annotation?: string;
  creator?: string;
  date?: string;
  identifier?: string;
  title?: string;
  track?: JspfTrack[];
  extension?: Record<string, JspfPlaylistExtension>;
};

type CreatedForResponse = {
  count: number;
  offset: number;
  playlist_count: number;
  playlists: Array<{ playlist: JspfPlaylist }>;
};

type SinglePlaylistResponse = { playlist: JspfPlaylist };

type MetadataResponse = Record<string, { recording?: { isrcs?: string[] } } | undefined>;

type FeedbackResponse = {
  count: number;
  offset: number;
  total_count: number;
  feedback: Array<{ recording_mbid?: string | null; score?: number }>;
};

type LookupResponse = Array<{
  index?: number;
  recording_mbid?: string;
  recording_name?: string;
  artist_credit_name?: string;
}>;

/** ListenBrainz caps the metadata endpoint at 50 MBIDs per request. */
const METADATA_BATCH_SIZE = 50;

/** `MAX_LOOKUPS_PER_POST` on the server side. */
const LOOKUP_BATCH_SIZE = 50;

/** `MAX_ITEMS_PER_GET` on the server side. */
const FEEDBACK_PAGE_SIZE = 1000;

/**
 * The server rejects a lookup whose artist + recording + release names exceed this many
 * characters, so over-long entries are dropped rather than failing the whole batch.
 */
const MAX_LOOKUP_QUERY_LENGTH = 250;

/** A recording to resolve to an MBID by name, when no ISRC placed it. */
export type RecordingQuery = {
  artist: string;
  title: string;
};

/** A ListenBrainz playlist as we care about it: identity, freshness, and tracks. */
export type SourcePlaylist = {
  /** Stable family key across editions, e.g. `weekly-jams`. */
  sourcePatch: string;
  /** MBID of this particular edition. Changes every time ListenBrainz regenerates it. */
  mbid: string;
  title: string;
  description: string;
  /** ISO timestamp of the last modification of this edition. */
  lastModifiedAt: string;
  tracks: SourceTrack[];
};

export type SourceTrack = {
  title: string;
  artist: string;
  album?: string;
  /** MusicBrainz recording MBID, when ListenBrainz supplied one. */
  recordingMbid?: string;
};

/** Metadata-only listing entry; `createdfor` returns playlists with an empty track array. */
export type PlaylistSummary = {
  sourcePatch: string;
  mbid: string;
  title: string;
  lastModifiedAt: string;
};

export class ListenBrainzError extends Error {}

export class ListenBrainzClient {
  /** Set from the rate-limit headers of the previous response; see `waitForSlot`. */
  private resumeAt = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly userAgent: string,
    /** User token. Only the write/lookup endpoints need one; reads work without. */
    private readonly token: string = "",
  ) {}

  /**
   * Lists the playlists ListenBrainz generated for a user. These are always public,
   * so no token is needed. Paginates until the reported total is covered.
   */
  async listCreatedFor(user: string): Promise<PlaylistSummary[]> {
    const summaries: PlaylistSummary[] = [];
    const pageSize = 25;
    let offset = 0;
    let total = Infinity;

    while (offset < total) {
      const url = new URL(`/1/user/${encodeURIComponent(user)}/playlists/createdfor`, this.baseUrl);
      url.searchParams.set("count", String(pageSize));
      url.searchParams.set("offset", String(offset));

      const body = await this.get<CreatedForResponse>(url);
      total = body.playlist_count;

      for (const entry of body.playlists ?? []) {
        const summary = toSummary(entry.playlist);
        if (summary) summaries.push(summary);
        else log.debug("Skipping ListenBrainz playlist with no identifier or source patch");
      }

      if (!body.playlists?.length) break;
      offset += body.playlists.length;
    }

    return summaries;
  }

  /** Fetches one playlist edition including its recordings. */
  async fetchPlaylist(mbid: string): Promise<SourcePlaylist> {
    const url = new URL(`/1/playlist/${encodeURIComponent(mbid)}`, this.baseUrl);
    const body = await this.get<SinglePlaylistResponse>(url);
    const playlist = body.playlist;
    const summary = toSummary(playlist);

    if (!summary) {
      throw new ListenBrainzError(`Playlist ${mbid} is missing an identifier or source patch`);
    }

    return {
      ...summary,
      description: stripHtml(playlist.annotation ?? ""),
      tracks: (playlist.track ?? []).flatMap(toSourceTrack),
    };
  }

  /**
   * Resolves recording MBIDs to ISRCs in batches. ListenBrainz mirrors MusicBrainz here,
   * which lets us avoid MusicBrainz's 1 req/s limit and resolve a whole playlist at once.
   * Recordings without a known ISRC are simply absent from the returned map.
   */
  async fetchIsrcs(recordingMbids: string[]): Promise<Map<string, string[]>> {
    const isrcs = new Map<string, string[]>();
    const unique = [...new Set(recordingMbids)];

    for (const chunk of chunked(unique, METADATA_BATCH_SIZE)) {
      const url = new URL("/1/metadata/recording/", this.baseUrl);
      url.searchParams.set("recording_mbids", chunk.join(","));
      url.searchParams.set("inc", "recording");

      const body = await this.get<MetadataResponse>(url);
      for (const [mbid, entry] of Object.entries(body ?? {})) {
        const values = entry?.recording?.isrcs?.filter(Boolean) ?? [];
        if (values.length > 0) isrcs.set(mbid, values);
      }
    }

    return isrcs;
  }

  /**
   * Confirms the token works and reports whose account it belongs to. Worth checking up
   * front: feedback is written to the *token's* owner, so a token pasted from another
   * account would silently love tracks on the wrong profile.
   */
  async validateToken(): Promise<string> {
    const url = new URL("/1/validate-token", this.baseUrl);
    const body = await this.request<{ valid?: boolean; user_name?: string }>(url, "GET");

    if (!body.valid || !body.user_name) {
      throw new ListenBrainzError(
        "LISTENBRAINZ_TOKEN was rejected. Copy it again from https://listenbrainz.org/settings/",
      );
    }

    return body.user_name;
  }

  /**
   * Every recording the user has already loved, as MBIDs. Feedback carrying only a
   * `recording_msid` is ignored: we can only submit MBIDs, so an MSID-only love would
   * look like a gap and we would love it again by MBID, which is harmless but noisy.
   */
  async lovedRecordingMbids(user: string): Promise<Set<string>> {
    const loved = new Set<string>();
    let offset = 0;
    let total = Infinity;

    while (offset < total) {
      const url = new URL(`/1/feedback/user/${encodeURIComponent(user)}/get-feedback`, this.baseUrl);
      url.searchParams.set("score", "1");
      url.searchParams.set("count", String(FEEDBACK_PAGE_SIZE));
      url.searchParams.set("offset", String(offset));

      const body = await this.request<FeedbackResponse>(url, "GET");
      total = body.total_count ?? 0;

      for (const entry of body.feedback ?? []) {
        if (entry.recording_mbid) loved.add(entry.recording_mbid);
      }

      if (!body.feedback?.length) break;
      offset += body.feedback.length;
    }

    return loved;
  }

  /**
   * Resolves recordings to MBIDs by artist and title, using the same mapper ListenBrainz
   * uses to attach listens to MusicBrainz. Returns one entry per input index; an index is
   * absent when nothing matched. Requires a token — the endpoint is authenticated to keep
   * scrapers out.
   */
  async lookupRecordings(queries: RecordingQuery[]): Promise<Map<number, string>> {
    const resolved = new Map<number, string>();

    // Keep the original positions so results map back after over-long entries are dropped.
    const usable = queries.flatMap((query, index) =>
      query.artist.length + query.title.length <= MAX_LOOKUP_QUERY_LENGTH
        ? [{ index, query }]
        : [],
    );

    for (const batch of chunked(usable, LOOKUP_BATCH_SIZE)) {
      const url = new URL("/1/metadata/lookup/", this.baseUrl);
      const body = await this.request<LookupResponse>(url, "POST", {
        recordings: batch.map(({ query }) => ({
          artist_name: query.artist,
          recording_name: query.title,
        })),
      });

      for (const [position, entry] of (body ?? []).entries()) {
        // The server echoes the request index; fall back to position if it ever stops.
        const source = batch[entry.index ?? position];
        if (source && entry.recording_mbid) resolved.set(source.index, entry.recording_mbid);
      }
    }

    return resolved;
  }

  /** Marks a recording as loved (score 1). Idempotent: re-loving is accepted as a no-op. */
  async loveRecording(recordingMbid: string): Promise<void> {
    const url = new URL("/1/feedback/recording-feedback", this.baseUrl);
    await this.request(url, "POST", { recording_mbid: recordingMbid, score: 1 });
  }

  private async get<T>(url: URL): Promise<T> {
    return await this.request<T>(url, "GET");
  }

  private async request<T>(url: URL, method: "GET" | "POST", body?: unknown): Promise<T> {
    await this.waitForSlot();

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };
    if (this.token) headers.Authorization = `Token ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    this.recordRateLimit(response);

    if (response.status === 429) {
      // The headers we just recorded already say how long to wait, so one retry suffices.
      log.debug("ListenBrainz rate limit hit, retrying after the reported window");
      return await this.request<T>(url, method, body);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ListenBrainzError(
        `ListenBrainz ${response.status} for ${url.pathname}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }

    return (await response.json()) as T;
  }

  /**
   * ListenBrainz allows a fixed number of requests per rolling window and reports the
   * remaining budget on every response. Loving a few thousand tracks is one request each,
   * so rather than guessing an interval we spend the budget freely and pause exactly as
   * long as the server says once it runs out.
   */
  private recordRateLimit(response: Response): void {
    const remaining = Number(response.headers.get("x-ratelimit-remaining"));
    const resetIn = Number(response.headers.get("x-ratelimit-reset-in"));
    if (!Number.isFinite(remaining) || !Number.isFinite(resetIn)) return;

    this.resumeAt = remaining > 0 ? 0 : Date.now() + (resetIn + 1) * 1000;
  }

  private async waitForSlot(): Promise<void> {
    const waitMs = this.resumeAt - Date.now();
    if (waitMs <= 0) return;

    log.debug("Waiting for the ListenBrainz rate-limit window to reset", { waitMs });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.resumeAt = 0;
  }
}

function toSummary(playlist: JspfPlaylist): PlaylistSummary | null {
  const extension = playlist.extension?.[JSPF_PLAYLIST_EXT];
  const sourcePatch = extension?.additional_metadata?.algorithm_metadata?.source_patch;
  const mbid = playlist.identifier ? lastPathSegment(playlist.identifier) : undefined;

  if (!sourcePatch || !mbid) return null;

  return {
    sourcePatch,
    mbid,
    title: playlist.title ?? sourcePatch,
    lastModifiedAt: extension?.last_modified_at ?? playlist.date ?? "",
  };
}

function toSourceTrack(track: JspfTrack): SourceTrack[] {
  const title = track.title?.trim();
  const artist = track.creator?.trim();
  if (!title || !artist) return [];

  const identifiers = Array.isArray(track.identifier)
    ? track.identifier
    : track.identifier
      ? [track.identifier]
      : [];
  const recording = identifiers.find((id) => id.includes("/recording/"));

  return [
    {
      title,
      artist,
      album: track.album?.trim() || undefined,
      recordingMbid: recording ? lastPathSegment(recording) : undefined,
    },
  ];
}

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function lastPathSegment(value: string): string {
  return value.split("/").filter(Boolean).pop() ?? value;
}

/** ListenBrainz annotations contain HTML; TIDAL descriptions are plain text. */
function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** `weekly-jams` -> `Weekly Jams`, used to name the mirrored TIDAL playlist. */
export function humanizeSourcePatch(sourcePatch: string): string {
  return sourcePatch
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
