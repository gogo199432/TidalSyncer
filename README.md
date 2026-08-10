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
docker compose up -d
docker compose logs -f
```

Compose pulls a prebuilt image from this repo's container registry
(`ghcr.io/gogo199432/tidalsyncer:latest`), so there is nothing to compile locally.
`docker compose pull && docker compose up -d` picks up a newer build. To run your own
changes instead, uncomment `build: .` in [`docker-compose.yml`](docker-compose.yml) and use
`docker compose up -d --build`.

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

It also carries the whole [backup path](#backing-up) — see **Doing it from the browser**
below — so `export` and `download` never need a terminal, a
[settings page](#changing-settings-from-the-browser) where every one of the variables in
[Configuration](#configuration) can be changed without editing the compose file, and a
[log page](#the-log-page).

Two things worth knowing:

- **There is no login.** Anyone who can reach the port can start a sync, run a download,
  change any setting, or read the device code while one is pending — and approve that code
  with *their* TIDAL account, leaving the daemon holding a session you did not intend. Not
  something to expose to the internet. The compose file publishes `8081:8081`; change it to
  `127.0.0.1:8081:8081` to keep it on the host, or set `DASHBOARD_ENABLED` to `false` to
  serve nothing at all. Secrets are write-only over this API: they can be set from the page,
  never read back from it.
- **A manual run cannot overlap a scheduled one.** Both go through the same runner, and a
  trigger that arrives mid-run is logged and ignored rather than queued — two concurrent
  runs would write the same TIDAL playlists. The backup half has a second runner with the
  same rule, and since a download can run for hours, a tick that lands on top of one is
  simply skipped and picked up by the following tick.

The page it renders is also the whole API, if you would rather script it:

```bash
curl localhost:8081/api/status | jq        # everything the page shows
curl -X POST localhost:8081/api/run        # 202 accepted, or 409 if one is running
curl -X POST 'localhost:8081/api/run?force=true'   # re-mirror even with no new edition

curl -X POST localhost:8081/api/backup/login    # returns the device code to display
# Snapshots the catalogue, then downloads from it. There is no separate export endpoint.
curl -X POST localhost:8081/api/backup/download \
  -H 'content-type: application/json' \
  -d '{"dryRun":true,"quality":"lossless","skipTier":"album-agnostic","limit":5}'
curl -X POST localhost:8081/api/backup/stop     # finishes the current track, then stops

curl localhost:8081/api/settings | jq       # every setting, and where its value comes from
curl -X POST localhost:8081/api/settings \
  -H 'content-type: application/json' \
  -d '{"values":{"SYNC_SCHEDULE":"30 4 * * *","TIDAL_UPGRADE":"true"}}'
curl -X POST localhost:8081/api/settings \
  -H 'content-type: application/json' \
  -d '{"values":{"SYNC_SCHEDULE":null}}'    # null hands one back to the environment

curl localhost:8081/api/logs | jq          # the daemon's log, as it went to stdout
curl 'localhost:8081/api/logs?since=1240'  # only what came after that line
```

### The log page

**http://localhost:8081/logs** is the daemon's own log, live — the same lines it writes to
stdout, wrapped, coloured by level, filterable by level and by substring, and following the
tail until you scroll up. It is the answer to "the download stopped, what happened" without
shelling into the container.

The last 2000 lines are kept in memory; `docker logs` still has the whole history. It holds
only what `LOG_LEVEL` let through — which the settings page can change while the daemon is
running, so turning `debug` on for a few minutes needs no restart. Nothing is written to
disk: the log already goes to stdout, and a second copy would be one more file to rotate.

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
other setting is documented inline in [`docker-compose.yml`](docker-compose.yml). All of
them can also be changed from the [settings page](#changing-settings-from-the-browser),
which saves to `DATA_DIR/settings.json` and takes precedence over both.

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

The download, upgrade and Soulseek variables are covered where they matter, under
[Backing up](#backing-up), and inline in the compose file. All of them — these and those —
are on the settings page below.

### Changing settings from the browser

**http://localhost:8081/settings** lists every variable above — plus the download, upgrade
and Soulseek ones — with what it currently is, where that value came from, and what it
means. Saving writes `DATA_DIR/settings.json`, and **that file wins over the environment**.

Two layers rather than one because they answer different questions. The environment is how
the container is *installed*: it belongs in the compose file, in version control, and it is
what a fresh volume comes up with. The saved file is how the daemon is *tuned* — the cron
expression you moved an hour later, the quality you dropped to lossless — and those should
not need an edit-and-restart cycle. Each setting says which layer it is currently coming
from, and **reset** on an overridden one deletes the entry, handing it back.

Some things worth knowing:

- **The schedule really is live.** Saving `SYNC_SCHEDULE` or `TZ` re-arms the running cron
  job; the countdown on the status page moves to the new next run. Most other settings are
  read when they are used, so the next run picks them up.
- **A few need a restart**, and say so on the page: the OAuth scopes (`SYNC_FAVORITES`,
  `TIDAL_SKIP_COLLECTION_FOR` — those need `login` run again too), the TIDAL client
  credentials, and the dashboard's own host and port. They are saved either way and take
  effect when the daemon next starts.
- **Nothing is saved unless all of it holds up.** The whole overlay is parsed and validated
  as one — a Soulseek URL with no API key, a cron expression croner will not take — and a
  refused save changes nothing, on disk or in the running daemon.
- **`DATA_DIR` is not on the page**, deliberately: it is where `settings.json` lives, so an
  override that moved it would leave itself behind. It stays an environment variable.
- **The CLI reads the same file.** A one-off `bun run download` at a terminal uses the
  quality you set in the browser, not the one in the compose file.

### The container image

`ghcr.io/gogo199432/tidalsyncer` is built for `linux/amd64` and `linux/arm64` by
[`.github/workflows/publish-image.yml`](.github/workflows/publish-image.yml) on every push
to `main`. Pull requests build the image but do not publish it.

| Tag | Points at |
| --- | --- |
| `latest` | The newest `main` build (also moved by a release tag) |
| `edge`, `main` | The newest `main` build |
| `1.2.3`, `1.2`, `1` | The `v1.2.3` release tag |
| `sha-<commit>` | One exact commit — useful for pinning or rolling back |

The package is private until you make it public: on the repository's **Packages** page,
open the package → **Package settings** → **Change visibility**. Otherwise pulling needs
`docker login ghcr.io` with a PAT that has `read:packages`.

### Running outside Docker

Bun auto-loads a `.env` file if you create one, or export the variables by hand:

```bash
bun install
LISTENBRAINZ_USER=... TIDAL_CLIENT_ID=... TIDAL_CLIENT_SECRET=... bun run sync
```

## Backing up

Two things — a snapshot of your curation, and the audio itself — but only one of them is
something you have to remember to do. `download` always takes a fresh snapshot first, and the
daemon runs the pair on `SYNC_SCHEDULE` right after each playlist sync. `export` is still its
own command for when the snapshot is all you want.

### `export` — your curation

```bash
bun run export
```

Writes `DATA_DIR/export`: `export.json` with every owned playlist, your collection, and full
metadata for every track either references, plus a `.m3u8` per playlist and one for
favourites. Uses the same developer-portal credentials as `sync` and needs nothing extra.

This is the part worth doing unconditionally. TIDAL playlists stop existing when a
subscription lapses, and individual tracks get delisted or silently swapped for a
`replacement` version while it is still live. An ISRC plus artist/title recorded here stays
resolvable against MusicBrainz, a local library, or a shop, indefinitely.

The `.m3u8` URI lines point at `Artist/Album/Title.flac` under `LIBRARY_DIR` — files that may
not exist yet. Players resolve relative paths against the playlist's own location, so
dropping these next to a filled-in library makes them work with no rewriting. Tracks TIDAL
would not resolve become `# unresolved TIDAL track <id>` comments rather than silent gaps.

### `download` — the audio

```bash
bun run download-login          # once
bun run download --dry-run      # see what it would fetch
bun run download --limit=5      # start small
```

Takes a fresh snapshot — the same one `export` writes — and then works from it. That ordering
is not optional, because a download reads nothing else: skipping it would fetch your
collection as it stood the last time somebody ran `export` by hand. `--dry-run` is the
exception, since it promises to contact nothing; it plans against the snapshot already on
disk, which also keeps it usable before `download-login` has ever been run.

Then fetches `GET /v2/trackManifests/{id}` with `manifestType=HLS`,
`uriScheme=HTTPS`, `usage=DOWNLOAD`, pulls the plain HLS segments, and demuxes the FLAC out
of its MP4 container with `ffmpeg -c copy` (so it stays lossless — the bytes are moved, not
re-encoded).

### Skipping what you already have

`LIBRARY_DIR` is walked and indexed once at the start of every run, and a track whose file is
already there is never fetched. This is built for a library some *other* tool wrote, so the
comparison is deliberately not a path check:

- **Extension is ignored.** An existing `.mp3`, `.m4a`, `.opus` — anything in the audio
  extension list — counts as present.
- **Case, accents and punctuation are folded**, so `Bjork/Homogenic/Joga.flac` matches
  Björk's *Jóga*, and a straight apostrophe matches a curly one.
- **Every credited artist is tried**, not just the first, since TIDAL's credit order and your
  library's filing may disagree on a collaboration.
- **Leading track numbers are looked past**, so `02 - Slam.flac` answers to *Slam*. Measured
  against a real library, 47% of files carried one — keying on the literal filename alone
  would have re-downloaded every one of them. The stripped form is registered *alongside*
  the literal name rather than replacing it, so `99 Problems.flac` is still found under its
  own name.
- **Disc folders are seen through**: `Artist/Album/Disc 2/06 - Track.flac` files under
  *Album*, not *Disc 2*.
- **A flat release folder** whose files are named `Artist - Title.ext` is matched on the
  artist in the filename, since there is no artist directory to read.

`TIDAL_SKIP_TIER` (or `--skip-tier=`) sets how close a match has to be:

| Tier | Skips when | Use when |
| --- | --- | --- |
| `exact` | artist, album and title all agree | you want every album's own copy |
| `album-agnostic` *(default)* | artist and title agree, album may differ | you already have most of it |
| `loose` | also ignores `(Remastered 2011)`-style suffixes | you don't care which master |

`album-agnostic` is the default because the usual mismatch is filing: a track you own from a
single, a compilation, or a deluxe edition is still a track you own. `loose` is the one that
can be wrong — it will treat a studio recording as covering `(Live)` — so the run reports
`Skips by how they were matched` and warns whenever a `loose` match was used.

Start with `--dry-run`, which reads the export and the library, contacts nothing, and works
before `download-login` has ever been run:

```bash
bun run download --dry-run | grep 'Would download'
```

Three things to understand before switching it on.

**It needs a client id that is not yours.** TIDAL grants playback to its own players. Your
developer-portal token gets `trackPresentation: PREVIEW` with
`previewReason: FULL_REQUIRES_SUBSCRIPTION` regardless of whose subscription is behind it,
and the device endpoint rejects it outright with *"Client is not a Limited Input Device
client"*. So `TIDAL_DEVICE_CLIENT_ID` is a separate setting, it is empty by default, and
`download` stays off until you fill it in. Doing so is a terms-of-service matter and puts
the account you authorise at some risk.

**No DRM is being circumvented.** The HLS branch of `trackManifests` returns unencrypted
segments; it is the MPEG-DASH branch that carries `drmData` with a Widevine/FairPlay
`licenseUrl`. If TIDAL ever starts serving `#EXT-X-KEY` on this path, the download aborts
with `EncryptedStreamError` rather than quietly writing files full of silence — decrypting
streams is deliberately out of scope.

**TIDAL pushes back.** The manifest endpoint rate-limits hard and answers a sustained burst
with a captcha that deauthenticates the session. Hence `TIDAL_DOWNLOAD_DELAY_MS` (3s
default), exponential backoff on 429/5xx, and `--limit`. Don't discover that boundary with
an account you care about.

Entitlement is per track, so `--quality=hires` walks down through `lossless` → `high` → `low`
rather than failing: a Hi-Res request on a lossless-only track returns a preview, not an
error, and writing a 30-second file would be worse than taking the tier actually on offer.

### When a track in your collection cannot be fetched

Two kinds, and they mean different things:

- **`unavailable`** — TIDAL served a preview at *every* tier. The catalogue has the track and
  the snapshot describes it, but this account is not entitled to the full stream: licensing
  lapsed for your market, or the player client is not granted playback for it.
- **`missing`** — the snapshot carries no metadata for it at all, because TIDAL would not
  return any when the export ran. Delisted since you favourited it, or region-locked out of
  `TIDAL_COUNTRY_CODE`. There is no artist, album or title, so there is no path to write a
  file to and nothing to ask for; these are never attempted.

The second used to be invisible. Those tracks were dropped before the run started — not
counted, not reported, just absent from the total, so a 123-track collection would quietly
report "120 considered" and never say why. They are now counted in the total and listed
individually with their TIDAL id, ahead of everything else, since they are known as soon as
the snapshot is read. `export` records the same tracks as `# unresolved TIDAL track <id>` in
the `.m3u8` files and in its **Unresolved / tombstoned** figure.

A whole batch of metadata can also fail transiently — ids are looked up twenty at a time —
which reads as twenty `missing` tracks for that run. The next snapshot picks them up.

### Soulseek, for what TIDAL will not serve

Optional, off by default, and it reaches a public peer-to-peer network on your behalf — so it
stays off until you set `SLSKD_URL`. It needs a [slskd](https://github.com/slskd/slskd) you
host yourself.

```yaml
SLSKD_URL: http://slskd:5030
SLSKD_API_KEY: <a key with the readwrite role>
```

Both kinds of track that TIDAL cannot give you are tried:

- **`unavailable`** — full metadata, so the search terms are exact.
- **`missing`** — delisted, and all that survives is a TIDAL id plus whatever the *collection*
  listing carried. If that included an ISRC, MusicBrainz turns it back into an artist, title
  and album — the only thing Soulseek understands is a name, and the album is what stops these
  piling up under `Unknown Album`. A recording is usually on a dozen releases, so the most
  frequently named title wins: four pressings of an album outvote one compilation appearance.
  Tombstones with no ISRC are reported as `unsearchable` rather than guessed at.

A track already in the library is **not fetched again**. That check can only happen after the
name is recovered, because a delisted track stays a bare id in the snapshot for ever and the
TIDAL pass has nothing to look it up with — without it, every run re-downloaded the same
tracks from the same strangers.

It runs as a second pass after the TIDAL loop, never inside it, and never on a dry run.

**Choosing a file is written to refuse rather than to rank.** A search result is a filename a
stranger chose next to numbers that stranger reported, and neither has to be true. So the
title must appear in the filename and the artist somewhere in its path; non-audio extensions
and implausible sizes are dropped; and a reported duration that disagrees by more than 12
seconds rejects the file outright, which is what keeps live takes and extended mixes out.
Files a peer has locked are rejected too: those are shared only with users it has privileged,
so queueing one earns an immediate refusal however well it matches.

Bitrate, sample rate, queue length and upload speed only *rank* what has already survived,
and that is not fastidiousness. Measured against one real search — 243 peers, 687 files —
**only 66% of files carried a duration and 40% a bitrate**, and `extension` is frequently the
empty string even where the filename plainly ends in `.flac`. A matcher that required any of
them would throw away most of the network.

**Lossless always beats lossy**, however long the queue. Waiting is recoverable: the track is
absent and the next run tries again. An mp3 is not — nothing will ever upgrade a track TIDAL
does not have, so the library keeps it for good. `SLSKD_LOSSLESS_ONLY=true` refuses lossy
outright if you would rather have the gap.

**Nothing waits on one peer.** Every track is searched for and queued first, then the whole
batch is watched together — because whether a transfer *starts* is a stranger's decision, and
one track sitting in `Queued, Remotely` behind forty other people must not hold up the rest of
the list. `SLSKD_TRANSFER_TIMEOUT_MS` (10 minutes by default) is therefore a budget for the
batch, not for each track.

**Slow transfers are left running, not cancelled.** Anything still going when that budget
expires is recorded in `DATA_DIR/slskd-pending.json` and filed into the library by whichever
later run finds it finished — the ledger is written the moment a transfer is queued, so a run
killed mid-wait leaves it collectable rather than orphaned. Cancelling would mean never
getting the slow ones, which for these tracks usually means never getting them.

**Where the file lands.** slskd is told to download into the track's own `Artist/Album`
directory, and the finished file is then renamed to the name the library expects — keeping the
extension that actually arrived, not the `.flac` the export optimistically assumed. That
assumes `SLSKD_DOWNLOADS_DIR` (default: `LIBRARY_DIR`) and slskd's own downloads directory are
the same storage. If they are not, point it at wherever this container sees slskd's downloads.

Two things worth knowing before you switch it on:

- **Soulseek expects you to share.** An account sharing nothing gets few search results and
  sits at the back of every queue — slskd's own default config throttles peers with fewer than
  one shared file to one slot at priority 999, and everyone else's does the same to you. If you
  do share, filter this tool's transients so half-written files are never offered:
  `\.tidalsyncer-raw$`, `\.tidalsyncer-part$`, `\.upgrading-`.
- **The API key needs the `readwrite` role.** Searching and enqueueing both change state, and
  a read-only key is rejected. Note that slskd's YAML config *overrides* environment
  variables, so a key in `slskd.yml` wins over `SLSKD_API_KEY`.

### Upgrading what you already have

```bash
bun run download --upgrade --dry-run    # what it would replace, and with what
bun run download --upgrade --limit=5
```

`--upgrade` (or `TIDAL_UPGRADE`) turns a match into a *candidate* rather than an automatic
skip: if TIDAL would serve something better than the file on disk, it fetches it and retires
the old one. A library assembled from whatever was to hand is usually mostly lossy, and this
is how it becomes lossless without re-downloading the parts that are already fine.

Quality is read with `ffprobe`, not guessed from the extension — `.m4a` is AAC or ALAC
depending on the file, and `.flac` says nothing about whether it is 16 or 24 bit. Three rungs:

| Tier | What counts |
| --- | --- |
| `lossy` | AAC, MP3, Vorbis, Opus, WMA |
| `lossless` | FLAC, ALAC, WAV, APE, WavPack at CD depth |
| `hires` | any of those at 24-bit, or above 48 kHz |

Four things keep this honest:

- **The comparison is against what would actually be downloaded** — the best TIDAL offers,
  capped by `--quality`. A `lossless` run never claims it is about to upgrade a CD-quality
  FLAC to hi-res and then writes 16-bit. Ask for `--quality=hires` if you want those.
- **A file that cannot be read is left alone.** `ffprobe` failing is not evidence that
  TIDAL's copy is better, and overwriting is the wrong way to resolve the doubt.
- **The replacement is probed before it is committed.** Nothing is retired on the strength of
  what the catalogue promised; the old file is parked, the new one is fetched and read, and
  only a genuine improvement gets to keep the slot. Anything else is discarded and the
  original goes straight back.
- **A disappointment is remembered.** `DATA_DIR/upgrades.json` records what each run aimed at
  and what actually landed.

Those last two are what stop `--quality=hires` becoming a treadmill. `mediaTags` describe the
*catalogue*, not your subscription: a track TIDAL lists as `HIRES_LOSSLESS` comes back as
plain 16-bit FLAC on an account without the hi-res tier — no error, no preview, just a smaller
file. The old check compared the tags against the file on disk, so it saw an upgrade, fetched
it, retired a perfectly good FLAC for a byte-for-byte equal one — and, since nothing about the
track ever changes, did the same thing on the next run, and the next. Now the fetch has to
prove itself, and the verdict is written down: the track is counted as *already best*, and the
next run does not ask again unless it is aiming higher or the file on disk has since got worse.
Delete `upgrades.json` to make it forget.

`DOLBY_ATMOS` is ignored where TIDAL offers it: it is a different mix, not a better one, and
this downloads stereo.

**Where the old file goes.** `TIDAL_REPLACED_DIR` (default `DATA_DIR/replaced`) receives it,
mirroring its path in the library. Nothing is ever removed before the replacement is on disk
*and* confirmed to be better; if the download fails, or comes back no better, the original is
put straight back. Set it to an empty string to delete instead — a deliberate choice, not a
default, because it forecloses the undo.

Mind the size. Replacing most of a library retires most of a library: 550 lossy files is
somewhere around 2 GB, and it has to land somewhere with room. That is a poor fit for a small
state volume, so point `TIDAL_REPLACED_DIR` at real storage or accept the deletion.

**You never end up with two copies.** An upgrade moves the old file out of the library before
the new one takes its name, and if it cannot move it — no `TIDAL_REPLACED_DIR`, a full disk,
another filesystem it also cannot copy to — it deletes it rather than leaving a duplicate
behind for you to find later. There is nothing to prune by hand. The one arrangement that
would defeat that is a `TIDAL_REPLACED_DIR` *inside* `LIBRARY_DIR`, which puts the retired
file straight back in front of your music server; that is refused at startup with a message
saying so, rather than discovered a thousand tracks later.

**How long the undo lasts.** `TIDAL_REPLACED_RETENTION_DAYS` (default `7`) is how long a
retired file stays before a download deletes it. Set it to `0` to keep them for ever and prune
by hand.

That is a window rather than a weekly wipe, and the difference matters: emptying the directory
every Sunday would give a file retired on Saturday night one day of undo and one retired on
Monday a full seven. This way every file gets the same week, whenever it arrived. The clock
starts when the file is *retired*, not when it was recorded — a rip from 2014 would otherwise
be a decade past its window the instant something replaced it — so each one is stamped as it
moves. Empty parent folders go with the files; the directory itself stays. Pruning runs at the
start of every real download, which on the daemon means every scheduled tick, and never on a
dry run.

**Leftovers.** A run that finishes — successfully, with a failed track, or stopped by hand —
leaves nothing behind. A run that is *killed* mid-track is the exception, and there are two
answers to it. The daemon now stops gracefully: SIGTERM stops the schedule and asks the
download to finish the track it is on, waiting up to 25 seconds (hence `stop_grace_period:
30s` in the compose file — Docker's default 10s would cut it short). A second signal exits at
once. And because SIGKILL never asks, the next run also sweeps: the transients are named so
that nothing else could be called this (`.upgrading-<pid>-…`, `….<pid>.tidalsyncer-raw`,
`….<pid>.tidalsyncer-part`) and carry no audio extension, so neither the library index nor
your music server ever sees one. A dry run does not sweep, having promised to change nothing.

### Doing it from the browser

Everything above is also on the dashboard, under **Backup**, as three steps in the order they
have to happen. Start the daemon and open <http://localhost:8081>.

**1 · Playback session.** *Authorise* asks TIDAL for a device code and shows it with the link
to approve it — the same flow as `download-login`, but the daemon does the waiting, so it
works unchanged inside a container with no terminal attached. The step says `off` instead if
`TIDAL_DEVICE_CLIENT_ID` is unset.

**2 · Catalogue snapshot.** What the last snapshot found: playlists, favourites, how many
tracks carry an ISRC, how many were tombstoned. There is nothing to press — it is a phase of
the run below, taken fresh every time, because a download reads it and a stale one fetches a
stale collection.

**3 · Sync & download.** Source (the collection, or any exported playlist), quality, skip
tier and a limit, plus **dry run** (ticked by default) and **upgrade**. One button, both
phases: the chip reads *snapshotting*, then *running*.

The bar is stacked rather than a single fill, because how far along a run is matters less
than what it is producing: downloads, upgrades, skips, and failures each take their own
colour, with the remainder left dark. A growing red band says the run is failing without
anyone reading a log, and the leading edge keeps drifting while a track is in flight so a
slow download does not look like a stalled one.

Underneath is the per-track list — what happened, or on a dry run what *would* happen, with
the quality change on each upgrade row. Skips are folded away by default (on a filled-in
library they are most of the list and none of the news), and when anything fails a red
**N failed** control filters straight to those rather than making you scroll past the
successes. **Stop** finishes the current track and then stops.

The steps gate each other honestly rather than just greying out: a download says *needs a
session* when it would have to reach TIDAL without one, *needs a snapshot* when a dry run has
nothing to plan against, and warns if `ffmpeg` is missing from `PATH` (FLAC arrives inside an
MP4 container and cannot be unwrapped without it, though the AAC tiers still work). A dry run
stays available throughout, since it only reads the snapshot and the library.

### Leaving it to the schedule

The daemon runs the whole backup — snapshot, then download — on `SYNC_SCHEDULE`, immediately
after each playlist sync. One schedule, everything on it.

It is on by default and costs nothing on an install that never set downloading up: with no
`TIDAL_DEVICE_CLIENT_ID`, no stored playback session, or no `ffmpeg` behind a FLAC quality, it
logs why it is skipping and leaves the tick alone. It uses the configured defaults —
`TIDAL_DOWNLOAD_QUALITY`, `TIDAL_SKIP_TIER`, `TIDAL_UPGRADE` — against your collection, with
no limit. Set `BACKUP_ON_SCHEDULE=false` to keep it manual.

A collection takes hours at `TIDAL_DOWNLOAD_DELAY_MS`, so ticks that land on a run in progress
are skipped rather than queued, and the run continues; the next tick picks up wherever it got
to, since anything already on disk is skipped. It deliberately does *not* run on startup —
a container that restarts often would spend all its time beginning a download it never
finishes — so the first one is at most one `SYNC_SCHEDULE` away.

## Commands

| Command | Does |
| --- | --- |
| `bun run login` | One-time TIDAL browser authorisation (`--manual` to paste the URL back) |
| `bun run sync` | Mirror once (`--force` re-mirrors even with no new edition), then favourites if enabled |
| `bun run favorites` | Only mirror the TIDAL collection back to ListenBrainz |
| `bun run status` | Show what is mirrored, without contacting TIDAL (`--unresolved` names the favourites MusicBrainz could not place) |
| `bun run daemon` | Sync on startup, then sync + back up on `SYNC_SCHEDULE`; serves the dashboard too |
| `bun run export` | Snapshot your curation to `DATA_DIR/export` (JSON + `.m3u8`) |
| `bun run download-login` | Authorise the playback session `download` needs (separate from `login`) |
| `bun run download` | Snapshot the catalogue, then fetch audio from it into `LIBRARY_DIR` |
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
  index.ts          CLI: login / sync / favorites / status / daemon / export / download
  config.ts         env parsing and validation, with the saved overlay on top
  settings.ts       what is settable, DATA_DIR/settings.json, and applying it live
  export.ts         curation snapshot: export.json + .m3u8 per playlist
  download.ts       fills LIBRARY_DIR from the snapshot, resumable
  library.ts        index of what is already on disk, so download skips it
  listenbrainz.ts   createdfor listing, JSPF parsing, ISRC resolution, feedback writes
  musicbrainz.ts    batched ISRC -> recording MBID lookup, rate limited
  sync.ts           ListenBrainz -> TIDAL: edition selection, mirroring, state
  favorites.ts      TIDAL -> ListenBrainz: collection to loved recordings
  runner.ts         one run at a time, shared by the CLI, the cron tick and the dashboard
  backup.ts         device login, and snapshot-then-download as one schedulable job
  quality.ts        ffprobe-backed tiering, for deciding what counts as an upgrade
  upgrades.ts       what each upgrade attempt actually got, so none is repeated for ever
  slskd/
    client.ts       the slskd HTTP API: search, enqueue, poll transfers
    match.ts        which stranger's file to accept, written to refuse rather than rank
    fallback.ts     the Soulseek pass: search, enqueue, wait, file into the library
    pending.ts      transfers still queued when a run ends, for a later run to collect
  store.ts          atomic JSON state + run history + lookup cache
  json-file.ts      atomic write + tolerant read, shared by the stores
  logger.ts         stdout, plus the last 2000 lines for the log page
  dashboard/
    server.ts       status JSON, triggers, backup / settings / log endpoints, assets
    public/         the three pages themselves (no build step, no external requests)
  tidal/
    auth.ts         browser login, scope selection, credential guard
    device-auth.ts  the separate device-flow playback session used by download
    download.ts     HLS manifest -> segments -> ffmpeg demux
    catalog.ts      full track metadata and owned-playlist reads, for export
    storage.ts      file-backed StorageAdapter for headless use
    client.ts       playlist find / create / read / replace, collection reads
    match.ts        ISRC-first track matching with search fallback
scripts/
  preview-favorites.ts   read-only resolution check, needs no ListenBrainz token
```
