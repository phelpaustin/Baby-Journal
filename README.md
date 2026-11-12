# Baby Journal (self-hosted rebuild)

Implementation of *Baby Journal: Architecture and Requirements*, draft v7.
Build order follows section 15 of that document.

## Status

| Build step (section 15) | State |
|---|---|
| 1. Data foundation | Schema, access rules, server hooks, JSON export and tests done. The timeline, gallery and captions views (client) are not started. |
| 2. Media integrity | Server side done and tested: verified uploads, derived copies, backup states. The client upload queue and the monthly re-hash job are not started. |
| 3. Offline-first PWA | Client built (`client/`): sign-in, invites, timeline, entry editor, photo and video upload queue, milestones, people, settings, conflict screen. Tested in a simulated browser against the real server, not yet on real phones. |
| 4. Network and security | Ansible code for the VPS and the Mac mini, plus a runbook. Configs validated with the real tools and the whole chain tested locally (31 tests). Not yet run on a real VPS or Mac. |
| 5. Backups and recovery | Backup, verify, alert, restore, plain export, trash purge, integrity check and account recovery are built and tested against a real restic repository and a restored second server. Mount guard tested. Not yet run against Google Drive or on the Mac. |
| 6. Migration and pilot | Importer (check, run, reconcile; idempotent and resumable), Firestore adapter, in-app pilot diagnostics and the pilot kit are built and tested. The real import needs sample Firestore documents from you; the pilot needs real phones. | 
| 7. Operate | Monitor (disk, SSD, drive health, certificate, tunnel, Time Machine), VPS uptime probe, scripted quarterly restore drill, capacity projection and monthly report, upgrade rehearsals, runbooks, yearly checklist and a decision log are built and tested. None has run on the real Mac or VPS yet. |

## Run the tests

Short form: `scripts/check.sh` (backend + client), `scripts/check.sh infra`, `scripts/check.sh ops "restore|export"`. It prints a few lines per suite and keeps full logs in `/tmp/bj-check/`. `CLAUDE.md` is the compact guide for working on this project with Claude. The individual runners:

    tools/get-pocketbase.sh      # downloads PocketBase 0.40.6 (pinned)
    # the media tests also need: ffmpeg, ffprobe, exiftool and ImageMagick (convert) on the PATH
    cd backend && npm test       # starts a throwaway server, runs 75 tests, stops it

## Run the app on your own machine

    # 1. server (once: create the admin login; see the first-owner note below)
    cd backend
    ../tools/pocketbase superuser upsert you@example.com 'a-long-password' --dir ./pb_data --migrationsDir ./pb_migrations
    # 2. build the app into the server's public folder
    cd ../client && npm install && npm run deploy:local
    # 3. start everything on http://127.0.0.1:8090
    cd ../backend && ../tools/pocketbase serve --dir ./pb_data --migrationsDir ./pb_migrations --hooksDir ./pb_hooks --publicDir ./pb_public --http 127.0.0.1:8090

Open `http://127.0.0.1:8090/_/` once, sign in with the admin login and create the first person in the `users` collection (registration is invite-only). Then sign in to the app with that account and create the journal. For development with live reload run `npm run dev` in `client/` (it proxies `/api` to port 8090).

## Layout

    backend/pb_migrations/   collections, access rules, closed registration, rate limits
    backend/pb_hooks/        custom routes (main.pb.js) and shared logic (lib.js)
    backend/tests/           integration tests (node:test, no dependencies)
    client/src/lib/          sync engine (offline outbox), upload queue, local storage, age labels
    client/src/ui/           screens
    client/tests/            engine and screen tests against the real server
    infra/ansible/           the VPS and Mac mini roles, group variables, vault example
    infra/tests/            config validation and the chain tests
    infra/docs/runbook.md   setup order, acceptance checks, drills, key rotation
    infra/docs/recovery.md  what a co-owner needs if the Mac is gone; the restore drill; alert levels
    ops/                    bj_backup.py (backup, watch, restore, forget) and bj_export.py (plain export)

## Server API (all under /api/bj, signed-in users only unless noted)

| Route | Who | What |
|---|---|---|
| `POST journals/create` | first user, or an existing owner | Creates a journal and its first owner membership |
| `POST journals/update` | owner | Name, emoji, due date, date of birth, settings |
| `POST invites/create` | owner | Returns a raw token once. Only its SHA-256 hash is stored. Expires in 7 days |
| `POST invites/accept` | signed-in | Single use, never changes an existing member's role |
| `POST auth/register` (no login) | holder of a valid invite | Closed registration: the only way to create an account |
| `POST members/role`, `members/remove` | owner (anyone may leave) | Last-owner rule enforced on the server; removal revokes the person's sessions |
| `POST members/sign-out`, `me/sign-out-everywhere` | owner / self | Rotates the account token key |
| `GET journals/export?journal=ID` | owner | Versioned JSON export (entries, history, members, media metadata and checksums) |
| `POST entries/sync` | owner, editor | `op` = upsert, trash, restore, resolve. Atomic and idempotent. Stale writes become conflict versions |

| `POST media/upload` | owner, editor | Multipart: `journal`, `entry`, `client_id`, `kind`, `sha256`, `size`, `file`. Stored only after size and SHA-256 match. Idempotent by `client_id` |
| `POST media/update` | owner, editor | Caption, sort order, corrected capture date, trash and restore. Never touches the original |
| `POST backup/record` | superuser (backup job) | Records a run; a verified run marks existing media offsite protected |
| `GET backup/status` | signed-in | `ok`, `warning` (18 h) or `critical` (24 h, or no good backup) and a count of media not yet offsite |

Reads (journals, members, entries, media) use the normal PocketBase collection API; every write goes through a route above.

## Deviations from the architecture document (please confirm)

1. **Originals are in their own collection, `media_originals`.** The document puts `file` and the display and playback copies in one `media` row. PocketBase applies the record's view rule to every file field, so a viewer who can read the row can fetch every file in it. Splitting the original into a separate collection is what makes "viewers never reach originals" enforceable.
2. **Account creation is closed.** The document says invites are accepted server-side but does not say how a new person gets an account. `auth/register` creates the account and consumes the invite in one transaction, and open sign-up is switched off.
3. **Journal creation is limited** to the first user and existing owners, so invited family cannot create journals and use up storage.
4. **A rejected or revoked token behaves as a guest on list endpoints** (200 with nothing visible), and is refused (401) where sign-in is required. This is PocketBase behaviour. The document's removal test should check for "sees nothing" rather than only "401".

5. **The server makes the display, poster and playback copies; it ignores copies made by the client.** Section 6.2 has the client create a stripped preview. A viewer's privacy should not depend on the client getting that right, so the server builds its own and refuses to attach any derived file that still contains GPS or device tags (the derive is then marked failed and retried).
6. **Derived files are made inside the upload request** for now. A long HEVC transcode could outlast a proxy timeout; if the pilot shows that, move it to the existing retry job.

## Media notes

- Photos: display copy is a JPEG at most 2560 px, upright, ICC profile kept, all other metadata removed. Videos: H.264 and WebM are stream-copied without re-encoding; everything else (HEVC and so on) becomes H.264/AAC. Both drop all container metadata.
- Needed on the server: ffmpeg, ffprobe, exiftool, ImageMagick (with HEIC support), and `timeout` (on macOS: `brew install coreutils`, which provides `gtimeout`).
- Free-space guard: uploads are refused with 507 above 90% disk use (`BJ_DISK_REFUSE_PCT` to change).
- Limit: 5 GB per file.

## Not verified yet

- Real iPhone files: HEIC photos and HEVC .MOV could not be created in the test environment. Test them on a real phone (section 4.1).
- The disk-space guard has no automated test.
- Range requests are verified against PocketBase directly, not yet through Caddy, WireGuard and the VPS.
- Resumable uploads are not built (section 14 says to start without).
- Metadata of the display copy is checked by tag name (GPS, make, model, serial numbers, location); an unknown vendor tag would not be caught.

## Known gaps in step 1

- Notifying other owners of owner changes is written to the audit log only. Email waits for the mail relay (section 7.4).
- A conflict version also touches the entry's `updated` time, because the entry row is saved to set `needs_review`.
- The first owner account is created from the command line (`pocketbase superuser` and the admin UI), since registration needs an invite.

## The client (build step 3)

React + Vite PWA, plain JavaScript, no state library. Hash-based routes (`#/j/<journal>/...`), so any static host or PocketBase itself can serve it.

- **Offline first.** Every change is written to IndexedDB before anything is sent and shown at once, marked "Waiting to send". Entries open from a local copy with no connection. Photos and videos are kept on the phone until the server confirms them (checksum verified), then the local copy is dropped.
- **Honest states.** "No internet" and "can't reach the journal" are different messages. A rejected change or failed file stays visible under *Needs attention* with the reason, and can be retried or deleted by the person. Signing out with unsent items asks first.
- **Conflicts.** An entry with two versions is flagged on the timeline. Owners and editors open it, see both, and save the final text; the history is kept.
- **Large videos.** Hashing is streamed in 8 MB chunks, so a multi-GB file does not need that much memory.
- **Service worker.** Caches the app files only. Nothing under `/api` (including tokenised photo URLs) is ever cached.
- **Access.** Viewers see no editing controls. The server enforces the same rules; the screens are only a convenience.

### Decisions to confirm

1. **Entry text is plain text** (shown with line breaks, never as HTML). The field is named `editor` on the server for later, but rendering other people's HTML in a family app is a risk with no payoff yet. Rich text can be added with a sanitiser.
2. **Password sign-in only.** Google sign-in is not built. There is no password reset, because it needs the mail relay (section 7.4): until then an owner resets a password from the admin page.
3. **Photos and videos need the server to be viewed.** Text and the timeline work offline; thumbnails do not, because tokenised URLs must not be cached.
4. **Uploads continue only while the app is open.** Mobile browsers pause background tabs; the banner says so. Resumable uploads are not built (section 14).
5. **File and sign-in token lifetimes** are one hour and 30 days (a backend migration), because the 2-minute default breaks video seeking.

### Not verified yet

- Real phones: iOS Safari and Android Chrome (install, storage eviction, camera and HEIC pickers, the update flow). This needs a pilot (section 15, step 6).
- Large real videos over a slow connection through Caddy and WireGuard.
- Accessibility with a screen reader. Text is large, contrast is high and targets are 44 px, but it has not been audited.
- English only.
- Android packaging (Trusted Web Activity) is not started.

## Network and security (build step 4)

See `infra/docs/runbook.md` for the setup order and the acceptance checks. In short: the VPS runs HAProxy as a raw TCP forwarder (TLS passthrough, no certificate, no data), WireGuard carries the traffic to the Mac mini, and Caddy on the Mac ends TLS and serves the app. The Mac dials out, so no router settings are needed.

What the local tests prove about the real configuration:

- The certificate a client sees is Caddy's, so TLS ends at home; the forwarder config has no `ssl`, `crt` or HTTP mode.
- From the internet only the app's own API exists. The admin UI and every superuser endpoint (settings, logs, backups, realtime, collection schemas, the superuser sign-in) answer 404. They work from the home network and the tunnel.
- The real client address reaches PocketBase (through the PROXY protocol and `X-Real-IP`), so sign-in limits are per person; a forged `X-Real-IP` or a forged PROXY header from anyone but the VPS does nothing.
- Access logs never contain file tokens, Authorization headers or cookies.
- Viewers, outsiders and removed members cannot fetch originals, display copies or thumbnails through the full chain.
- A 1 GB video goes through the chain in about 8 s on loopback with Caddy using about 50 MB (not buffered), the checksum matches, and the playback copy answers range requests from the middle and the end.
- Strict CSP, HSTS, `nosniff`, no referrer, no `Server` header; the built app has no inline scripts or styles and no external hosts, so the CSP does not break it.

A bug the tests caught: Caddy silently ignored the PROXY-protocol listener option because it was keyed by port instead of the full bind address. A check now asserts the wrapper is attached to the VPS listener only.

## Backups and recovery (build step 5)

See `infra/docs/recovery.md`. It is written to be read by a co-owner in an emergency, and includes the restore drill to do before relying on any of this.

- **Nightly backup** (`ops/bj_backup.py`, 03:15): lock, SQLite online snapshot, manifest made from that snapshot, one restic run, verification (every manifest file present with the right size, restic re-reads 5 percent of the repository, three random files re-hashed), and only then the files are marked "offsite protected". A failed or killed run protects nothing and alerts.
- **Alerts**: a failed run at once; 18 hours without a verified backup is a warning, 24 hours critical (reminders every 6 hours); the same levels show as a banner in the app. A dead-man-switch URL covers the case where the whole Mac is off.
- **Restore**: `bj_backup.py restore` needs only the repository and its passphrase, re-hashes every original, and the restored server then rebuilds the preview copies with the reconcile route.
- **Plain export** (`ops/bj_export.py`, monthly): folders by year with `index.html`, original photos and videos, `journal.json` with history and a schema version, a README, and a checksum list. It reads a database snapshot directly, so it needs no PocketBase.
- **Trash purge**: removes trash older than 30 days only if a verified backup holds it, no backup is running and the last backup is under 48 hours old. A dry run until you switch it on.
- **Integrity check**: monthly, re-hashes a random 5 percent and checks every file's presence and size.
- **Account recovery without e-mail**: `pocketbase bj-set-password <email>` (password from the environment) on any server, including a restored one.
- **Mount guard**: PocketBase will not start unless the SSD is a different filesystem than the internal disk and carries the marker file.

Server routes added: `POST /api/bj/backup/mark` (superuser: flags exactly the files a verified snapshot holds), `POST /api/bj/maintenance/purge` and `POST /api/bj/maintenance/reconcile` (superuser, dry run by default). `POST /api/bj/backup/record` now only records the run; it no longer marks anything by itself.

Decisions to confirm: alert channels, whether preview copies go into the backup (default: no, they are re-made), and who runs `forget` (it needs delete rights on the repository, so it belongs on a second machine).

## Migration and pilot (build step 6)

See `infra/docs/migration.md` (what to send me, step by step, bundle format) and `infra/docs/pilot.md` (gates, measurements, go/no-go).

- `ops/bj_firestore_adapter.py` turns a Firestore JSON export plus the downloaded Drive files into a plain bundle, using a mapping file (`ops/import-mapping.example.json`). It converts the four Firestore timestamp shapes, puts events on the right calendar day in your time zone, converts units, and warns about everything it cannot map.
- `ops/bj_import.py check | run | reconcile`: `check` validates offline; `run` loads entries with their original author and written-on time (server route `/api/bj/import/entry`, superuser only) and uploads the files with checksums; it can be interrupted and repeated, and never changes an existing entry; `reconcile` proves counts, every field and every file's SHA-256 against the source.
- The app records start-up timings and upload outcomes locally (Settings, Pilot diagnostics) and copies a plain-text report, so the pilot's thresholds (start-up targets, the 2 percent and 1 GB rules for resumable uploads) are measured, not guessed. Nothing is sent anywhere.

## Operating it (build step 7)

See `infra/docs/operations.md` (what runs by itself, what to do for each alert, runbooks, the yearly checklist, hardware lifecycle) and `docs/decisions.md` (the decision log, with the open items).

- `ops/bj_monitor.py check` runs every 10 minutes on the Mac: PocketBase health, SSD present, disk 70 % / 85 %, drive health, certificate expiry (21 / 7 days), WireGuard handshake age, Time Machine age. It alerts once per change, reminds every 6 hours while critical, and says when things return to normal. `capacity` projects the months until the disk is 70 % and 85 % full; `report` writes the one-page monthly report with the items that need a decision marked **ACT**.
- The VPS runs its own uptime probe every 2 minutes against the public address and alerts after three failures in a row, so it still works when the Mac or the house is down.
- `bj_backup.py drill` is the quarterly restore check, scripted: restore from the offsite repository, boot a server on the restored data, rebuild the previews, reconcile, export, verify the export, and record the result (alert on failure).
- `bj_export.py --verify FOLDER` checks an export (structure, links, every checksum).
- `scripts/versions.sh` shows pinned versus latest; `scripts/upgrade-pocketbase.sh` and `scripts/upgrade-caddy.sh` rehearse an upgrade against the full test suites without touching anything real. Caddy 2.11.9 passes all 35 network tests; the pin is still 2.11.8 until you decide.
