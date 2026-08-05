import { spawn } from "node:child_process";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "../logger.ts";
import type { DeviceSession } from "./device-auth.ts";

const MANIFEST_URL = "https://openapi.tidal.com/v2/trackManifests";

export type Quality = "hires" | "lossless" | "high" | "low";

export const QUALITIES: Quality[] = ["hires", "lossless", "high", "low"];

/**
 * What to ask the manifest endpoint for, per quality tier.
 *
 * The FLAC tiers arrive as a fragmented MP4 carrying a FLAC stream, so they need a demux
 * step; the AAC tiers are already playable as `.m4a` and are passed through untouched.
 */
const QUALITY_FORMATS: Record<Quality, { formats: string[]; extension: string; demux: boolean }> = {
  hires: { formats: ["FLAC_HIRES", "FLAC"], extension: "flac", demux: true },
  lossless: { formats: ["FLAC"], extension: "flac", demux: true },
  high: { formats: ["AACLC"], extension: "m4a", demux: false },
  low: { formats: ["HEAACV1"], extension: "m4a", demux: false },
};

/** A file smaller than this is a truncated fetch or an error page, never real audio. */
const MIN_AUDIO_BYTES = 100 * 1024;

export class DownloadError extends Error {}

/** Raised when the account is not entitled to the full track, so callers can count it apart. */
export class PreviewOnlyError extends DownloadError {
  constructor(reason: string) {
    super(`TIDAL served a preview instead of the full track (${reason})`);
  }
}

/**
 * Raised if TIDAL ever starts serving encrypted HLS on this path.
 *
 * Today the HLS branch of `trackManifests` returns plain segments — it is the MPEG-DASH
 * branch that carries `drmData` with a Widevine/FairPlay `licenseUrl`. If that changes, the
 * segments would still download and concatenate into a file of plausible size that is
 * silence, so this fails loudly instead. Decrypting them is out of scope by design.
 */
export class EncryptedStreamError extends DownloadError {
  constructor() {
    super(
      "The HLS playlist is encrypted (#EXT-X-KEY). This tool downloads plain segments only " +
        "and does not decrypt streams.",
    );
  }
}

type ParsedPlaylist = {
  initUri?: string;
  segmentUris: string[];
  /** Set when the response was a master playlist and a variant must be followed. */
  variantUri?: string;
};

/**
 * Fetches one track as a local file.
 *
 * Walks down from `quality` through the lower tiers, because entitlement is per track: a
 * Hi-Res request on a catalogue track that only exists in lossless comes back as a preview
 * rather than an error, and silently writing a 30-second file would be much worse than
 * taking the tier that is actually available.
 *
 * Returns the path written, or undefined if every tier came back as a preview.
 */
export async function downloadTrack(
  session: DeviceSession,
  trackId: string,
  destination: string,
  quality: Quality = "lossless",
): Promise<string | undefined> {
  const chain = QUALITIES.slice(QUALITIES.indexOf(quality)).filter(Boolean);
  let lastPreviewReason: string | undefined;

  for (const tier of chain) {
    const { formats, extension, demux } = QUALITY_FORMATS[tier];

    let playlistUri: string;
    try {
      playlistUri = await fetchManifestUri(session, trackId, formats);
    } catch (error) {
      if (error instanceof PreviewOnlyError) {
        lastPreviewReason = error.message;
        log.debug("Tier unavailable, trying lower", { trackId, tier });
        continue;
      }
      throw error;
    }

    const parsed = await fetchPlaylist(playlistUri);
    if (parsed.segmentUris.length === 0) {
      log.debug("Manifest had no segments, trying lower tier", { trackId, tier });
      continue;
    }

    const target = replaceExtension(destination, extension);
    await mkdir(dirname(target), { recursive: true });

    const raw = demux ? `${target}.${process.pid}.m4a` : `${target}.${process.pid}.part`;
    const demuxed = `${target}.${process.pid}.part`;
    try {
      const bytes = await writeSegments(parsed, raw);
      if (bytes < MIN_AUDIO_BYTES) {
        throw new DownloadError(`assembled file is only ${bytes} bytes`);
      }

      if (demux) {
        // Demuxed to a temporary name and then renamed, rather than straight to `target`.
        // The library is usually a share something else is scanning — Navidrome, Plex — and
        // a rename is atomic where a half-written .flac appearing under its final name is a
        // corrupt track in someone's index.
        await demuxFlac(raw, demuxed);
        await rename(demuxed, target);
        await rm(raw, { force: true });
      } else {
        await rename(raw, target);
      }
    } catch (error) {
      await rm(raw, { force: true });
      await rm(demuxed, { force: true });
      throw error;
    }

    const finalBytes = (await stat(target)).size;
    log.info("Downloaded track", { trackId, tier, bytes: finalBytes, path: target });
    return target;
  }

  log.warn("No downloadable tier for track", { trackId, reason: lastPreviewReason ?? "no segments at any tier" });
  return undefined;
}

/**
 * Asks for the HLS manifest and returns the playlist URL from it.
 *
 * `usage=DOWNLOAD` and `manifestType=HLS` are both load-bearing. The MPEG-DASH branch of
 * this same endpoint returns `drmData` (Widevine/FairPlay) instead of a plain playlist.
 */
async function fetchManifestUri(session: DeviceSession, trackId: string, formats: string[]): Promise<string> {
  const query = new URLSearchParams({
    adaptive: "true",
    manifestType: "HLS",
    uriScheme: "HTTPS",
    usage: "DOWNLOAD",
  });
  for (const format of formats) query.append("formats", format);

  const response = await requestWithBackoff(`${MANIFEST_URL}/${trackId}?${query}`, {
    headers: {
      Authorization: `Bearer ${await session.accessToken()}`,
      Accept: "application/vnd.api+json",
    },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new DownloadError(`Manifest request for ${trackId} failed (${response.status}): ${detail.slice(0, 200)}`);
  }

  const body = (await response.json()) as {
    data?: { attributes?: { uri?: string; trackPresentation?: string; previewReason?: string } };
  };
  const attributes = body.data?.attributes;

  if (attributes?.trackPresentation === "PREVIEW") {
    throw new PreviewOnlyError(attributes.previewReason ?? "unknown reason");
  }
  if (!attributes?.uri) {
    throw new DownloadError(`Manifest for ${trackId} carried no playlist URI`);
  }

  return attributes.uri;
}

/** Reads the playlist, following one level of master → variant indirection. */
async function fetchPlaylist(uri: string): Promise<ParsedPlaylist> {
  const parsed = parsePlaylist(await fetchText(uri), uri);
  if (!parsed.variantUri) return parsed;

  log.debug("Following HLS variant playlist", { uri: parsed.variantUri });
  const variant = parsePlaylist(await fetchText(parsed.variantUri), parsed.variantUri);
  if (variant.variantUri) throw new DownloadError("HLS playlist nests master playlists more than one level deep");
  return variant;
}

async function fetchText(uri: string): Promise<string> {
  const response = await requestWithBackoff(uri, { redirect: "follow" });
  if (!response.ok) throw new DownloadError(`Fetching HLS playlist failed (${response.status})`);
  return await response.text();
}

/**
 * Minimal M3U8 parser: enough for what TIDAL emits, and strict about what it does not
 * understand rather than guessing.
 */
export function parsePlaylist(text: string, baseUri: string): ParsedPlaylist {
  if (/^#EXT-X-KEY:(?!METHOD=NONE)/m.test(text)) throw new EncryptedStreamError();

  const isMaster = text.includes("#EXT-X-STREAM-INF");
  const uris: string[] = [];
  let initUri: string | undefined;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("#EXT-X-MAP:")) {
      const uri = /URI="([^"]+)"/.exec(trimmed)?.[1];
      if (uri) initUri = new URL(uri, baseUri).toString();
      continue;
    }

    if (trimmed.startsWith("#")) continue;
    uris.push(new URL(trimmed, baseUri).toString());
  }

  // On a master playlist the URI lines are variants, not media segments. TIDAL orders them
  // best-first, so the first entry is the highest quality it is willing to serve.
  if (isMaster) return { segmentUris: [], variantUri: uris[0] };
  return { initUri, segmentUris: uris };
}

/** Streams init + media segments into one file, in order. Returns bytes written. */
async function writeSegments(playlist: ParsedPlaylist, path: string): Promise<number> {
  const file = Bun.file(path).writer();
  let written = 0;

  try {
    const all = playlist.initUri ? [playlist.initUri, ...playlist.segmentUris] : playlist.segmentUris;
    for (const [index, uri] of all.entries()) {
      const response = await requestWithBackoff(uri, { redirect: "follow" });
      if (!response.ok) {
        throw new DownloadError(`Segment ${index + 1}/${all.length} failed (${response.status})`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      file.write(bytes);
      written += bytes.byteLength;
    }
    await file.flush();
  } finally {
    await file.end();
  }

  return written;
}

/**
 * Lifts the FLAC stream out of the MP4 container without re-encoding.
 *
 * `-c copy` is what keeps this lossless: the bytes are moved, not decoded and re-compressed.
 *
 * `-f flac` is not optional. ffmpeg picks the output format from the filename's extension,
 * and `output` is a temporary `.part` — deliberately not `.flac`, so a scanner watching the
 * library cannot pick it up mid-write. Without the explicit format that is an immediate
 * "Unable to choose an output format" and every single track fails.
 */
export async function demuxFlac(input: string, output: string): Promise<void> {
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) throw new DownloadError("ffmpeg is required to demux FLAC from the MP4 container, but is not on PATH.");

  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      ["-y", "-hide_banner", "-loglevel", "error", "-i", input, "-map", "0:a:0", "-c", "copy", "-f", "flac", output],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status !== 0) reject(new DownloadError(`ffmpeg failed (${status}): ${stderr.trim().slice(0, 300)}`));
      else resolve(status);
    });
  });

  if (code !== 0) throw new DownloadError(`ffmpeg exited with ${code}`);
}

/**
 * TIDAL rate-limits the manifest endpoint hard, and answers a burst with 429 or with a
 * captcha challenge that deauthenticates the session outright. Backing off on 429/5xx is
 * what keeps a long run from tripping that.
 */
const MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 30_000;

async function requestWithBackoff(url: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
    if (response.status !== 429 && response.status < 500) return response;
    if (attempt >= MAX_RETRIES) return response;

    const retryAfter = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, BACKOFF_CAP_MS)
      : Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);

    log.warn("TIDAL pushed back, backing off", {
      status: response.status,
      delayMs: delay,
      attempt: attempt + 1,
      of: MAX_RETRIES,
    });
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

function replaceExtension(path: string, extension: string): string {
  return path.replace(/\.[^./]*$/, "") + `.${extension}`;
}

export { join };
