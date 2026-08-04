import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StorageAdapter } from "@tidal-music/auth";

/**
 * The TIDAL auth SDK targets browsers and defaults to `localStorage`, which does not
 * exist under Bun/Node. It accepts a custom adapter instead, so we persist the
 * (already encrypted by the SDK) credential blob to a file in the data directory.
 * This is what lets the container authorise once and keep refreshing forever after.
 */
export function createFileStorage(dataDir: string): StorageAdapter {
  const pathFor = (key: string) => join(dataDir, `${encodeURIComponent(key)}.credentials`);

  return {
    async load(key) {
      try {
        return await readFile(pathFor(key), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },

    async save(key, value) {
      await mkdir(dataDir, { recursive: true });
      const path = pathFor(key);
      const temporary = `${path}.${process.pid}.tmp`;
      // 0600: the blob is refresh-token equivalent, keep it owner-only.
      await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    },

    async remove(key) {
      try {
        await unlink(pathFor(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}
