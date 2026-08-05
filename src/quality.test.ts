import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attainableTier, offeredTier, probeQuality, rank, requestedTier } from "./quality.ts";

describe("offeredTier", () => {
  test("reads TIDAL's mediaTags", () => {
    expect(offeredTier(["LOSSLESS"])).toBe("lossless");
    expect(offeredTier(["HIRES_LOSSLESS", "LOSSLESS"])).toBe("hires");
  });

  test("ignores DOLBY_ATMOS, which is a different mix rather than a better one", () => {
    expect(offeredTier(["DOLBY_ATMOS", "LOSSLESS"])).toBe("lossless");
    expect(offeredTier(["DOLBY_ATMOS", "HIRES_LOSSLESS", "LOSSLESS"])).toBe("hires");
  });

  test("assumes lossless when TIDAL says nothing, which is its floor for a full track", () => {
    expect(offeredTier(undefined)).toBe("lossless");
    expect(offeredTier([])).toBe("lossless");
  });
});

describe("attainableTier", () => {
  test("is capped by the quality the run asked for", () => {
    // TIDAL has hi-res, but a lossless run only ever requests FLAC 16 — promising an
    // upgrade here and then writing 16-bit would be a lie.
    expect(attainableTier(["HIRES_LOSSLESS", "LOSSLESS"], "lossless")).toBe("lossless");
    expect(attainableTier(["HIRES_LOSSLESS", "LOSSLESS"], "hires")).toBe("hires");
  });

  test("is capped by what TIDAL actually has", () => {
    expect(attainableTier(["LOSSLESS"], "hires")).toBe("lossless");
  });

  test("collapses the AAC tiers to lossy", () => {
    expect(requestedTier("high")).toBe("lossy");
    expect(requestedTier("low")).toBe("lossy");
    expect(attainableTier(["HIRES_LOSSLESS", "LOSSLESS"], "high")).toBe("lossy");
  });
});

describe("rank", () => {
  test("orders the ladder", () => {
    expect(rank("lossy")).toBeLessThan(rank("lossless"));
    expect(rank("lossless")).toBeLessThan(rank("hires"));
  });
});

/**
 * Real files through the real ffprobe. The bug this guards against is a silent one: ffprobe
 * emits csv fields in stream order rather than the order asked for, so positional parsing
 * reads a 44100 sample rate as a bit depth and calls every CD-quality file hi-res.
 */
const hasFfmpeg = Boolean(Bun.which("ffmpeg") && Bun.which("ffprobe"));

let directory: string;

const encode = (name: string, args: string[]) => {
  const path = join(directory, name);
  const result = spawnSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    ...args, path,
  ]);
  expect(result.status).toBe(0);
  return path;
};

describe.if(hasFfmpeg)("probeQuality", () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "quality-"));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("calls CD-quality FLAC lossless, not hi-res", async () => {
    const path = encode("cd.flac", ["-c:a", "flac", "-ar", "44100", "-sample_fmt", "s16"]);
    const quality = await probeQuality(path);
    expect(quality?.tier).toBe("lossless");
    expect(quality?.codec).toBe("flac");
    expect(quality?.bitDepth).toBe(16);
    expect(quality?.sampleRate).toBe(44_100);
  });

  test("calls 24-bit FLAC hi-res", async () => {
    const path = encode("hires.flac", ["-c:a", "flac", "-ar", "48000", "-sample_fmt", "s32"]);
    expect((await probeQuality(path))?.tier).toBe("hires");
  });

  test("calls a high sample rate hi-res even at 16 bit", async () => {
    const path = encode("fast.flac", ["-c:a", "flac", "-ar", "96000", "-sample_fmt", "s16"]);
    expect((await probeQuality(path))?.tier).toBe("hires");
  });

  test("calls AAC and MP3 lossy", async () => {
    // The overwhelming majority of the library this was built for.
    expect((await probeQuality(encode("a.m4a", ["-c:a", "aac"])))?.tier).toBe("lossy");
    expect((await probeQuality(encode("b.mp3", ["-c:a", "libmp3lame"])))?.tier).toBe("lossy");
  });

  test("calls ALAC in an .m4a lossless, which the extension alone cannot tell you", async () => {
    const path = encode("alac.m4a", ["-c:a", "alac"]);
    const quality = await probeQuality(path);
    expect(quality?.tier).toBe("lossless");
    expect(quality?.codec).toBe("alac");
  });

  test("calls WAV lossless", async () => {
    expect((await probeQuality(encode("c.wav", ["-c:a", "pcm_s16le"])))?.tier).toBe("lossless");
  });

  test("returns undefined for a file it cannot read, rather than guessing", async () => {
    const path = join(directory, "broken.flac");
    await writeFile(path, "not audio");
    expect(await probeQuality(path)).toBeUndefined();
    expect(await probeQuality(join(directory, "absent.flac"))).toBeUndefined();
  });
});
