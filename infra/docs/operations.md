# Operating the journal (architecture v7, build step 7)

The aim is a few hours of human time a quarter. Everything routine runs by itself and tells you by alert when it needs you. This page says what runs, what to do when it speaks, and the short list of things only a person can do.

## What runs by itself

| What | When | Where | Tells you by |
|---|---|---|---|
| Nightly backup, verified | 03:15 | Mac | alert if it fails; app banner at 18 h and 24 h |
| Backup watchdog (age, failed run) | every 30 min | Mac | alert |
| Monitor: PocketBase, SSD, disk 70 / 85 %, drive health, certificate, WireGuard, Time Machine | every 10 min | Mac | alert (once per change, reminder every 6 h while critical, "back to normal" notice) |
| **Uptime probe of the public address** | every 2 min | **VPS** | alert after 3 failures in a row; works even if the Mac or the house is down |
| Dead-man switch (the backup pings it) | nightly | outside both | alert if the nightly job never reports |
| Trash purge (dry run until you switch it on) | 04:10 daily | PocketBase | log only |
| Integrity check, 5 % re-hashed, every file's presence and size | 1st, 05:30 | PocketBase | alert if a problem is found |
| Plain export, last three kept | 1st, 04:30 | Mac | alert if it finishes with problems |
| Capacity projection and the one-page monthly report | 2nd, 06:00 | Mac | the report file |
| **Restore drill**: restore, boot a server on it, reconcile, export, verify | Jan, Apr, Jul, Oct, the 3rd | Mac | alert: "passed" (info) or "FAILED" (critical) |
| Certificate renewal | automatic, about 30 days before expiry | Caddy | monitor warns under 21 days |
| Security updates | automatic | VPS | none needed |

Setting these up is part of `macmini.yml` and `vps.yml`. Alert channels (`alert_url`, `healthcheck_url`) must be chosen first: see `recovery.md`.

## What a person does

| How often | What | Time |
|---|---|---|
| When an alert arrives | Look it up in the table below | 5 to 30 min |
| Monthly | Open `<state>/monitor/reports/monthly-YYYY-MM.md`. Anything marked **ACT** needs a decision; nothing marked means nothing to do | 5 min |
| Quarterly | Check that the drill passed (the report says when it last did). Copy the newest export folder and a copy of the recovery page and tools to the portable drive kept away from the Mac | 20 min |
| Yearly | The checklist at the end of this page | 2 to 3 h |
| Every few years | Replace hardware before it fails (see "Hardware lifecycle") | a weekend |

## When an alert arrives

| Alert says | Meaning | Do this |
|---|---|---|
| `The journal does not answer at ...` (from the VPS) | The public address failed 3 probes in a row | Follow "The site is down" below |
| `Backup failed: ...` | Nothing from this run is marked protected | Read the reason in `backup.log`. Fix it, then run the backup by hand: `bj_backup.py backup`. Common causes: repository unreachable, a missing or damaged original (it names the file) |
| `No verified offsite backup since ...` (critical, 24 h) or the 18 h warning | The recovery target is not met | Same as above. Nothing is lost yet, but the next failure could cost data |
| `Disk is 7x% full` / `8x% full` | Capacity: uploads are refused at 90 % | "Disk full", below |
| `The external SSD is missing` | The SSD is unplugged or not mounted; PocketBase stays stopped on purpose | Plug it in; PocketBase restarts itself. If it will not mount, see "Replace the SSD" |
| `drive reports a SMART FAILURE` | The SSD is dying | Order a new one now; "Replace the SSD" |
| `The certificate expires in N days` | Renewal is not happening | Check that Caddy runs and that the VPS path works (the uptime probe tells you). Look at `caddy.log` |
| `The WireGuard handshake is N minutes old` | The tunnel to the VPS is down or flapping | "The site is down", step 3 |
| `The last Time Machine backup is N hours old` | The local copy is stale | Check the Time Machine disk is connected; it is convenience, not the main backup |
| `Monthly integrity check found problems` | A file is missing, resized or damaged on the SSD | Run `reconcile` (dry run) for the list, then restore the named files from the backup (`recovery.md`) |
| `The restore drill FAILED: ...` | Recovery was tested and did not work | Treat as an outage of the safety net: read `drill-YYYYMMDD.json`, fix, and rerun `bj_backup.py drill` before anything else |
| `Monthly export finished with problems` | An original was missing when the export was made | Same as the integrity alert |

## Runbooks

### The site is down
1. Is it just you? Try mobile data and a second phone. The VPS probe alert means the outside world cannot reach it.
2. **VPS**: `ssh` in. `systemctl status haproxy wg-quick@wg0`. If down, `systemctl restart`. If the VPS itself is unreachable, check the provider's status and console.
3. **Tunnel**: on the VPS `sudo wg show` (a recent "latest handshake"?). On the Mac `sudo wg show`. No handshake: the Mac is offline, asleep, or the home internet is down.
4. **Mac**: is it on? Power cut? (It restarts by itself; with FileVault on it waits at the password screen.) `launchctl print system/com.babyjournal.caddy` and `...pocketbase`.
5. **PocketBase stopped on purpose** when the SSD is missing: plug it in.
6. **Disk full** stops uploads, not reading: see below.
7. When it is back, the apps catch up on their own: phones hold their unsent entries and photos and send them.

### Add or remove a family member
In the app, People: an owner creates an invite link (role editor or viewer, works once, 7 days). To remove someone: People, Remove. Their sessions end at once. "Sign out everywhere" ends all of a person's sessions (a lost phone). Nothing needs to be done on the servers.

### Someone forgot their password
There is no e-mail reset by design. On the Mac (or any machine with the data): `BJ_NEW_PASSWORD='...' pocketbase bj-set-password person@example.com --dir <pb_data> --hooksDir <backend/pb_hooks>`. They are signed out everywhere and use the new password.

### Disk full or growing fast
`bj_monitor.py capacity` shows growth per month and the months left. Options, in order: add storage (an SSD swap is a restore: see below); stop keeping the display and playback copies offsite if they were enabled (`backup_include_derived: 0`); empty the trash sooner (purge needs a verified backup first). Originals are never deleted to make room.

### Replace the SSD (dying or full)
1. Take a verified backup now. 2. Format the new SSD, create the `.bj-volume-marker` file, name it as before. 3. `bj_backup.py restore --target <new>` then move `pb_data` into place (or point `bj_data_dir` at it and run `macmini.yml`). 4. Run reconcile with `regenerate: true`. 5. Run the backup once and confirm the app banner is green.

### Replace the Mac mini (or after a loss)
Same as the recovery steps in `recovery.md`: new Mac, `macmini.yml` and `deploy.yml`, restore the data, reconcile, update the WireGuard peer if the address changed, run the uptime probe and the drill. Practise this on the old Mac's replacement **before** the old one dies.

### Replace the VPS
New VPS, `vps.yml`, update the DNS record, rotate the WireGuard keys (`runbook.md` section 8). The VPS holds no data and no certificate, so nothing is migrated.

### Upgrading
Versions are pinned (`tools/get-*.sh`, `infra/ansible/group_vars/all.yml`, `client/package-lock.json`). See what is newer with `scripts/versions.sh`. Upgrade **one component at a time, never in a hurry**:

1. `scripts/upgrade-pocketbase.sh <version>` or `scripts/upgrade-caddy.sh <version>` runs the candidate against the whole suite (backend, client; or config checks and the network chain) without touching anything real.
2. Read the release notes for changes to migrations, JS hooks and the admin API (PocketBase) or the Caddyfile and PROXY protocol (Caddy).
3. For PocketBase, also start it on a **restored copy** of the data and run reconcile.
4. Change the pin and checksum, take a backup, then run `macmini.yml`. The play validates the new Caddyfile with the new binary before installing it.
5. Watch the next monitor cycle and the next nightly backup.

As of the last check: Caddy 2.11.9 passes all 35 network tests (the pin is 2.11.8); restic on the build machine is older than the newest release and has not been tried against the backup tests; PocketBase is current. The client's dependencies are locked; update them deliberately, with `scripts/check.sh`.

## Capacity planning
The monitor samples the disk daily. `bj_monitor.py capacity` prints growth per month and the months until 70 % and 85 %; a warning is raised when 85 % is under six months away. Originals dominate: phone video is the main driver. At the planning figure in the architecture document, review storage once a year even if no alert has fired.

## Hardware lifecycle
- **Mac mini**: plan to replace at 5 to 7 years, or when macOS support ends, whichever is first. Do the replacement as a rehearsal, from backup, while the old one still works.
- **External SSD**: replace at 4 to 5 years or at the first SMART warning. Keep the Time Machine disk and the portable offline copy on different media.
- **VPS**: the operating system's support end date is the deadline (Ubuntu 24.04 LTS: standard support to 2029). Rebuild on a new release a year before.
- **Router, power and UPS**: a small UPS lets the Mac shut down cleanly; note its battery age.
- **Domain and accounts**: put the domain renewal and the Google Drive account on the yearly checklist.

## Yearly checklist (2 to 3 hours, both owners)
- [ ] Read this year's monthly reports; act on anything that recurred.
- [ ] Both owners sign in with the recovery page only, from a clean browser, and confirm every credential in `recovery.md` still opens (password manager, vault, Drive, registrar, VPS).
- [ ] A **manual** restore on a different computer with the real repository (not only the scripted drill); time it; update `recovery.md` where it was awkward.
- [ ] `scripts/versions.sh`: decide which pinned components to upgrade, using the upgrade scripts.
- [ ] Review the decision log (`docs/decisions.md`): close or revisit open items.
- [ ] Check retention settings and repository size; run `bj_backup.py forget` (dry run first) from the second machine.
- [ ] Check disk growth and the hardware ages above; order replacements early.
- [ ] Rotate the WireGuard keys and the backup passwords if the people with access changed.
- [ ] Open three entries from three different years of the newest plain export on a computer that has none of this software, and run the checksum check (the export README says how).
- [ ] Confirm the old app archive (Firestore and Drive exports) is still readable.

## Not verified yet
- None of the scheduled jobs has run on the real Mac; the launchd and systemd units are checked for syntax and their scripts are tested.
- `wg show` and `tmutil` output formats are tested against fakes written from their documentation, not real hardware.
- The VPS probe is tested through the real chain on one machine, not across the internet.
