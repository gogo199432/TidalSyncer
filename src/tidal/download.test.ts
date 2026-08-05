import { describe, expect, test } from "bun:test";
import { EncryptedStreamError, parsePlaylist } from "./download.ts";

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
