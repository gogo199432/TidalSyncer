import { normalize, stripParentheticals } from "../tidal/match.ts";
import type { SlskdFile, SlskdResponse } from "./client.ts";

/**
 * Choosing which stranger's file to accept.
 *
 * Nothing here is verified. A Soulseek result is a filename a stranger chose, next to numbers
 * that stranger reported about their own file, and neither has to be true. So this is written
 * to be *unwilling* rather than clever: a candidate has to look like the track that was asked
 * for on the evidence that is actually checkable, and anything that does not is dropped rather
 * than ranked low. Downloading the wrong track into a library is worse than downloading
 * nothing, because nothing is visible and a wrong file is not.
 *
 * The filename is the only field a peer cannot fake without also making it unfindable, so the
 * title has to appear in it and the artist has to appear somewhere in its path. Bitrate,
 * duration and sample rate are used to *rank* what survives that, never to admit it — they are
 * absent on a large fraction of real results, and a ranking that needs them would throw away
 * the peers who simply share files without tagging them.
 */

export type WantedTrack = {
  artist: string;
  title: string;
  /** Seconds, when the exported metadata had it. Used to reject the wrong recording. */
  duration?: number;
};

export type Candidate = {
  username: string;
  file: SlskdFile;
  score: number;
  /** Why it won, for the log and the per-track event. */
  reason: string;
};

/**
 * The formats worth having, each on the same coarse ladder `src/quality.ts` grades local
 * files by. Anything not listed is rejected outright: this fills a music library, and a
 * `.zip` or a `.cue` is not a track.
 *
 * `rank` only separates formats *within* a tier — it never lifts one across.
 */
const FORMATS: Record<string, { lossless: boolean; rank: number }> = {
  flac: { lossless: true, rank: 30 },
  wav: { lossless: true, rank: 20 },
  alac: { lossless: true, rank: 18 },
  aiff: { lossless: true, rank: 16 },
  m4a: { lossless: false, rank: 20 },
  ogg: { lossless: false, rank: 15 },
  opus: { lossless: false, rank: 15 },
  mp3: { lossless: false, rank: 10 },
  wma: { lossless: false, rank: 2 },
};

/**
 * How far the tier outranks everything else.
 *
 * Larger than any total the availability bonuses below can reach, and that is the point
 * rather than an accident of tuning: a lossless file behind a queue beats a lossy one from a
 * peer with a free slot, every time. Waiting is recoverable — the next scheduled run tries
 * again and the track is simply absent until it succeeds. Settling for an mp3 is not: these
 * are tracks TIDAL will not serve, so nothing will ever come along and upgrade it, and the
 * library keeps that file for good.
 */
const LOSSLESS_TIER = 1000;

/** Below this a file is a snippet, a jingle or an error page, whatever it claims to be. */
const MIN_BYTES = 256 * 1024;

/** Above this it is an album, a DJ set or a video — not the single track that was asked for. */
const MAX_BYTES = 300 * 1024 * 1024;

/** How far a peer's reported duration may differ before it is a different recording. */
const DURATION_TOLERANCE_SECONDS = 12;

/** The search slskd is asked to run. Bracketed suffixes are dropped — peers rarely have them. */
export function searchText(track: WantedTrack): string {
  const artist = stripParentheticals(track.artist);
  const title = stripParentheticals(track.title);
  // Punctuation splits Soulseek's tokeniser more than it helps, and a search is not a filter:
  // being too specific here returns nothing at all rather than something to sift.
  return normalize(`${artist} ${title}`).replace(/[()[\]]/g, " ").replace(/\s+/g, " ").trim();
}

/** The extension, lowercased, from a peer's backslash-separated path. */
export function extensionOf(file: SlskdFile): string {
  if (file.extension) return file.extension.replace(/^\./, "").toLowerCase();
  const name = file.filename.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Just the file's own name, without the peer's directory tree. */
export function basenameOf(file: SlskdFile): string {
  return file.filename.split(/[\\/]/).pop() ?? file.filename;
}

/**
 * True when this file could plausibly be the wanted track.
 *
 * Deliberately strict, and deliberately checking two different parts of the path: the title
 * has to be in the filename, and the artist has to be somewhere in the path — peers file
 * things as `Artist/Album/01 Title.flac` as often as `Artist - Title.flac`, so requiring both
 * in the basename would reject most of a well-organised share.
 */
export function plausible(file: SlskdFile, track: WantedTrack, losslessOnly = false): boolean {
  const format = FORMATS[extensionOf(file)];
  if (!format) return false;
  // For a library that is otherwise all FLAC, an mp3 can be worse than a gap. Off by default:
  // these are tracks TIDAL will not serve at all, so usually something beats nothing.
  if (losslessOnly && !format.lossless) return false;
  if (file.size < MIN_BYTES || file.size > MAX_BYTES) return false;

  const path = normalize(file.filename.replace(/[\\/]/g, " "));
  const name = normalize(basenameOf(file));

  const title = normalize(stripParentheticals(track.title));
  const artist = normalize(stripParentheticals(track.artist));
  if (!title || !name.includes(title)) return false;
  if (artist && !path.includes(artist)) return false;

  // A reported duration that disagrees is the strongest evidence available that this is a
  // different recording — a live take, an edit, an extended mix. Absent, it proves nothing.
  if (track.duration && file.length && Math.abs(file.length - track.duration) > DURATION_TOLERANCE_SECONDS) {
    return false;
  }

  return true;
}

/**
 * Ranks a surviving candidate.
 *
 * Format dominates, because it is the one thing that is actually checkable from the filename
 * and the thing the library cares about. Everything after it is about whether the transfer
 * will ever start: a peer with a free slot and a fast line beats a marginally better file
 * behind forty people in a queue, because the second one usually never arrives.
 */
export function score(file: SlskdFile, response: SlskdResponse, track: WantedTrack): number {
  const format = FORMATS[extensionOf(file)];
  if (!format) return 0;

  let score = (format.lossless ? LOSSLESS_TIER : 0) + format.rank;

  if (response.hasFreeUploadSlot) score += 30;
  // Log-scaled: the difference between 0 and 10 waiting matters, 200 and 400 does not.
  score -= Math.min(25, Math.log2((response.queueLength ?? 0) + 1) * 5);
  score += Math.min(15, ((response.uploadSpeed ?? 0) / 1_000_000) * 5);

  // Only meaningful within the lossy formats; a FLAC's bitrate says how compressible it was.
  if (file.bitRate && !format.lossless) {
    score += Math.min(12, (file.bitRate / 320) * 12);
  }
  if (file.bitDepth && file.bitDepth >= 24) score += 4;
  if (file.sampleRate && file.sampleRate > 48_000) score += 2;

  // Agreeing on duration when both know it is real corroboration, so reward it a little.
  if (track.duration && file.length && Math.abs(file.length - track.duration) <= 3) score += 8;

  return score;
}

/**
 * Picks the best file across every peer that answered, or undefined when none is convincing.
 *
 * Undefined is a perfectly good outcome and the common one for obscure tracks: reporting that
 * nothing acceptable was found is the honest result, and the next run can try again when
 * different peers are online.
 */
export function pick(
  responses: SlskdResponse[],
  track: WantedTrack,
  losslessOnly = false,
): Candidate | undefined {
  let best: Candidate | undefined;

  for (const response of responses) {
    for (const file of response.files ?? []) {
      if (!file?.filename || typeof file.size !== "number") continue;
      if (!plausible(file, track, losslessOnly)) continue;

      const value = score(file, response, track);
      if (best && value <= best.score) continue;

      best = { username: response.username, file, score: value, reason: describe(file, response) };
    }
  }

  return best;
}

function describe(file: SlskdFile, response: SlskdResponse): string {
  const parts = [extensionOf(file) || "unknown", `${Math.round(file.size / 1_000_000)}MB`];
  if (file.bitRate) parts.push(`${file.bitRate}kbps`);
  if (file.bitDepth) parts.push(`${file.bitDepth}-bit`);
  parts.push(response.hasFreeUploadSlot ? "free slot" : `queue ${response.queueLength ?? "?"}`);
  return parts.join(", ");
}
