import { readdir } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { log } from "./logger.ts";
import { normalize, stripParentheticals } from "./tidal/match.ts";

/**
 * An index of what is already on disk, so `download` fetches only what is missing.
 *
 * Checking `existsSync(track.path)` is not enough for a library that another tool built.
 * The file will be there under a different extension (`.mp3` from a shop, `.m4a` from a
 * lower TIDAL tier), or under a different album (a single vs. the album it later appeared
 * on, "Deluxe Edition", a compilation), or with punctuation this tool would render
 * differently ("Don't" vs "Don’t", "Vol. 2" vs "Vol 2"). Any of those would redownload a
 * track that is already sitting there.
 *
 * So the index is built once by walking the library, and every file is registered under
 * several progressively looser keys. Lookup tries them strictest-first and reports which
 * tier hit, so a run's skips can be audited rather than taken on trust.
 */

/** What counts as an audio file worth indexing. Everything else in the tree is ignored. */
export const AUDIO_EXTENSIONS = new Set([
  ".flac",
  ".m4a",
  ".mp3",
  ".ogg",
  ".opus",
  ".wav",
  ".aiff",
  ".aif",
  ".alac",
  ".ape",
  ".wma",
  ".wv",
]);

/** Directories that are never music and can be large. */
const SKIP_DIRECTORIES = new Set(["@eaDir", "#recycle", "lost+found"]);

/**
 * Hidden directories are skipped wholesale, which covers the named cases above that used to be
 * listed one by one (`.git`, `.stfolder`, `.Trash-1000`) and every one nobody thought of.
 *
 * Nothing files music in a dotfolder, and everything that scans a library agrees: Navidrome
 * will not index one either. This tool's own transients live in them for exactly that reason —
 * so must its index, or `.replaced/` and `.upgrading-*` come back as library contents.
 */
function isHidden(name: string): boolean {
  return name.startsWith(".");
}

/**
 * Whether the walk refuses to descend into a directory of this name.
 *
 * Exported so anything else that traverses the library — the orphan prune in `repair.ts` —
 * leaves alone exactly what the index never looked at. A directory this tool has never
 * considered part of the library is not one it may tidy up.
 */
export function isSkippedDirectory(name: string): boolean {
  return SKIP_DIRECTORIES.has(name) || isHidden(name);
}

/** `Artist/Album/Disc 2/06 - Track.flac` — the disc folder is not the album. */
const DISC_DIRECTORY = /^(cd|disc|disk|vol|volume)[\s._-]*\d{1,2}$/i;

/**
 * A leading track number: "02 - Title", "01. Title", "13_Title", "06 Title".
 *
 * A separator is required after the digits, so "1979" and "24K Magic" are left alone. It
 * cannot tell "99 Problems" from a numbered track, which is why the stripped form is only
 * ever registered *alongside* the literal filename rather than replacing it.
 */
const TRACK_NUMBER = /^\d{1,3}(?:\s*[.\-_]\s*|\s+)/;

/**
 * How many leading numbers may be stripped from a filename.
 *
 * Two, because "01-05 - The Bidding" is a disc number *and* a track number — the shape
 * Picard writes by default. Stripping once leaves "05 - The Bidding", which matches
 * nothing, so a file named that way is invisible to the index and gets downloaded a second
 * time beside itself.
 *
 * Not unbounded: "1-800-273-8255" would otherwise register as "8255". Two is what the
 * disc-track form needs and nothing beyond it.
 */
const MAX_TRACK_NUMBERS = 2;

/** "F.O.O.L - Destroyer of Speakers". Spaces around the dash, so hyphenated words survive. */
const CREDITED = /^(.+?)\s+-\s+(.+)$/;

export type MatchTier =
  /** Same artist, album and title. */
  | "exact"
  /** Same artist and title, different album — a single, a reissue, a compilation. */
  | "album-agnostic"
  /** Same artist and title once "(Remastered 2011)"-style suffixes are dropped. */
  | "loose";

export type LibraryMatch = {
  /** Absolute path of the file already on disk. */
  path: string;
  tier: MatchTier;
};

export type WantedTrack = {
  artists: string[];
  album?: string;
  title: string;
};

export class LibraryIndex {
  private readonly exact = new Map<string, string>();
  private readonly albumAgnostic = new Map<string, string>();
  private readonly loose = new Map<string, string>();

  private constructor(readonly root: string, readonly fileCount: number) {}

  /**
   * Walks `root` and indexes every audio file found.
   *
   * Artist/album/title come from the directory layout (`.../Artist/Album/Title.ext`) rather
   * than from embedded tags, because reading tags would mean spawning ffprobe once per file
   * — minutes of work on a large library, to answer a question the paths already answer for
   * a conventionally organised one. A missing directory is not an error: a first run into an
   * empty library should download everything, not fail.
   *
   * `exclude` names directories that are inside the library but are not the library — the one
   * that matters is `replacedDir`, which is allowed to sit under `libraryDir` and holds files
   * this tool has already decided are superseded.
   */
  static async build(root: string, options: WalkOptions = {}): Promise<LibraryIndex> {
    let files: string[];

    try {
      files = await listAudioFiles(root, options);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        log.info("Library directory does not exist yet; nothing to skip", { root });
        return new LibraryIndex(root, 0);
      }
      throw error;
    }

    const index = new LibraryIndex(root, files.length);
    for (const file of files) index.register(file);

    log.info("Indexed existing library", { root, files: files.length });
    return index;
  }

  /**
   * Registers one file under every name it could plausibly be looked up by.
   *
   * Real libraries are not tidy. Roughly half the files in the one this was measured
   * against carry a track number ("02 - Deep Jungle Walk.m4a"), some sit under a disc
   * folder, and the flat release folders name the artist in the filename instead of the
   * directory. Keying only on the literal filename misses all three, and a miss means
   * downloading a second copy of a track that is already sitting there.
   *
   * Aliases are only ever *added*, never substituted, so an ambiguous strip ("99 Problems")
   * cannot cost a match that the literal name would have made.
   */
  private register(path: string): void {
    const { artist, album, titles } = describePath(path);

    for (const title of titles) {
      // First writer wins, so the earliest match in a stable walk order is the one reported.
      setIfAbsent(this.exact, exactKey(artist, album, title), path);
      setIfAbsent(this.albumAgnostic, pairKey(artist, title), path);
      setIfAbsent(this.loose, looseKey(artist, title), path);

      // The directory may be a release rather than an artist, with the artist in the
      // filename. No album to key on, so this only reaches the album-agnostic tiers.
      const credited = CREDITED.exec(title);
      if (credited) {
        const [, credit, remainder] = credited as unknown as [string, string, string];
        setIfAbsent(this.albumAgnostic, pairKey(credit, remainder), path);
        setIfAbsent(this.loose, looseKey(credit, remainder), path);
      }
    }
  }

  /**
   * Finds an existing file for a wanted track, or undefined.
   *
   * Every credited artist is tried, not just the first: an existing library may well file a
   * collaboration under the second name, and TIDAL's credit order is not authoritative.
   */
  find(track: WantedTrack): LibraryMatch | undefined {
    const artists = track.artists.length > 0 ? track.artists : ["Unknown Artist"];

    for (const artist of artists) {
      if (track.album) {
        const hit = this.exact.get(exactKey(artist, track.album, track.title));
        if (hit) return { path: hit, tier: "exact" };
      }
    }

    for (const artist of artists) {
      const hit = this.albumAgnostic.get(pairKey(artist, track.title));
      if (hit) return { path: hit, tier: "album-agnostic" };
    }

    for (const artist of artists) {
      const hit = this.loose.get(looseKey(artist, track.title));
      if (hit) return { path: hit, tier: "loose" };
    }

    return undefined;
  }

  /**
   * Registers a file that has just landed, so the rest of the run can see it.
   *
   * The index is a snapshot of the library as the run found it, and a run downloads into
   * that library as it goes. Without this, a track reachable twice in one export — as a
   * single and again on a compilation, or from two playlists — is missing both times it is
   * looked at, and lands twice under two album folders.
   */
  add(path: string): void {
    this.register(path);
  }

  /** Library-relative path, for logging something shorter than the absolute one. */
  relative(path: string): string {
    return relative(this.root, path);
  }
}

/**
 * What a file's own path claims it is.
 *
 * Exported because the tag backfill asks the question from the other end: the index answers
 * "which file is this track?", and a file with no tags needs "which track is this file?"
 * answered from the only evidence it has — where it sits. Sharing the reading keeps the two
 * directions agreeing about what `Artist/Album/Disc 2/03 - Title.flac` means.
 *
 * `titles` holds the filename as written and, when they differ, the same thing without a
 * leading track number. Both, never one instead of the other: "99 Problems" is a title that
 * starts with a number, and no rule can tell it from a numbered track.
 */
export function describePath(path: string): { artist: string; album: string; titles: string[] } {
  const stem = basename(path, extname(path));
  let album = basename(dirname(path));
  let artist = basename(dirname(dirname(path)));

  if (DISC_DIRECTORY.test(album)) {
    album = basename(dirname(dirname(path)));
    artist = basename(dirname(dirname(dirname(path))));
  }

  // Every intermediate is kept, not just the fully stripped form: "01-05 - The Bidding" is
  // also plausibly a track called "05 - The Bidding", and the looser reading must not cost
  // the tighter one a match.
  const titles = [stem];
  for (let i = 0; i < MAX_TRACK_NUMBERS; i += 1) {
    const stripped = titles[titles.length - 1]!.replace(TRACK_NUMBER, "").trim();
    if (!stripped || stripped === titles[titles.length - 1]) break;
    titles.push(stripped);
  }

  return { artist, album, titles };
}

/** Same artist, album and title, folded. Exported so the backfill can key a snapshot by it. */
export function exactKey(artist: string, album: string, title: string): string {
  return `${normalize(artist)} ${normalize(album)} ${normalize(title)}`;
}

/** Same artist and title, whatever the album. */
export function pairKey(artist: string, title: string): string {
  return `${normalize(artist)} ${normalize(title)}`;
}

function looseKey(artist: string, title: string): string {
  return `${stripParentheticals(normalize(artist))} ${stripParentheticals(normalize(title))}`;
}

function setIfAbsent(map: Map<string, string>, key: string, value: string): void {
  if (!map.has(key)) map.set(key, value);
}

export type WalkOptions = {
  /**
   * Directories inside the library that are not the library. The one that matters is
   * `replacedDir`, which is allowed to sit under `libraryDir` and holds superseded files.
   */
  exclude?: Array<string | undefined>;
};

/**
 * Every audio file under `root`, by the same rules the index uses.
 *
 * Exported so the tag backfill walks exactly what the index walks. Two definitions of "the
 * library" is how a file ends up being tagged that the downloader will never look at, or the
 * other way round.
 */
export async function listAudioFiles(root: string, options: WalkOptions = {}): Promise<string[]> {
  const files: string[] = [];
  const excluded = new Set(
    (options.exclude ?? []).filter((path): path is string => Boolean(path)).map((path) => resolve(path)),
  );

  await walk(root, files, excluded);
  return files;
}

async function walk(directory: string, into: string[], excluded: Set<string>): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (isSkippedDirectory(entry.name) || excluded.has(resolve(path))) continue;
      await walk(path, into, excluded);
    } else if (entry.isFile() && AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      into.push(path);
    }
  }
}
