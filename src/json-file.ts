import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { log } from "./logger.ts";

/** Writes via a temp file + rename so a crash mid-write cannot truncate the file. */
export async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, path);
}

/** Absent is the normal first-run case; unreadable is worth a line but never fatal. */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    log.warn("Could not read store, starting fresh", { path, error: String(error) });
    return fallback;
  }
}
