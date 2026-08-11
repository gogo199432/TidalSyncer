import type { Dirent } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import type { Config } from "./config.ts";
import { CoverStore } from "./covers.ts";
import { readManifest } from "./download.ts";
import { sanitize, type ExportedTrack, type ExportManifest } from "./export.ts";
import {
  AUDIO_EXTENSIONS,
  describePath,
  exactKey,
  isSkippedDirectory,
  listAudioFiles,
  pairKey,
} from "./library.ts";
import { log } from "./logger.ts";
import { hasFfmpeg, isUntagged, readTags, tagsFor, writeTags } from "./tags.ts";

/**
 * Undoing what earlier versions of this tool left in a library.
 *
 * Two marks, both from the same era. Downloads used to be written with no tags at all, on the
 * theory that `Artist/Album/Title.flac` was enough — it is not, for anything that reads tags
 * and not paths, which is every music server there is. And an upgrade used to retire the file
 * it replaced without a thought for what sat next to it, leaving album folders holding a
 * cover and a lyrics file and no music.
 *
 * Both are fixed at the source now — `src/tags.ts` for the first, and nothing here prevents
 * the second, which is simply what an upgrade does. What this offers is the one-off pass over
 * the files that predate the fix, because nothing else will ever revisit them: a download run
 * skips what is already on disk, so an untagged track stays untagged for ever.
 */

export type RepairReport = {
  dryRun: boolean;
  tags: TagBackfillReport;
  orphans: OrphanReport;
};

export type TagBackfillReport = {
  /** Audio files walked. */
  files: number;
  /** Of those, the ones carrying neither a title nor an artist. */
  untagged: number;
  /** Untagged files the snapshot could name, and which now say so. */
  tagged: number;
  /** Of those, the ones that also gained embedded cover art. */
  artworkAdded: number;
  /**
   * Untagged, but nothing in the snapshot matches where they sit. Someone else's rip, or a
   * track that has left the collection since it was downloaded. Left alone.
   */
  unmatched: number;
  /** Untagged and carrying cover art, which a retag would drop. Left alone deliberately. */
  artwork: number;
  failed: number;
  /** True when ffprobe/ffmpeg were missing, so nothing could be read or written at all. */
  skipped: boolean;
};

export type OrphanReport = {
  /** Directories that held no audio, anywhere beneath them. */
  removed: number;
  /** The leftovers inside them — covers, lyrics, playlists. */
  files: number;
  /** Library-relative, capped for the log. */
  examples: string[];
};

export type RepairOptions = {
  /** Report what would happen and change nothing. */
  dryRun: boolean;
  /** Write tags into files that have none. */
  tags: boolean;
  /** Remove album folders left with no audio in them. */
  orphans: boolean;
};

/** How many removed folders to name in the report before it becomes a wall of text. */
const EXAMPLE_LIMIT = 20;

/** Progress every this many files, so a library-sized pass says something while it runs. */
const PROGRESS_EVERY = 25;

/**
 * Files that are *about* music rather than music: cover art, lyrics, playlists, the logs a
 * ripper leaves. A directory holding nothing else has lost whatever they described.
 *
 * The judgement is deliberately one-way. Anything not on this list — an archive, a video, a
 * document, a file with no extension at all — makes the directory something this does not
 * understand, and something it does not understand is something it leaves alone.
 */
const LEFTOVER_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff",
  ".lrc", ".txt", ".nfo", ".cue", ".log", ".md5", ".sfv", ".accurip",
  ".m3u", ".m3u8", ".pls", ".xspf",
  ".ini", ".db", ".url", ".sub", ".srt",
]);

/**
 * A marker asking a scanner to ignore this directory. Its presence means somebody meant for
 * the folder to be there and to be empty of music, which is the opposite of an orphan.
 */
const DELIBERATE = new Set([".ndignore", ".nomedia"]);

export async function runRepair(config: Config, options: RepairOptions): Promise<RepairReport> {
  log.info(options.dryRun ? "Planning a library repair" : "Repairing the library", {
    library: config.libraryDir,
    tags: options.tags,
    orphanFolders: options.orphans,
  });

  return {
    dryRun: options.dryRun,
    tags: options.tags
      ? await backfillTags(config, options)
      : { files: 0, untagged: 0, tagged: 0, artworkAdded: 0, unmatched: 0, artwork: 0, failed: 0, skipped: true },
    // After the tagging, deliberately: a retag rewrites files, and a folder that loses its
    // last audio file to a failed one would be a folder this then deletes the cover from.
    orphans: options.orphans
      ? await pruneOrphanFolders(config, options)
      : { removed: 0, files: 0, examples: [] },
  };
}

/**
 * Writes tags into library files that have none, taking them from the export snapshot.
 *
 * Works from the files rather than from the snapshot, which is the only way round that finds
 * them. Asking "where is this track?" hits the library index, and the index answers with
 * whichever copy it registered first — quite possibly a properly tagged file the user already
 * had, leaving the untagged one this exists to fix untouched. Asking each untagged file "what
 * are you?" cannot miss in that way.
 *
 * Nothing that already says anything about itself is touched. That is the whole safety
 * argument: a file with a title or an artist was tagged by something, and TIDAL's idea of the
 * spelling does not get to overrule it.
 */
export async function backfillTags(config: Config, options: RepairOptions): Promise<TagBackfillReport> {
  const report: TagBackfillReport = {
    files: 0,
    untagged: 0,
    tagged: 0,
    artworkAdded: 0,
    unmatched: 0,
    artwork: 0,
    failed: 0,
    skipped: false,
  };

  if (!Bun.which("ffprobe") || !hasFfmpeg()) {
    log.error("Cannot backfill tags: ffprobe and ffmpeg are both needed and at least one is not on PATH");
    report.skipped = true;
    return report;
  }

  const snapshot = new Snapshot(await readManifest(config));
  const covers = new CoverStore(join(config.dataDir, "covers"));
  const files = await listAudioFiles(config.libraryDir, { exclude: [config.replacedDir] });
  report.files = files.length;

  log.info("Reading tags", { files: files.length, tracksInSnapshot: snapshot.size });

  for (const [position, path] of files.entries()) {
    if (position > 0 && position % PROGRESS_EVERY === 0) {
      log.info(`[${position}/${files.length}] reading tags`, { tagged: report.tagged, untagged: report.untagged });
    }

    const existing = await readTags(path);
    // Unreadable is not untagged. A file ffprobe cannot describe is one to leave exactly as
    // it is, rather than one to rewrite on the strength of its filename.
    if (!existing) {
      report.failed += 1;
      log.warn("Could not read a file's tags, so it was left alone", { path });
      continue;
    }
    if (!isUntagged(existing)) continue;

    report.untagged += 1;

    if (existing.hasArtwork) {
      report.artwork += 1;
      log.info("Left an untagged file alone because it carries cover art a retag would drop", { path });
      continue;
    }

    const track = snapshot.match(path);
    if (!track) {
      report.unmatched += 1;
      log.debug("Untagged, but nothing in the snapshot matches this path", {
        path: relative(config.libraryDir, path),
      });
      continue;
    }

    if (options.dryRun) {
      report.tagged += 1;
      log.info("Would tag", { path: relative(config.libraryDir, path), as: `${track.artists[0]} - ${track.title}` });
      continue;
    }

    try {
      const artwork = await covers.pathFor(track.enrichment);
      await writeTags(path, tagsFor(track), artwork);
      report.tagged += 1;
      if (artwork) report.artworkAdded += 1;
      log.info("Tagged", { path: relative(config.libraryDir, path), as: `${track.artists[0]} - ${track.title}` });
    } catch (error) {
      report.failed += 1;
      log.warn("Could not write tags", { path, error: String(error) });
    }
  }

  return report;
}

/**
 * The export snapshot, keyed the way a path can be looked up in it.
 *
 * Both the raw names TIDAL reported and the sanitised ones this tool writes into paths, since
 * a file called `ACDC/…` has to find a track credited to "AC/DC". `normalize` folds most of
 * that difference away on its own; registering both closes the rest.
 */
class Snapshot {
  private readonly exact = new Map<string, ExportedTrack>();
  private readonly pair = new Map<string, ExportedTrack>();

  constructor(manifest: ExportManifest) {
    for (const track of Object.values(manifest.tracks)) {
      for (const artist of track.artists.length > 0 ? track.artists : ["Unknown Artist"]) {
        // "Unknown Album" as well as the real one: that is the literal folder name
        // `libraryPathFor` writes for a track TIDAL gave no album for.
        for (const album of [track.album, "Unknown Album"]) {
          if (!album) continue;
          setIfAbsent(this.exact, exactKey(artist, album, track.title), track);
          setIfAbsent(this.exact, exactKey(sanitize(artist), sanitize(album), sanitize(track.title)), track);
        }
        setIfAbsent(this.pair, pairKey(artist, track.title), track);
        setIfAbsent(this.pair, pairKey(sanitize(artist), sanitize(track.title)), track);
      }
    }
  }

  get size(): number {
    return this.pair.size;
  }

  /**
   * The track a file's path says it holds, or undefined.
   *
   * Artist and title must agree; the album need not. A file this tool wrote matches exactly,
   * and the album-agnostic tier is what catches the ones it wrote under a different release —
   * a Soulseek rescue filed under the album MusicBrainz named, a folder renamed since. It
   * deliberately stops there: the index's `loose` tier drops bracketed suffixes, which is fine
   * for deciding not to download a second copy of a track and much too casual for deciding
   * what to write into a file.
   */
  match(path: string): ExportedTrack | undefined {
    const { artist, album, titles } = describePath(path);

    for (const title of titles) {
      const hit = this.exact.get(exactKey(artist, album, title));
      if (hit) return hit;
    }

    for (const title of titles) {
      const hit = this.pair.get(pairKey(artist, title));
      if (hit) return hit;
    }

    return undefined;
  }
}

function setIfAbsent<T>(map: Map<string, T>, key: string, value: T): void {
  if (!map.has(key)) map.set(key, value);
}

/**
 * Removes directories that hold no music anywhere beneath them.
 *
 * What produces them: an upgrade retires `Artist/Album/Title.m4a` and writes the replacement
 * at the path the *snapshot* names, which is TIDAL's release rather than the one the folder
 * was called after — "16 Tons" where the library said "Tennessee Ernie Ford - Sixteen Tons".
 * The audio moves, the cover and the .lrc do not, and what is left is a folder a scanner shows
 * as an album with no tracks in it.
 *
 * Conservative by construction. A directory goes only when every file beneath it is a known
 * sidecar — art, lyrics, playlists, ripper logs — and every subdirectory beneath it is going
 * too. One file it cannot account for keeps the whole tree, as does a `.ndignore`, which is
 * somebody having already said what they want that folder to be.
 */
export async function pruneOrphanFolders(config: Config, options: RepairOptions): Promise<OrphanReport> {
  const report: OrphanReport = { removed: 0, files: 0, examples: [] };
  const excluded = new Set([config.replacedDir].filter(Boolean).map((path) => resolve(path)));

  /** Files beneath a directory that is going, so the report can size what it took with it. */
  const countFiles = async (directory: string): Promise<number> => {
    let total = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) total += await countFiles(join(directory, entry.name));
      else total += 1;
    }
    return total;
  };

  const remove = async (directory: string): Promise<void> => {
    const files = await countFiles(directory).catch(() => 0);
    if (!options.dryRun) await rm(directory, { recursive: true, force: true });

    report.removed += 1;
    report.files += files;
    const path = relative(config.libraryDir, directory);
    if (report.examples.length < EXAMPLE_LIMIT) report.examples.push(path);
    log.info(options.dryRun ? "Would remove a folder with no audio in it" : "Removed a folder with no audio in it", {
      path,
      leftovers: files,
    });
  };

  /**
   * Returns true when this directory holds nothing worth keeping. It never removes itself —
   * the parent does, so a whole abandoned artist goes as one folder rather than as an empty
   * shell full of separately-reported album folders.
   *
   * The root has no parent to do that for it, and it is never removed itself: an empty library
   * is still the library, and the next download needs somewhere to put things. So it clears
   * its own removable children instead — without which a library where *everything* is an
   * orphan would report nothing at all, having quietly concluded the whole thing could go.
   */
  const consider = async (directory: string, isRoot = false): Promise<boolean> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      log.warn("Could not read a directory while looking for orphans", { directory, error: String(error) });
      return false;
    }

    let keep = false;
    const removable: string[] = [];

    for (const entry of entries) {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        // Never descended into by the index, so never tidied up by this either.
        if (isSkippedDirectory(entry.name) || excluded.has(resolve(path))) {
          keep = true;
          continue;
        }
        if (await consider(path)) removable.push(path);
        else keep = true;
        continue;
      }

      if (!entry.isFile()) {
        keep = true; // A symlink or a socket is not this tool's business.
        continue;
      }

      const extension = extname(entry.name).toLowerCase();
      if (AUDIO_EXTENSIONS.has(extension)) {
        keep = true;
      } else if (DELIBERATE.has(entry.name.toLowerCase())) {
        keep = true;
      } else if (!LEFTOVER_EXTENSIONS.has(extension) && !entry.name.startsWith(".")) {
        // Something this does not recognise. The directory stays, and so does whatever it is.
        keep = true;
      }
    }

    // This directory is staying, so anything beneath it that is not has to go now — the
    // parent will not be looking.
    if (keep || isRoot) {
      for (const path of removable) await remove(path);
      return false;
    }

    return true;
  };

  await consider(config.libraryDir, true);

  return report;
}

export function logRepairReport(report: RepairReport): void {
  const { tags, orphans } = report;

  if (tags.skipped) {
    log.info("Tag backfill did not run");
  } else {
    log.info(report.dryRun ? "Tag backfill (dry run)" : "Tag backfill complete", {
      files: tags.files,
      untagged: tags.untagged,
      tagged: tags.tagged,
      coverArtAdded: tags.artworkAdded,
      unmatched: tags.unmatched,
      artwork: tags.artwork,
      failed: tags.failed,
    });

    if (tags.unmatched > 0) {
      log.warn(
        "Some untagged files are not in the export snapshot, so there was nothing to write " +
          "into them — a rip from elsewhere, or a track that has left the collection since it " +
          "was downloaded. Run with LOG_LEVEL=debug to list them",
        { unmatched: tags.unmatched },
      );
    }
  }

  log.info(report.dryRun ? "Folders with no audio (dry run)" : "Folders with no audio removed", {
    folders: orphans.removed,
    leftoverFiles: orphans.files,
  });
  for (const path of orphans.examples) log.info(report.dryRun ? "  would remove" : "  removed", { path });
  if (orphans.removed > orphans.examples.length) {
    log.info(`  … and ${orphans.removed - orphans.examples.length} more`);
  }
}
