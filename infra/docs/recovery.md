# Backups and recovery (architecture v7, build step 5)

## The short version, for a co-owner reading this in an emergency

If the Mac mini is broken, stolen or dead, the journal is **not lost**. Everything is in the offsite backup, and a plain export of all text and original photos and videos is made on the first of every month. You need three things:

1. **The backup location and passphrase.** Written in the sealed envelope / password manager entry called "Baby Journal recovery" (see "What must be stored outside the Mac" below).
2. **Any computer** (Mac or Linux) with Python 3 and `restic` installed (`brew install restic` on a Mac).
3. **About an hour**, plus download time. A few hundred GB takes hours; the text comes first.

### Get at the photos and text right now, without rebuilding anything

    export RESTIC_REPOSITORY='<the repository line from the envelope>'
    export RESTIC_PASSWORD='<the passphrase from the envelope>'
    python3 bj_backup.py restore --target ~/journal-restore
    python3 bj_export.py --data-dir ~/journal-restore/pb_data --out ~/journal-export

Open `~/journal-export/<name>/index.html` in a browser. The folder `entries/` holds every photo and video, named by date. This needs no server and no account. (`bj_backup.py` and `bj_export.py` are in the `ops/` folder of the project. Keep a copy of that folder with the recovery envelope, for example on a USB stick, because the tools are needed to open the backup.)

### Get the app itself running again

1. Do the restore above. It checks every photo and video against its saved fingerprint and says `restore ok` or lists what is wrong.
2. Start PocketBase on the restored data (on any computer):

       pocketbase serve --dir ~/journal-restore/pb_data --migrationsDir backend/pb_migrations --hooksDir backend/pb_hooks --publicDir pb_public --http 127.0.0.1:8090

3. Rebuild the preview copies (they are not in the backup because they can always be re-made). With the server running, sign in as the **backup administrator** (the account `backup_pb_user`, whose password is in the vault) and ask it to reconcile:

       BASE=http://127.0.0.1:8090
       TOKEN=$(curl -s $BASE/api/collections/_superusers/auth-with-password -H 'Content-Type: application/json' \
         -d '{"identity":"backup@journal.local","password":"<its password>"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
       curl -s $BASE/api/bj/maintenance/reconcile -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
         -d '{"dry_run": false, "regenerate": true}'

   The answer lists anything missing or damaged. `"ok": true` means the journal is whole. (The administrator account is part of the restored data, so it is there on the new machine too.)
4. **If nobody remembers a password**, set one from the command line, no e-mail needed:

       BJ_NEW_PASSWORD='a-long-new-password' pocketbase bj-set-password someone@example.com --dir ~/journal-restore/pb_data --hooksDir backend/pb_hooks

   It signs that person out everywhere. Then sign in to the app with it and invite the others again if needed.
5. For use by the family again, follow `runbook.md` to put the new machine behind the VPS (change the WireGuard peer and the DNS if the address changed).

## What must be stored outside the Mac (and outside the same house)

| Item | Why | Kept where (fill in) |
|---|---|---|
| Backup repository location and passphrase | Without the passphrase the backup cannot be opened. It cannot be recovered or reset. | Password manager entry **and** a printed copy at a relative's home |
| Ansible vault password | Opens the WireGuard keys and the settings | Password manager |
| WireGuard keys and the VPS login | Rebuilding the network | Vault file in a second place |
| Google Drive (or other storage) login and any OAuth client | Reaching the repository | Password manager |
| Domain registrar login | The journal's web address | Password manager |
| The names of two people who can do all of the above | Nobody is a single point of failure | Printed with this page |

Both owners should be able to open every item on this list. Test it once (see the drill).

## What the nightly backup does

It runs at 03:15. In order, and stopping at the first problem:

1. Takes the maintenance lock (the trash purge waits while it is held).
2. Makes a consistent copy of the database with SQLite's online backup, and checks the copy.
3. Writes a manifest of every stored original (path, size, SHA-256) **from that copy**, so a photo uploaded after the copy is never listed without being in it.
4. Sends the database copy, the manifest and the originals to the repository in **one** restic run, so they share one snapshot.
5. Checks that every file in the manifest is in the snapshot with the right size, has restic re-read a share of the repository (5 percent), and re-reads three random files and compares their fingerprints.
6. Only then marks exactly those photos and videos "offsite protected" in the app, and records the run.
7. Keeps the database copy and manifest locally (Time Machine picks them up), releases the lock, and pings the dead-man switch.

If anything fails, nothing is marked protected, the failed run is recorded, and an alert is sent. A job that is killed halfway protects nothing, and its leftover lock is recognised as stale.

Preview copies (display and playback files) are **not** backed up by default; they can be re-made from the originals. That keeps the repository about half the size, at the cost of a reconcile step after a restore. Set `backup_include_derived: 1` to include them.

## Alerts

| When | Level | Channel |
|---|---|---|
| A backup run fails or does not verify | critical, at once | `bj-alert.sh` |
| No verified offsite backup for 18 hours | warning | `bj-alert.sh`, and the banner in the app |
| ... for 24 hours | critical, repeated every 6 hours | same |
| The monthly integrity check finds a missing, resized or corrupt original | critical | same |
| The SSD is missing at start | critical | same |
| The nightly job does not run at all (the Mac is off) | the dead-man switch | `healthcheck_url` (works even when the Mac is down) |

The 30-minute watchdog reads the database directly, so it keeps working if PocketBase itself is stopped. **Decision needed:** `alert_url` (an ntfy-style push) and `healthcheck_url` (for example healthchecks.io) are empty until you choose them. Pick channels that do not depend on this Mac or this VPS.

## Time Machine

Time Machine is the fast local copy. The playbook excludes the live database files (a copy of a database that is being written to is not consistent) and lets it copy the nightly database copies, manifests and exports on the SSD. Treat it as convenience, never as the only backup.

## The offsite repository: Google Drive and its limits

The tool works with any restic repository. The default in the settings is `rclone:gdrive:babyjournal-restic`:

1. `rclone config` on the Mac (as the service user) and create a remote called `gdrive`. Use your **own** OAuth client ID (Google's shared one is throttled) and give it the `drive.file` scope.
2. `restic init` once with the passphrase, then run a first backup by hand and check it.

Honest limits to know about:

- Google Drive cannot be made append-only. Anyone holding the Drive credentials, including a thief of this Mac, could delete the repository. Mitigations: use a Google account that is not used for anything else, protect it with a hardware key, keep the Drive credentials out of the family's everyday accounts, and let the monthly export on the SSD plus Time Machine be the second copy.
- Pruning old snapshots needs delete rights. `bj_backup.py forget --apply` therefore belongs on a **different machine** than the one that makes the backups. It is a dry run unless `--apply` is given. The policy is daily 14, weekly 8, monthly 12, yearly 3.
- If you prefer a repository that can be made append-only (restic `rest-server --append-only`, or a storage provider with object lock), set `restic_repository` to it; nothing else changes.

## The restore drill (do it before relying on any of this, then every quarter)

On a **different** computer with none of your files on it:

1. Install `restic` and Python 3. Set the two environment variables from the envelope.
2. `python3 bj_backup.py restore --target ~/drill`. Expect `restore ok`.
3. Start PocketBase on `~/drill/pb_data`, run the reconcile request, expect `"ok": true`.
4. Sign in as an owner (reset the password with `bj-set-password` if needed) and open a photo from the first month and a video from the last month. Seek in the video.
5. Run `bj_export.py` and open `index.html`; run `sha256sum -c checksums.sha256`.
6. Write down how long it took and what was awkward. Fix the instructions on this page.

An automated version of steps 2 to 5 runs in the test suite (`ops/tests`), against a real repository, but it does not replace doing it once with your real data on a real second machine.

## Monthly jobs

- **Integrity check** (PocketBase, 05:30 on the 1st): re-hashes a random 5 percent of the originals and checks every file's presence and size. Problems raise a critical alert.
- **Plain export** (launchd, 04:30 on the 1st): written to `exports/<date>` on the SSD; the three newest are kept. It is made from the newest database copy and the originals, and needs no server.
- **Trash purge** (daily, 04:10): permanently removes trash older than 30 days **only if** the item is in a verified backup, no backup is running, and the last verified backup is under 48 hours old. It is a **dry run** until `purge_enable: "1"`. Read the log of a few dry runs first (`pocketbase.log`, lines starting `[bj purge dry run]`).

## Decisions to confirm

1. **Which alert channels** (above).
2. **Preview copies in the backup or not** (`backup_include_derived`). Default: not.
3. **The second copy of the exports.** They are on the SSD and in Time Machine. If you want them off-site too, add `rclone copy` of the export folder to a different account.
4. **Who runs `forget`.** It needs a second machine with delete rights; until then the repository only grows.

## Not verified yet

- A real Google Drive repository: speed, throttling and rclone behaviour at hundreds of GB. The tests use a local repository.
- launchd running the jobs on the Mac (calendar schedule after a sleep, the `PathState` mount guard with a real unplugged SSD), and `tmutil` exclusions. Templates are checked for syntax; the mount guard script itself is tested.
- A restore of a real library over a real connection, and the time it takes.
- Time Machine restore.
