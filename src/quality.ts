import { spawn } from "node:child_process";
import { log } from "./logger.ts";
import type { Quality } from "./tidal/download.ts";

/**
 * Deciding whether TIDAL actually has something better than the file already on disk.
 *
 * The skip index deliberately reads nothing but paths, because answering "is this track
 * here?" from directory names costs nothing. "Is the copy here worse than TIDAL's?" cannot
 * be answered that way — a `.flac` extension says lossless but not whether it is 16 or 24
 * bit, and an `.m4a` could be AAC or ALAC. So this probes, and only for tracks that matched,
 * and only when upgrading was asked for.
 */

/** Coarse on purpose: three rungs everyone agrees on, rather than arguing about bitrates. */
export type QualityTier = "lossy" | "lossless" | "hires";

const LADDER: QualityTier[] = ["lossy", "lossless", "hires"];

export type LocalQuality = {
  tier: QualityTier;
  codec: string;
  /** Absent for lossy codecs, which have no meaningful sample depth. */
  bitDepth?: number;
  sampleRate?: number;
};

/** Codecs that carry the original samples. Anything else is treated as lossy. */
const LOSSLESS_CODECS = new Set(["flac", "alac", "ape", "wavpack", "tta", "truehd", "mlp"]);

/** Above CD: 24-bit, or a sample rate beyond what CD and DAT use. */
const HIRES_BIT_DEPTH = 24;
const HIRES_SAMPLE_RATE = 48_000;

/** How long to wait on one file before giving up on it. A hung NFS read must not stall a run. */
const PROBE_TIMEOUT_MS = 15_000;

export function rank(tier: QualityTier): number {
  return LADDER.indexOf(tier);
}

/**
 * What TIDAL says it has for a track, from the export's `mediaTags`.
 *
 * DOLBY_ATMOS appears alongside the others and is deliberately ignored: it is a different
 * mix rather than a better one, and this tool downloads stereo.
 */
export function offeredTier(mediaTags: string[] | undefined): QualityTier {
  if (!mediaTags || mediaTags.length === 0) return "lossless"; // TIDAL's floor for a full track
  if (mediaTags.includes("HIRES_LOSSLESS")) return "hires";
  if (mediaTags.includes("LOSSLESS")) return "lossless";
  return "lossy";
}

/** The ceiling imposed by the quality the run was asked for. */
export function requestedTier(quality: Quality): QualityTier {
  if (quality === "hires") return "hires";
  if (quality === "lossless") return "lossless";
  return "lossy";
}

/**
 * The tier a download would actually produce: the best TIDAL offers, capped by what was
 * asked for. Comparing against TIDAL's offer alone would promise a hi-res upgrade and then
 * write a 16-bit file, because `downloadTrack` only ever requests the configured tier.
 */
export function attainableTier(mediaTags: string[] | undefined, quality: Quality): QualityTier {
  return rank(offeredTier(mediaTags)) < rank(requestedTier(quality))
    ? offeredTier(mediaTags)
    : requestedTier(quality);
}

/**
 * Reads the first audio stream's codec and sample format.
 *
 * Returns undefined when the file cannot be read or understood — a corrupt file, or a codec
 * ffprobe does not know. Callers treat that as "leave it alone": replacing a file this cannot
 * even describe would be the wrong way to resolve the uncertainty.
 */
export async function probeQuality(path: string): Promise<LocalQuality | undefined> {
  const ffprobe = Bun.which("ffprobe");
  if (!ffprobe) return undefined;

  let raw: string;
  try {
    raw = await run(ffprobe, [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=codec_name,bits_per_raw_sample,bits_per_sample,sample_rate",
      // JSON rather than csv: ffprobe emits csv fields in stream order, not the order asked
      // for, so positional parsing silently mixes up sample rate and bit depth.
      "-of", "json",
      path,
    ]);
  } catch (error) {
    log.debug("Could not probe file", { path, error: String(error) });
    return undefined;
  }

  let stream: Record<string, unknown> | undefined;
  try {
    stream = (JSON.parse(raw) as { streams?: Record<string, unknown>[] }).streams?.[0];
  } catch {
    return undefined;
  }
  if (!stream || typeof stream.codec_name !== "string") return undefined;

  const codec = stream.codec_name;
  // `bits_per_raw_sample` is the real depth; `bits_per_sample` is the container's storage
  // width and reads 0 for FLAC. Prefer the former and ignore zeroes from either.
  const bitDepth = number(stream.bits_per_raw_sample) || number(stream.bits_per_sample) || undefined;
  const sampleRate = number(stream.sample_rate) || undefined;

  // ffprobe will guess a codec from the extension alone and exit 0 on a file that is not
  // audio at all, reporting no rate. Real audio always has one, so its absence means this
  // could not be read — and an unreadable file must not be judged worse than TIDAL's copy.
  if (!sampleRate) return undefined;

  const lossless = LOSSLESS_CODECS.has(codec) || codec.startsWith("pcm_");
  if (!lossless) return { tier: "lossy", codec, sampleRate };

  const hires = (bitDepth ?? 0) >= HIRES_BIT_DEPTH || (sampleRate ?? 0) > HIRES_SAMPLE_RATE;
  return { tier: hires ? "hires" : "lossless", codec, bitDepth, sampleRate };
}

/** Human-readable, for the log line that says why a file is being replaced. */
export function describeQuality(quality: LocalQuality): string {
  const parts = [quality.codec];
  if (quality.bitDepth) parts.push(`${quality.bitDepth}-bit`);
  if (quality.sampleRate) parts.push(`${(quality.sampleRate / 1000).toFixed(1)}kHz`);
  return parts.join(" ");
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ffprobe timed out after ${PROBE_TIMEOUT_MS}ms`));
    }, PROBE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (status === 0) resolve(stdout);
      else reject(new Error(stderr.trim().slice(0, 200) || `ffprobe exited with ${status}`));
    });
  });
}
