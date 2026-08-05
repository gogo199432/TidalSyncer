import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demuxFlac, EncryptedStreamError, parsePlaylist } from "./download.ts";

const BASE = "https://sp-ad-cf.audio.tidal.com/manifests/abc/playlist.m3u8";

describe("parsePlaylist", () => {
  test("collects media segments and resolves them against the playlist URL", () => {
    const playlist = [
      "#EXTM3U",
      "#EXT-X-VERSION:6",
      "#EXT-X-TARGETDURATION:10",
      "#EXTINF:10.0,",
      "segment-0.mp4",
      "#EXTINF:10.0,",
      "segment-1.mp4",
      "#EXT-X-ENDLIST",
    ].join("\n");

    const parsed = parsePlaylist(playlist, BASE);

    expect(parsed.segmentUris).toEqual([
      "https://sp-ad-cf.audio.tidal.com/manifests/abc/segment-0.mp4",
      "https://sp-ad-cf.audio.tidal.com/manifests/abc/segment-1.mp4",
    ]);
    expect(parsed.variantUri).toBeUndefined();
  });

  test("picks up the initialisation segment from EXT-X-MAP", () => {
    const playlist = ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', "#EXTINF:10.0,", "segment-0.mp4"].join("\n");

    const parsed = parsePlaylist(playlist, BASE);

    expect(parsed.initUri).toBe("https://sp-ad-cf.audio.tidal.com/manifests/abc/init.mp4");
    expect(parsed.segmentUris).toHaveLength(1);
  });

  test("keeps absolute segment URLs as they are", () => {
    const playlist = ["#EXTM3U", "#EXTINF:10.0,", "https://other.host/seg.mp4"].join("\n");

    expect(parsePlaylist(playlist, BASE).segmentUris).toEqual(["https://other.host/seg.mp4"]);
  });

  test("reports a master playlist as a variant to follow, not as segments", () => {
    const playlist = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=1411000,CODECS=\"flac\"",
      "variant-lossless.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=320000,CODECS=\"mp4a.40.2\"",
      "variant-aac.m3u8",
    ].join("\n");

    const parsed = parsePlaylist(playlist, BASE);

    // TIDAL orders variants best-first, so the first is the one worth following.
    expect(parsed.variantUri).toBe("https://sp-ad-cf.audio.tidal.com/manifests/abc/variant-lossless.m3u8");
    expect(parsed.segmentUris).toEqual([]);
  });

  test("refuses an encrypted playlist rather than writing silence", () => {
    const playlist = [
      "#EXTM3U",
      '#EXT-X-KEY:METHOD=AES-128,URI="https://example.invalid/key"',
      "#EXTINF:10.0,",
      "segment-0.mp4",
    ].join("\n");

    expect(() => parsePlaylist(playlist, BASE)).toThrow(EncryptedStreamError);
  });

  test("accepts an explicitly unencrypted playlist", () => {
    const playlist = ["#EXTM3U", "#EXT-X-KEY:METHOD=NONE", "#EXTINF:10.0,", "segment-0.mp4"].join("\n");

    expect(parsePlaylist(playlist, BASE).segmentUris).toHaveLength(1);
  });

  test("tolerates CRLF line endings and blank lines", () => {
    const playlist = "#EXTM3U\r\n\r\n#EXTINF:10.0,\r\nsegment-0.mp4\r\n";

    expect(parsePlaylist(playlist, BASE).segmentUris).toHaveLength(1);
  });
});

/**
 * Runs the real ffmpeg, because the failure this guards against is entirely ffmpeg's:
 * the output path is a temporary `.part`, and without an explicit `-f flac` ffmpeg cannot
 * infer a format from that extension and refuses every track.
 *
 * Skipped where ffmpeg is absent — the same condition under which `download` refuses to run.
 */
const hasFfmpeg = Boolean(Bun.which("ffmpeg") && Bun.which("ffprobe"));

describe.if(hasFfmpeg)("demuxFlac", () => {
  test("writes a FLAC stream to an output path with no usable extension", async () => {
    const directory = await mkdtemp(join(tmpdir(), "demux-"));
    const source = join(directory, "source.m4a");
    // The shape TIDAL serves: a FLAC stream inside an MP4 container.
    const built = spawnSync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:a", "flac", "-f", "mp4", source,
    ]);
    expect(built.status).toBe(0);

    // Exactly what runDownload passes: `<final>.<pid>.part`, deliberately not `.flac`.
    const output = join(directory, "track.flac.999.part");
    await demuxFlac(source, output);

    expect((await stat(output)).size).toBeGreaterThan(0);

    // Not just "a file appeared" — ffmpeg must agree it is FLAC.
    const probe = spawnSync("ffprobe", [
      "-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=codec_name", "-of", "csv=p=0", output,
    ]);
    expect(probe.stdout.toString().trim()).toBe("flac");

    await rm(directory, { recursive: true, force: true });
  });
});
