# listenbrainz-tidal-sync

Mirrors your ListenBrainz recommendation playlists — **Weekly Jams**, **Weekly
Exploration** and **Daily Jams** — into TIDAL playlists, and keeps them up to date
automatically. Optionally mirrors the other way too, turning your **TIDAL collection into
ListenBrainz loved recordings**.

ListenBrainz publishes each refresh as a *brand-new playlist* with a new MBID rather than
editing the previous one. This tool tracks each playlist *family* (`weekly-jams`,
`weekly-exploration`, `daily-jams`, …) and maintains **one rolling TIDAL playlist per
family**, replacing its contents whenever a new edition appears.

Built with Bun + TypeScript on the official [TIDAL SDK](https://github.com/tidal-music/tidal-sdk-web)
(`@tidal-music/auth`, `@tidal-music/api`) and the public ListenBrainz REST API.

## How tracks are matched

Two tiers, precision first:

1. **ISRC.** ListenBrainz gives a MusicBrainz recording MBID per track. The ListenBrainz
   metadata endpoint resolves those to ISRCs in batches of 50, and TIDAL's
   `GET /tracks?filter[isrc]=` resolves up to 20 ISRCs per request. In practice this
   places ~85% of a playlist exactly.
2. **Text search** for the remainder, accepting a hit only when the titles agree once
   bracketed suffixes like `(Remastered 2011)` are ignored. A missing track is better
   than a wrong one.

Both tiers — including confirmed misses — are cached in `data/cache.json`, so repeat syncs
are nearly free and overlapping playlists cost nothing extra.

If **zero** tracks resolve, the sync aborts for that playlist rather than emptying it.

## Setup

```bash
cp .env.example .env
```

Then fill in `.env` — it holds only the values that are secret or specific to you:

- `LISTENBRAINZ_USER` — your ListenBrainz username
- `TIDAL_CLIENT_ID` / `TIDAL_CLIENT_SECRET` — from [developer.tidal.com](https://developer.tidal.com),
  with the `playlists.read` and `playlists.write` scopes. If you want to sync your favorites back to ListenBrainz or filter by them, also add `collection.read`
- `TIDAL_COUNTRY_CODE` — your TIDAL account's country

Everything else is configured inline in [`docker-compose.yml`](docker-compose.yml), which
contains no credentials and is safe to commit. One value there needs checking:

- `TIDAL_REDIRECT_URI` — must be registered **verbatim** as a redirect URI on your TIDAL
  app. The default `http://localhost:8080/callback` matches the `ports:` mapping.

`.env` is gitignored. The required variables use `${VAR:?}`, so a missing one stops
Compose with a message naming it rather than starting a half-configured container.

### Authorise once

```bash
docker compose run --rm --service-ports listenbrainz-tidal-sync login
```

This prints a `login.tidal.com` URL. Open it in a browser, log in, and TIDAL redirects back
to the throwaway local server the command is running, which captures the authorization
code and writes the refresh token to the `sync-data` volume. Nothing interactive is needed
again — the SDK refreshes the token on its own.

If the browser cannot reach the callback port (a headless NAS, say), use `--manual` and
paste the redirected URL back into the terminal instead:

```bash
docker compose run --rm listenbrainz-tidal-sync login --manual
```

> **Why not the device flow?** TIDAL has one, and it would suit a headless service better,
> but it is restricted to TIDAL's own internal apps — a developer-portal client is rejected
> with `Client is not a Limited Input Device client`. Authorization Code + PKCE is the only
> flow available to third-party apps, and its login page is bot-protected, so it genuinely
> needs a real browser once.

> The TIDAL SDK is browser-oriented and defaults to `localStorage`. This project supplies a
> file-backed `StorageAdapter` (`src/tidal/storage.ts`, mode `0600`) so it works headlessly.

### First run

Dry-run first — it resolves and reports everything without writing to TIDAL:

```bash
docker compose run --rm -e DRY_RUN=true listenbrainz-tidal-sync sync
```

Then start it for real:

```bash
docker compose up -d --build
docker compose logs -f
```

`daemon` syncs once on startup, then on `SYNC_SCHEDULE` (default every 6 hours). State and
credentials live in the `sync-data` volume at `/data`.

```bash
docker compose run --rm listenbrainz-tidal-sync status   # what is currently mirrored
```

## The dashboard

The daemon also serves a status page on **http://localhost:8081** — what is mirrored, how
each family last came out, a countdown to the next scheduled run, and a **Sync now** button
for when you do not want to wait for it.

It reads the same `state.json` the `status` command does, plus a rolling history of the
last 30 runs and the favourites MusicBrainz could not place, so it is accurate immediately
after a restart — only the per-playlist detail (which tracks went unmatched on the
ListenBrainz → TIDAL side, which families were skipped) starts empty until this process has
run a sync of its own.

Two things worth knowing:

- **There is no login.** Anyone who can reach the port can start a sync — not destructive,
  but not something to expose to the internet. The compose file publishes `8081:8081`;
  change it to `127.0.0.1:8081:8081` to keep it on the host, or set `DASHBOARD_ENABLED` to
  `false` to serve nothing at all.
- **A manual run cannot overlap a scheduled one.** Both go through the same runner, and a
  trigger that arrives mid-run is logged and ignored rather than queued — two concurrent
  runs would write the same TIDAL playlists.

The page it renders is also the whole API, if you would rather script it:

```bash
curl localhost:8081/api/status | jq        # everything the page shows
curl -X POST localhost:8081/api/run        # 202 accepted, or 409 if one is running
curl -X POST 'localhost:8081/api/run?force=true'   # re-mirror even with no new edition
```

## Which playlists get synced

By default, only the three playlists ListenBrainz actually keeps regenerating:

```
weekly-jams  weekly-exploration  daily-jams
```

`createdfor` also serves one-off year-in-review lists that never change again —
`top-discoveries-of-2019`, `top-missed-recordings-of-2014`, `lb-radio`, and so on. A
long-standing account has 40+ of these, so they are excluded. To change the selection:

```yaml
LISTENBRAINZ_SOURCE_PATCHES: weekly-jams,daily-jams   # a narrower set
LISTENBRAINZ_SOURCE_PATCHES: "*"                      # everything, historical lists included
```

A configured playlist that ListenBrainz has not published is logged as a warning rather
than failing the run.

### Skipping music you already own

`TIDAL_SKIP_COLLECTION_FOR` drops tracks that are already in your TIDAL collection:

```yaml
TIDAL_SKIP_COLLECTION_FOR: weekly-exploration    # or "*" for every family
```

Enabling it adds the `collection.read` scope, so **run `login` once more afterwards** —
the SDK invalidates the stored token when the scope set grows. Leaving it empty keeps the
scope off entirely, so nobody who ignores this feature ever has to re-authorise.

Two caveats worth knowing before switching it on:

- **Weekly Jams is meant to be familiar.** ListenBrainz describes it as "songs that you
  have listened to before, arranged into a comfortable playlist" — filtering it against
  your collection can legitimately empty it. Weekly Exploration is the discovery playlist
  and the more useful target.
- **Listening is not collecting.** Streaming a track through TIDAL does not put it in your
  collection; only saving/favouriting it does. If you never favourite anything the filter
  has nothing to match, which the logs call out explicitly rather than silently doing
  nothing.

If every track ends up filtered, the playlist is left untouched rather than emptied, and
the run reports it as `skipped`.

## Syncing favourites back

`SYNC_FAVORITES` turns the tracks in your TIDAL collection into **loved recordings** on
ListenBrainz — the same thing the heart button on the ListenBrainz site does.

```yaml
SYNC_FAVORITES: "true"
```

```bash
LISTENBRAINZ_TOKEN=...   # in .env, from https://listenbrainz.org/settings/
```

The token must belong to `LISTENBRAINZ_USER`. Feedback is always written to the *token's*
account, so a token pasted from another profile would quietly favourite tracks on the wrong
one; the run checks this before writing anything and stops if they disagree.

`SYNC_FAVORITES` also needs the `collection.read` scope, so **run `login` once more** after
enabling it, exactly as for `TIDAL_SKIP_COLLECTION_FOR`.

Once on, `sync` and the daemon do the playlists first and then favourites, on the same
schedule. To run just this half:

```bash
docker compose run --rm listenbrainz-tidal-sync favorites
```

### How TIDAL tracks become MusicBrainz recordings

The opposite problem to the playlist direction: ListenBrainz identifies music by
MusicBrainz recording MBID, and TIDAL by its own track ids.

1. **ISRC.** TIDAL supplies an ISRC for essentially every catalogue track. A MusicBrainz
   search for `isrc:A OR isrc:B …` resolves 20 at a time — one request per 20 tracks,
   spaced to MusicBrainz's one-request-per-second limit, instead of one request per track.
2. **Artist + title** through ListenBrainz's own mapper (`/1/metadata/lookup`) for the
   remainder — the same mapper it uses to attach your listens to MusicBrainz.

Expect the second tier to do real work. TIDAL's ISRC coverage is close to total, but
*MusicBrainz's* is not: on a 766-track collection, 547 resolved by ISRC and 219 fell
through, mostly very recent releases whose ISRCs nobody has added to MusicBrainz yet.

Both tiers cache into `data/cache.json`, misses included, so the slow first pass over a
large collection happens once and later runs only look up newly favourited music.

That cached-miss behaviour has one consequence worth knowing: a track neither tier can
place is never retried, even after MusicBrainz later learns about it. Deleting the
`isrcToRecording` and `searchToRecording` objects from `data/cache.json` makes the next run
try them again — worth doing once a year, not once a week.

### Which tracks fell through

Each run records the ones it could not place, by name, so you can see *what* is missing
rather than only how many:

```bash
docker compose run --rm listenbrainz-tidal-sync status --unresolved
```

The dashboard shows the same list under **Favourites**, behind the count. Both come from
the last run and are capped at 250 names (the count is exact either way) — a 766-track
collection with 219 unplaceable tracks is normal, and the list is there to be read, not to
be exhaustive. Most entries are recent releases nobody has added to MusicBrainz yet, so
adding one there is what makes it resolve next time.

### What it will and will not do

- **Additive only.** Removing a track from your TIDAL collection does **not** remove the
  ListenBrainz love. Loves also come from the ListenBrainz site and other clients, and
  nothing in the data distinguishes those from ones written here, so retracting them would
  risk destroying feedback this tool never created.
- **Already-loved recordings are skipped.** Existing loves are read first and only the
  difference is submitted, so a steady state costs a handful of requests.
- **Tracks only.** ListenBrainz feedback exists per recording, so saved albums and followed
  artists in your TIDAL collection are ignored.
- **Several TIDAL tracks can collapse into one love.** The single, the album cut and the
  remaster are frequently one MusicBrainz recording, which is the unit ListenBrainz stores,
  so the number of loves is a little lower than the number of favourites.
- **The name tier is fuzzier than the ISRC tier.** It is the same matcher ListenBrainz
  applies to your listens, so a mistake here is the mistake your listen history would
  already have made — but it is a guess, where an ISRC is an identity.
- Submissions are paced by ListenBrainz's own rate-limit headers, and a run that fails
  partway is safe to repeat: the next one resumes from what is still missing.

Dry-run it first — it resolves everything and reports what it would love, without writing:

```bash
docker compose run --rm -e DRY_RUN=true listenbrainz-tidal-sync favorites
```

To see how much of your collection is reachable *before* creating a token at all, there is
a read-only preview covering the ISRC tier:

```bash
docker compose run --rm --entrypoint bun listenbrainz-tidal-sync \
  run scripts/preview-favorites.ts
```

## Configuration

Secrets and personal values live in `.env` (see [`.env.example`](.env.example)); every
other setting is documented inline in [`docker-compose.yml`](docker-compose.yml).

| Variable | Default | Purpose |
| --- | --- | --- |
| `LISTENBRAINZ_USER` | *required* | Your ListenBrainz username |
| `LISTENBRAINZ_TOKEN` | *(off)* | User token; required only by `SYNC_FAVORITES` |
| `LISTENBRAINZ_SOURCE_PATCHES` | `weekly-jams,weekly-exploration,daily-jams` | Playlist families to mirror; `*` for all |
| `SYNC_FAVORITES` | `false` | Mirror the TIDAL collection back as ListenBrainz loves |
| `TIDAL_CLIENT_ID` / `TIDAL_CLIENT_SECRET` | *required* | From developer.tidal.com |
| `TIDAL_COUNTRY_CODE` | `US` | Affects catalogue availability; set to your account's country |
| `TIDAL_SKIP_COLLECTION_FOR` | *(off)* | Families to filter against your TIDAL collection; `*` for all |
| `TIDAL_PLAYLIST_ACCESS` | `PRIVATE` | `PRIVATE` (unlisted) or `PUBLIC` |
| `TIDAL_PLAYLIST_NAME_TEMPLATE` | `{title} (ListenBrainz)` | `{title}` = e.g. `Weekly Jams` |
| `DATA_DIR` | `./data` | Credentials, sync state, lookup cache |
| `SYNC_SCHEDULE` | `0 */6 * * *` | Cron expression for `daemon` |
| `DASHBOARD_ENABLED` | `true` | Serve the status page from `daemon` |
| `DASHBOARD_PORT` | `8081` | Port for the status page |
| `DASHBOARD_HOST` | `0.0.0.0` | Interface it binds to |
| `CONTACT_EMAIL` | — | Sent in the ListenBrainz `User-Agent`, as their guidelines ask |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `DRY_RUN` | `false` | Resolve and report, never write to TIDAL |

### Running outside Docker

Bun auto-loads a `.env` file if you create one, or export the variables by hand:

```bash
bun install
LISTENBRAINZ_USER=... TIDAL_CLIENT_ID=... TIDAL_CLIENT_SECRET=... bun run sync
```

## Commands

| Command | Does |
| --- | --- |
| `bun run login` | One-time TIDAL browser authorisation (`--manual` to paste the URL back) |
| `bun run sync` | Mirror once (`--force` re-mirrors even with no new edition), then favourites if enabled |
| `bun run favorites` | Only mirror the TIDAL collection back to ListenBrainz |
| `bun run status` | Show what is mirrored, without contacting TIDAL (`--unresolved` names the favourites MusicBrainz could not place) |
| `bun run daemon` | Sync on startup, then on `SYNC_SCHEDULE`; serves the dashboard too |
| `bun test` | Run tests |
| `bun run typecheck` | `tsc --noEmit` |

## Behaviour notes

- **Playlist discovery** — the playlist recorded in `data/state.json` is reused; if it was
  deleted in the TIDAL app, an existing playlist with the same name is adopted rather than
  duplicated, and only otherwise is a new one created.
- **Idempotent** — if TIDAL already matches ListenBrainz exactly, no write happens.
- **Order preserved** — contents are cleared and re-appended so TIDAL order mirrors
  ListenBrainz.
- **Unchanged editions are skipped** by comparing the edition MBID and `last_modified_at`,
  so a 6-hourly schedule costs one cheap request per family most of the time.
- **The daemon survives failures** — a failing run is logged and retried on the next tick.
- Unmatched tracks are logged individually at `warn`.

## Layout

```
src/
  index.ts          CLI: login / sync / favorites / status / daemon
  config.ts         env parsing and validation
  listenbrainz.ts   createdfor listing, JSPF parsing, ISRC resolution, feedback writes
  musicbrainz.ts    batched ISRC -> recording MBID lookup, rate limited
  sync.ts           ListenBrainz -> TIDAL: edition selection, mirroring, state
  favorites.ts      TIDAL -> ListenBrainz: collection to loved recordings
  runner.ts         one run at a time, shared by the CLI, the cron tick and the dashboard
  store.ts          atomic JSON state + run history + lookup cache
  logger.ts
  dashboard/
    server.ts       status JSON, manual trigger, static assets
    public/         the page itself (no build step, no external requests)
  tidal/
    auth.ts         browser login, scope selection, credential guard
    storage.ts      file-backed StorageAdapter for headless use
    client.ts       playlist find / create / read / replace, collection reads
    match.ts        ISRC-first track matching with search fallback
scripts/
  preview-favorites.ts   read-only resolution check, needs no ListenBrainz token
```
