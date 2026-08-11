import { spawn } from "node:child_process";
import { rename, rm } from "node:fs/promises";
import { extname } from "node:path";
import type { Enrichment } from "./enrich.ts";
import { log } from "./logger.ts";
import type { TrackDetail } from "./tidal/catalog.ts";

/**
 * Writing what is known about a track into the file itself.
 *
 * A path is not metadata. `Artist/Album/Title.flac` is enough for a human reading a directory
 * listing and enough for this tool's own skip index, but every music server worth pointing at
 * a library reads tags and nothing else: Navidrome files an untagged track under
 * "[Unknown Artist]" / "[Unknown Album]" with the filename as its title, no year and no track
 * number, no matter how tidy the folder it sits in is.
 *
 * Nothing this tool fetches arrives tagged. TIDAL serves HLS segments carrying audio and a
 * container brand, so the FLAC that comes out of the demux has `major_brand` and an encoder
 * string on it and not one word about the music. The export already resolved every id to
 * artist/album/title/date/ISRC to build the path — this is that same metadata, put where a
 * scanner will actually look for it.
 */

/** What gets written. Deliberately a subset of `TrackDetail`: only fields a tag maps to. */
export type TrackTags = {
  title: string;
  /** Every credited artist, in TIDAL's order. The first is the one the file is filed under. */
  artists: string[];
  album?: string;
  /** ISO 8601. Both Vorbis DATE and MP4 ©day take a full date, and readers take the year. */
  releaseDate?: string;
  isrc?: string;
  /** From MusicBrainz, via ListenBrainz. TIDAL has no genre to give. */
  genre?: string;
  /**
   * MusicBrainz identifiers. What makes a file say what it *is* rather than what it is
   * called: a server can link straight out to the recording, and anything re-reading this
   * library later matches exactly instead of guessing at spellings.
   */
  mbids?: {
    recording?: string;
    artist?: string;
    release?: string;
    releaseGroup?: string;
  };
};

export class FfmpegError extends Error {}

/**
 * Suffix for the temporary a retag writes before it takes the original's name.
 *
 * Carries no audio extension, for the same reason `RAW_SUFFIX` does not: whatever is watching
 * the library must not index a half-written file, and `sweepInterrupted` must be able to
 * recognise it as litter after a hard kill. Kept in step with the pattern in `download.ts`.
 */
export const TAG_SUFFIX = ".tidalsyncer-tag";

/** ffmpeg names the output format itself; the extension alone will not tell it. */
const OUTPUT_FORMATS: Record<string, string> = {
  ".flac": "flac",
  ".m4a": "mp4",
  ".mp3": "mp3",
  ".ogg": "ogg",
  ".opus": "opus",
};

/**
 * Container bookkeeping that ffprobe reports as tags but which says nothing about the music.
 *
 * A demuxed TIDAL track carries exactly these and no more, which is precisely the state this
 * module exists to fix — so a file holding only these has to read as untagged, or the backfill
 * would decide every one of them was already done.
 */
const NON_METADATA_TAGS = new Set([
  "major_brand",
  "minor_version",
  "compatible_brands",
  "encoder",
  "encoded_by",
  "creation_time",
  "handler_name",
  "vendor_id",
  "media_type",
]);

/**
 * Everything the snapshot knows about a track, as tags.
 *
 * TIDAL's half is the names and the ISRC; MusicBrainz's is the genre and the identifiers. The
 * release year is taken from MusicBrainz only when TIDAL gave no date at all — TIDAL knows
 * what it sold you, and a track's own release is a better answer than the earliest release of
 * the recording.
 */
export function tagsFor(track: TrackDetail & { enrichment?: Enrichment }): TrackTags {
  const enrichment = track.enrichment;

  return {
    title: track.title,
    artists: track.artists,
    album: track.album,
    releaseDate: track.releaseDate ?? (enrichment?.year ? String(enrichment.year) : undefined),
    isrc: track.isrc,
    genre: enrichment?.genres?.[0],
    ...(enrichment
      ? {
          mbids: {
            recording: enrichment.recordingMbid,
            artist: enrichment.artistMbids?.[0],
            release: enrichment.releaseMbid,
            releaseGroup: enrichment.releaseGroupMbid,
          },
        }
      : {}),
  };
}

/**
 * The `-metadata` arguments for one track.
 *
 * `artist` is the first credit rather than the whole list, so the artist a server groups the
 * track under is the same one the file is filed under — a library where the folder says
 * "Bakermat" and the tag says "Bakermat; Barbara Dane" grows a second artist for every
 * collaboration. The full credit goes on as `artists`, which is where the multi-value-aware
 * readers look and which nothing else misinterprets.
 *
 * ffmpeg maps the lowercase keys to each container's own spelling (Vorbis `TITLE`, MP4 `©nam`,
 * ID3 `TIT2`), so the same list works for every format this writes.
 *
 * The uppercase ones are Vorbis-only in practice. MP4 has no atom for them and ffmpeg has no
 * way to write the iTunes freeform ones taggers use instead, so an `.m4a` keeps the names, the
 * date, the genre and the cover, and quietly loses the ISRC and the MusicBrainz identifiers.
 * That is the AAC fallback tier rather than the normal case, and it is a better trade than
 * making the FLAC tier — which takes all of it — go without.
 */
export function metadataArgs(tags: TrackTags): string[] {
  const fields: Array<[string, string | undefined]> = [
    ["title", tags.title],
    ["artist", tags.artists[0]],
    ["album_artist", tags.artists[0]],
    ["artists", tags.artists.length > 1 ? tags.artists.join("; ") : undefined],
    ["album", tags.album],
    ["date", tags.releaseDate],
    ["genre", tags.genre],
    // The handle that outlives the catalogue entry, and what makes a file re-resolvable
    // against MusicBrainz once TIDAL has forgotten the track.
    ["ISRC", tags.isrc],
    // Picard's spellings, because they are what every reader already understands.
    // MUSICBRAINZ_TRACKID has meant the recording id in file tags since long before
    // MUSICBRAINZ_RECORDINGID existed, so both are written and both say the same thing.
    ["MUSICBRAINZ_TRACKID", tags.mbids?.recording],
    ["MUSICBRAINZ_RECORDINGID", tags.mbids?.recording],
    ["MUSICBRAINZ_ARTISTID", tags.mbids?.artist],
    ["MUSICBRAINZ_ALBUMARTISTID", tags.mbids?.artist],
    ["MUSICBRAINZ_ALBUMID", tags.mbids?.release],
    ["MUSICBRAINZ_RELEASEGROUPID", tags.mbids?.releaseGroup],
  ];

  return fields.flatMap(([key, value]) => (value ? ["-metadata", `${key}=${value}`] : []));
}

/** What a file already says about itself. */
export type FileTags = {
  tags: Record<string, string>;
  /** Cover art embedded as a stream. A retag would drop it, so one is a reason not to. */
  hasArtwork: boolean;
};

export function hasFfmpeg(): boolean {
  return Boolean(Bun.which("ffmpeg"));
}

/**
 * Reads a file's tags, or undefined when it cannot be read at all.
 *
 * The distinction matters to every caller: "no tags" is something to fix, "unreadable" is
 * something to leave alone.
 */
export async function readTags(path: string): Promise<FileTags | undefined> {
  const ffprobe = Bun.which("ffprobe");
  if (!ffprobe) return undefined;

  let raw: string;
  try {
    raw = await run(ffprobe, [
      "-v", "error",
      "-show_entries", "format_tags:stream=codec_type,sample_rate",
      "-of", "json",
      path,
    ]);
  } catch (error) {
    log.debug("Could not read tags", { path, error: String(error) });
    return undefined;
  }

  let parsed: {
    format?: { tags?: Record<string, string> };
    streams?: Array<{ codec_type?: string; sample_rate?: string }>;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return undefined;
  }

  // ffprobe guesses a codec from the extension alone and exits 0 on a file that is not audio
  // at all, reporting no rate — the same trap `probeQuality` sidesteps. Real audio always has
  // a sample rate, and without one this cannot claim the file is merely untagged.
  const audio = (parsed.streams ?? []).find((stream) => stream.codec_type === "audio");
  if (!audio || !Number(audio.sample_rate)) return undefined;

  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.format?.tags ?? {})) {
    if (!NON_METADATA_TAGS.has(key.toLowerCase())) tags[key.toLowerCase()] = value;
  }

  return {
    tags,
    hasArtwork: (parsed.streams ?? []).some((stream) => stream.codec_type === "video"),
  };
}

/**
 * Whether a file says nothing about what it is.
 *
 * Title *and* artist, not either: a file with one of the two is something another tool wrote
 * and half-filled, and completing someone else's tags is not this tool's business. A file with
 * neither is one nothing has ever described.
 */
export function isUntagged(file: FileTags): boolean {
  return !file.tags.title && !file.tags.artist;
}

/**
 * Rewrites a file with these tags on it, in place.
 *
 * A remux, not a re-encode: `-c copy` moves the frames across untouched, so this costs a read
 * and a write and changes not one sample. The new file is built beside the old one and renamed
 * over it, because the library is usually a share something else is scanning and a file that
 * briefly does not exist is a track that briefly vanishes from someone's index.
 *
 * Only the first audio stream survives. Cover art would need the mapping to carry a video
 * stream into a container that may not take that codec, which is a way to fail on files this
 * has no business touching — so `backfillTags` refuses artwork rather than dropping it, and
 * this stays simple.
 */
export async function writeTags(path: string, tags: TrackTags, artwork?: string): Promise<void> {
  const format = OUTPUT_FORMATS[extname(path).toLowerCase()];
  if (!format) throw new FfmpegError(`No ffmpeg output format is known for ${extname(path) || "a file with no extension"}`);

  const temporary = `${path}.${process.pid}${TAG_SUFFIX}`;
  try {
    await runFfmpeg([
      "-i", path,
      ...artworkInputs(artwork),
      "-map", "0:a:0",
      // The source's own metadata is the container brands the demux left behind. Dropping it
      // first is what keeps `major_brand` from surviving into a file that is now tagged.
      "-map_metadata", "-1",
      ...metadataArgs(tags),
      ...artworkArgs(artwork),
      "-c", "copy",
      "-f", format,
      temporary,
    ]);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** The cover as a second input, when there is one. */
export function artworkInputs(artwork?: string): string[] {
  return artwork ? ["-i", artwork] : [];
}

/**
 * Carries that second input in as embedded cover art.
 *
 * `attached_pic` is what makes the difference between a picture stream — which a player would
 * try to *play*, and which some containers reject outright — and a cover a scanner will show.
 * The stream title and comment are the conventional ones every tagger writes, and are what
 * readers look at to decide which of several pictures is the front cover.
 */
export function artworkArgs(artwork?: string): string[] {
  if (!artwork) return [];
  return [
    "-map", "1:v:0",
    "-disposition:v:0", "attached_pic",
    "-metadata:s:v:0", "title=Album cover",
    "-metadata:s:v:0", "comment=Cover (front)",
  ];
}

/**
 * Runs ffmpeg with the flags every call here wants, and turns a non-zero exit into an error
 * carrying the stderr — ffmpeg says why on stderr and nothing else does.
 */
export async function runFfmpeg(args: string[]): Promise<void> {
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) throw new FfmpegError("ffmpeg is not on PATH");

  const stderr = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let output = "";
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status === 0) resolve(output);
      else reject(new FfmpegError(`ffmpeg failed (${status}): ${output.trim().slice(0, 300)}`));
    });
  });

  if (stderr.trim()) log.debug("ffmpeg wrote to stderr but succeeded", { stderr: stderr.trim().slice(0, 300) });
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (status) => {
      if (status === 0) resolve(stdout);
      else reject(new Error(stderr.trim().slice(0, 200) || `exited with ${status}`));
    });
  });
}
