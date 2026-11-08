# The pilot (architecture v7, build step 6)

Purpose: find out with real phones and real family members what the tests cannot. This page is the plan, the measurement method and the go/no-go rules. Nothing here can be run by the developer alone.

## Before anyone is invited (all must be true)

| Check | How |
|---|---|
| The server and the network work for real | `runbook.md` section 6 passed, from mobile data |
| The nightly backup has run for at least 3 nights with `verified ok` and the app banner is green | Settings, Backups |
| The restore drill was done on a second computer | `recovery.md`, last section |
| **The second owner has done the recovery rehearsal alone**, using only the printed recovery page | She follows `recovery.md` without help. Note every place she got stuck and fix the page |
| The old data is imported and `reconcile` says `RECONCILED` | `migration.md` |
| Alert channels work | Stop the backup job once and confirm the phone alert arrives |

## Who and what

- **Two to four people**: the two owners, plus one or two relatives (one an editor, one a viewer). Include **the oldest or slowest phone in the family** and one iPhone and one Android phone at least.
- Fill in the device table at the end of this page for each phone.
- Length: agree it with the owners; at least two weeks, so that it covers a full backup cycle, a weekend with many photos, and one trip with weak signal.

## What each tester does (30 minutes, once)

1. Open the invite link, create the account, **install to the home screen**, sign in.
2. Add an entry with text and a photo from the camera, and one with a video.
3. Turn on airplane mode, add an entry and a photo, turn it off, and check that both arrive.
4. Open an entry on two phones, edit it on both in airplane mode, reconnect: the "Two versions" screen should appear on the owner's phone, and neither text is lost.
5. Move an entry to the trash and restore it.
6. As the viewer: check there is nothing that edits, and that a trashed entry is not visible.
7. Owner: remove a member and check that person is signed out; use "Sign out everywhere" on a lost-phone scenario.
8. Owner: download the journal copy (Settings) and open a few entries from the monthly export folder.

## Measurements the app records (Settings, Pilot diagnostics)

Everything stays on the phone. At the end each person taps **Copy diagnostics** and sends the text to the owner.

**Start-up, 10 runs per scenario per phone** (the app records them itself):

- *Cold*: first launch after installing, or after clearing the site data in the browser settings. Then reopen it 10 times after clearing site data each time (or reinstall).
- *Warm*: close the app completely, then open it from the home screen; repeat 10 times.

Targets (from the architecture document): cold median 5 seconds or less; warm median 2 seconds and worst run 3 seconds or less; the first thumbnails of the first screen within 4 seconds. The report says "meets target" or "MISSES TARGET" per scenario and needs 10 runs to count.

**Uploads**: the app logs every upload attempt (size, outcome, connection type). Thresholds that decide whether **resumable uploads must be built**:

- more than 2 percent of files failing or restarting, over at least 10 files; or
- **any** file over 1 GB that fails or restarts on mobile data.

Test it on purpose, on each platform: upload a 1 GB video on mobile data; once more, switch to airplane mode halfway and back; once more, close the app halfway. If the report says "RESUMABLE UPLOADS ARE REQUIRED", that is a finding, not a failure of the pilot: it moves resumable uploads from "decide later" to "build".

## Go or no-go

| Criterion | Go if |
|---|---|
| Start-up | Targets met on every phone, including the oldest |
| Uploads | Thresholds not exceeded, or resumable uploads built and re-tested |
| Data safety | No lost entry or photo; every conflict resolvable; backup green throughout |
| Roles | Viewer cannot edit; removed member loses access at once |
| Recovery | The second owner restored access using only the recovery page |
| Usability | Every tester completed the 30 minute list without help; anything that needed help is fixed or written up |
| Migration | `reconcile` clean; family confirms nothing is missing |

Decide at the end of the pilot, with both owners, and write down the date and the decision.

## Cutover

1. Run the delta import (see `migration.md`, step 8) and `reconcile` again.
2. Tell the family the new address and give each person their invite.
3. Keep the old app **read-only** (not deleted) for at least a month and keep the last Firestore and Drive export with the recovery envelope.
4. After a month with a green backup, a clean monthly integrity check and no complaints, archive the old app.

## Results sheet (copy it for the report)

| Person | Phone and OS | Browser or installed | Cold median / worst | Warm median / worst | First thumbnails | 1 GB upload on mobile | Problems found |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

Feedback to ask each person: what was confusing, what felt slow, what they expected to find and did not, and whether they would use it without being asked.

## Not verified yet

All of it: nothing in this page has been done on real phones.
