# Baby Journal: guide for Claude (read this first, it replaces re-reading the history)

A self-hosted family baby journal. PocketBase backend, React PWA, Ansible-managed VPS + Mac mini, restic backups.
Spec: the "Baby Journal: Architecture and Requirements" Claude Doc, draft v7 (https://claude.ai/artifact/ArDWuzEXKQBtXZPByas6n2).
It is ~70 KB: do not read it whole. Section map: 2 requirements, 4 clients, 5 backend/data model, 6 media, 7 network, 8 security,
9 backup/recovery, 10 operations, 14 open decisions, 15 build order. Read only the section a task needs.

## Status (build order, section 15)
1 data foundation done | 2 media integrity done | 3 offline PWA done (not yet on real phones) | 4 network/security done (not yet on real hardware) |
5 backups/recovery done (not yet on Google Drive or the Mac) | **6 pilot on real phones: next, needs the owner** | 7 operate.
Nothing here has run on real infrastructure. Open owner decisions are listed at the end of README.md and infra/docs/*.md.

## Layout
- `backend/` PocketBase 0.40.6 (pinned): `pb_migrations/` schema + rules, `pb_hooks/` routes (`main.pb.js` entries/invites/members, `media.pb.js`, `backup.pb.js`, `maintenance.pb.js`) and shared code (`lib.js`, `media_lib.js`, `maintenance_lib.js`), `tests/`
- `client/` React 19 + Vite PWA, plain JS. `src/lib/` sync engine (`sync.js`), upload queue (`media.js`), IndexedDB (`db.js`), `age.js`; `src/ui/` screens; `tests/` vitest against the real server
- `ops/` `bj_backup.py` (backup/watch/restore/forget), `bj_export.py` (plain export). Python stdlib only
- `infra/` `ansible/` (roles `vps`, `macmini`; templates are the single source for Caddy/HAProxy/launchd), `tests/`, `docs/runbook.md`, `docs/recovery.md`
- `tools/` `get-pocketbase.sh`, `get-caddy.sh` (binaries are not committed). `scripts/check.sh` runs the tests

## Run the tests (use this, it prints a few lines; full logs go to /tmp/bj-check/<suite>.log: grep them, never print them whole)
    scripts/check.sh               backend (75) + client (43), about 1 minute
    scripts/check.sh infra         config checks (22), mount guard (7), network chain (31)
    scripts/check.sh ops "restore|export"   the slow backup suite in parts; groups: nightly, consistency, killed, failures, alert levels, restore on, retention, export (each part under 3 minutes)
Needs: node 22, python3, ffmpeg, ImageMagick, exiftool, restic, sqlite3, haproxy, wireguard-tools, ansible-core; `tools/get-pocketbase.sh` and `tools/get-caddy.sh` run once.

## Behaviour that matters (do not break; each has a test)
- Roles: owner / editor / viewer. All writes to journals, members, invites, entries go through `/api/bj/*` routes (collections are read-only to clients). Viewers never reach originals (they live in `media_originals`, separate from viewer-safe `media`).
- Entry sync is atomic and idempotent (`/api/bj/entries/sync`, idempotency key); a stale edit becomes a conflict version, never an overwrite. Date-only fields are text `YYYY-MM-DD`. Measurements need a unit suffix (`weight_kg`).
- Media: stored only after size and SHA-256 match; server makes its own metadata-stripped copies and refuses any with GPS/device tags. Max 5 GB/file. Protected-file tokens last 1 h; sign-in 30 days.
- Backup marks "offsite protected" only for files in a verified snapshot (`/api/bj/backup/mark`). Purge removes 30-day-old trash only if a verified backup holds it, none is running, and the last one is under 48 h old; it is a dry run unless `BJ_PURGE_ENABLE=1`. Alerts: 18 h warning, 24 h critical.
- Admin UI and superuser API are reachable only from the home network and the tunnel; the internet sees only the app's API.

## Pitfalls already hit (save yourself the time)
- PocketBase JS hooks: handlers run in isolated scopes. Top-level consts/functions are invisible inside handlers; put shared code in a `pb_hooks/*.js` module and `require(`${__hooks}/x.js`)` inside the handler. A script error becomes a bare "Something went wrong" 400: use `console.log` in the handler to see it.
- `required: true` on a number field rejects 0. `findFirstRecordByFilter` has no sort argument (use `findRecordsByFilter(..., sort, 1, 0)`). `$os.mkdirTemp` does not exist (use `mkdirAll`).
- Caddy `servers` options must be keyed by the exact bind address (`127.0.0.1:9443`), or the PROXY-protocol wrapper is silently not applied.
- An invalid or revoked token on a list endpoint behaves as a guest (200, nothing visible), not 401.
- Client tests run in jsdom: its `File`/`FormData` do not work with Node's `fetch` or fake-indexeddb; the tests use Node `File` and a hand-built multipart transport.
- restic unlocks the repository on every command (about 2 s here), so backup tests are slow. Never leave test servers or a paused backup running: they hold a lock and break later runs (`scripts/check.sh` cleans up).
- In this sandbox `/bin/sh` does not expand `{a,b}`; `pkill -f pattern` kills your own shell unless written `"[p]attern"`; background jobs get reaped, so run tests in the foreground with a timeout.

## Working agreements (keep token use low)
- Start from this file and `git log --oneline`; do not re-read the architecture doc, the README or old tests unless the task touches them. Use `git diff --stat`, `grep -n`, and `sed -n 'a,bp'` instead of printing whole files.
- Change one area at a time and run only its suite (`scripts/check.sh backend`, `client`, `infra`, or one ops group). Run everything once before reporting done.
- Report in a few lines: what changed, what is tested, what is not verified, what the owner must decide. Put long material in files (docs/, README.md), not in the chat.
- Do not add features beyond the spec without asking. Record new owner decisions in the relevant docs file.
