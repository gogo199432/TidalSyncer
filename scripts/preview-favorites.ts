#!/usr/bin/env bun
/**
 * Reports how much of your TIDAL collection can be placed on MusicBrainz, without writing
 * anything and without needing a ListenBrainz token.
 *
 * `DRY_RUN=true favorites` does the same and more, but it needs a token because the
 * name-based fallback tier is an authenticated endpoint. This covers the ISRC tier alone,
 * which is what almost every track resolves through, so it answers "is this worth turning
 * on" before you go and create a token.
 *
 *   docker compose run --rm --entrypoint bun listenbrainz-tidal-sync \
 *     run scripts/preview-favorites.ts
 */
import { loadConfig } from "../src/config.ts";
import { log, setLogLevel } from "../src/logger.ts";
import { MusicBrainzClient } from "../src/musicbrainz.ts";
import { SyncStore } from "../src/store.ts";
import { initAuth, requireUserCredentials } from "../src/tidal/auth.ts";
import { createClient, fetchCollectionTracks } from "../src/tidal/client.ts";

const config = loadConfig();
setLogLevel(config.logLevel);

await initAuth(config);
await requireUserCredentials();

const store = await SyncStore.open(config.dataDir);
const tracks = await fetchCollectionTracks(createClient());
const withIsrc = tracks.filter((track) => track.isrc);

log.info("Read TIDAL collection", { tracks: tracks.length, withIsrc: withIsrc.length });

const musicBrainz = new MusicBrainzClient(
  config.musicBrainzApiUrl,
  `listenbrainz-tidal-sync/1.0.0 ( ${config.contactEmail} )`,
);

// Reuse and extend the same cache the real run uses, so this is not wasted work.
const pending = [
  ...new Set(
    withIsrc.flatMap((track) =>
      store.getCachedRecordingByIsrc(track.isrc!) === undefined ? [track.isrc!] : [],
    ),
  ),
];

if (pending.length > 0) {
  log.info("Looking up ISRCs on MusicBrainz", { isrcs: pending.length });
  const found = await musicBrainz.recordingMbidsByIsrc(pending);
  for (const isrc of pending) store.setCachedRecordingByIsrc(isrc, found.get(isrc) ?? null);
  await store.flushCache();
}

const recordings = new Set<string>();
const missed: string[] = [];

for (const track of tracks) {
  const mbid = track.isrc ? store.getCachedRecordingByIsrc(track.isrc) : null;
  if (mbid) recordings.add(mbid);
  else missed.push(`${track.title ?? track.trackId} (${track.isrc ?? "no isrc"})`);
}

console.log("");
console.log(`collection tracks       ${tracks.length}`);
console.log(`carrying an ISRC        ${withIsrc.length}`);
console.log(`placed on MusicBrainz   ${tracks.length - missed.length}`);
console.log(`distinct recordings     ${recordings.size}`);
console.log(`left for the name tier  ${missed.length}`);

if (missed.length > 0) {
  console.log("\nnot placed by ISRC:");
  for (const description of missed.slice(0, 25)) console.log(`  ${description}`);
  if (missed.length > 25) console.log(`  ... and ${missed.length - 25} more`);
}
