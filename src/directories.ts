import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { normalize } from "./tidal/match.ts";

/**
 * Reconciles a path this tool wants to write against the directories already on disk.
 *
 * `libraryPathFor` builds `Artist/Album/Title.flac` out of the names TIDAL reports, and TIDAL
 * is not the authority on how a library spells things. It says `NERO` where the library has
 * `Nero`, `GRiZ` where it has `Griz`, and `AC/DC` — which sanitises to `ACDC` — where it has
 * `AC_DC`. On a case-sensitive filesystem each of those becomes a second artist folder, and
 * whatever serves the library shows the artist twice.
 *
 * That was a self-inconsistency rather than bad luck: `LibraryIndex` already normalises names
 * to decide whether a track is *present*, so the tool knew `NERO` and `Nero` were the same
 * artist when deciding what to download and forgot it when deciding where to put the file.
 * This closes that gap by preferring the spelling already on disk.
 *
 * The same normalisation as the track matcher, deliberately — it is one idea, and having two
 * notions of "the same name" is how this happened. It can in principle merge two artists who
 * differ only in punctuation, which is the same risk the matcher already takes; nothing is
 * ever deleted or renamed, so the worst case is a file in a neighbouring folder.
 */
export class DirectoryNames {
  /** Directory -> (normalised child name -> the spelling actually on disk). */
  private readonly listings = new Map<string, Map<string, string>>();

  constructor(private readonly root: string) {}

  /**
   * Returns `relativePath` with each of its directory segments replaced by the equivalent
   * one already on disk, where there is one. The filename is left alone.
   */
  async resolve(relativePath: string): Promise<string> {
    const segments = relativePath.split("/");
    const filename = segments.pop();
    if (!filename) return relativePath;

    const resolved: string[] = [];
    for (const segment of segments) {
      const parent = join(this.root, ...resolved);
      const listing = await this.listing(parent);
      const key = normalize(segment);
      const existing = key ? listing.get(key) : undefined;

      resolved.push(existing ?? segment);

      // A directory this run is about to create counts as existing for the tracks after it,
      // so a hundred tracks by one artist cannot disagree with each other about the spelling.
      if (!existing && key) listing.set(key, segment);
    }

    return [...resolved, filename].join("/");
  }

  private async listing(directory: string): Promise<Map<string, string>> {
    const cached = this.listings.get(directory);
    if (cached) return cached;

    const names = new Map<string, string>();
    let entries: Dirent[] = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // Absent is the ordinary case for a new artist; an unreadable one is not worth failing
      // a download over when the fallback is simply to use TIDAL's spelling.
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const key = normalize(entry.name);
      // First one wins, so a library that already contains both spellings stays on whichever
      // the filesystem lists first rather than flip-flopping between runs.
      if (key && !names.has(key)) names.set(key, entry.name);
    }

    this.listings.set(directory, names);
    return names;
  }
}
