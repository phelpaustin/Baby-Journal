# Migrating from the old app (architecture v7, build step 6)

The old app keeps text in Firestore and photos in Google Drive. The migration has three tools and one rule: **it can be run again at any time and never overwrites anything**, so an interrupted import is simply started again, and a second import later brings over only what was added to the old app since.

    old app (Firestore + Drive) --export--> firestore.json + drive-downloads/
        bj_firestore_adapter.py  -->  bundle/           (a plain folder, documented below)
        bj_import.py check       -->  nothing is touched; reports every problem
        bj_import.py run         -->  the new journal
        bj_import.py reconcile   -->  proof: counts, every field, every file checksum

## What I need from you to finish the mapping

I could not see the old app's data, so `ops/import-mapping.example.json` uses guessed field names. The tools are tested on a synthetic export with the awkward cases real data has (four timestamp shapes, a time that is the next day in Stockholm, grams to kilograms, an unknown category, an author with no account, a trashed entry, a video, a missing Drive file). To make it fit your data, send me:

1. Two or three real Firestore documents with the text made up (one entry with a photo, one with a measurement, one in the trash), and the **collection names**.
2. A list of the people in the old app (their ids, names and e-mail addresses are enough) and which of them have a Google account that will exist in the new one.
3. How photos are referenced: a Drive file id, a file name, or a link, and whether the file names are unique.
4. The categories and tags the old app uses, so they can be mapped to the new entry types and milestones.

Then only `import-mapping.json` changes.

## Step by step

1. **Back up the new server first** (`bj_backup.py backup`). That is the rollback: if anything looks wrong, restore it (see `recovery.md`).
2. **Export Firestore** to one JSON file with one array per collection, each document including its id (a short script with the Firebase Admin SDK, or the console export converted to JSON). Keep the **timestamps as they are**; the adapter understands `{_seconds}`, `{seconds}`, milliseconds, seconds and ISO text.
3. **Download the Drive photos and videos** into `drive-downloads/`, named by Drive file id (or by name, see `drive_file` in the mapping). Do not edit them.
4. **Create the accounts** the entries will be attributed to (invite your wife; she signs up and gets the editor or owner role), so that people can be matched by e-mail address.
5. Convert and check:

       python3 ops/bj_firestore_adapter.py --export firestore.json --mapping import-mapping.json --out bundle/
       python3 ops/bj_import.py check bundle/

   The adapter prints a warning for everything it could not map and never drops an entry. `check` stops on a bad date, an unknown type, a measurement without a unit, a missing or damaged file, or an entry that refers to a photo that is not there.
6. Practise on a **copy** of the new server (the restore drill gives you one), then run for real:

       export BJ_PB_URL=http://127.0.0.1:8090 BJ_PB_SUPERUSER=backup@journal.local BJ_PB_PASSWORD=...
       export BJ_IMPORT_USER=you@example.com BJ_IMPORT_PASSWORD=...
       python3 ops/bj_import.py run bundle/ --journal-name "Ophelia Mikyla" --default-author you@example.com --add-members --create-journal

7. Prove it:

       python3 ops/bj_import.py reconcile bundle/ --journal-name "Ophelia Mikyla" --default-author you@example.com

   `RECONCILED` means: every entry is on the server with the same date, type, title, text, milestones, measurements, author and written-on time; every photo and video is stored with the same SHA-256 and size as the file you downloaded; nothing is attached to the wrong entry. The files that were missing from the Drive download are listed as known gaps. Any mismatch is listed and the exit code is 1.
8. **Cut over.** Freeze the old app (ask everyone to stop adding things), export and download once more, run steps 5 to 7 again (only the new entries and files are added), then switch the family to the new address.

## What the import does and does not do

- Each entry keeps its **original author and its original written-on time**, so the timeline order and "who wrote this" are right.
- The date of the event comes from the old entry's date, converted to a calendar day in the time zone in the mapping (Europe/Stockholm by default), so a 23:30 UTC entry is on the right day.
- Photos keep their original file name, caption and capture time; the server makes its own viewer copies and strips location data from them, as for any upload.
- An entry that was in the old app's trash is imported into the new trash.
- Measurements need a unit in their name (`weight_kg`). The mapping can scale (grams to kilograms).
- **A repeat run never changes an existing entry.** If you correct an entry on the server and then run `reconcile`, it still reports the difference from the old data until you decide which one is right.
- Comments, reactions and the old app's sharing settings are not imported. People are given access in the new app by invitation.
- Authors with no account are attributed to the `--default-author`, never silently to nobody. `--add-members` makes matched authors editors of the new journal; change roles afterwards in the app.

## The bundle format (format 1)

    bundle/bundle.json      {"format":1, "journal":{name,emoji,dob,due_date}, "people":[{source_id,name,email}], "counts":{...}, "warnings":[...]}
    bundle/entries.jsonl    one JSON object per line: source_id, author_source_id, event_date (YYYY-MM-DD), type, title, text,
                            milestones [..], values {weight_kg: 6.2}, created, updated, deleted_at (ISO times)
    bundle/media.jsonl      source_id, entry_source_id, path (under bundle/media/), original_name, caption, taken_at, sha256, size, kind_hint
                            (a line with "missing": true records a file that was not in the Drive download)
    bundle/media/...        the files, renamed to a stable id

Anything that can produce this folder can be imported, so a different old source only needs a different adapter.

## Not verified yet

- Real Firestore data and a real Drive download: the mapping is a template until you send the samples above.
- Speed and memory with a real library (the importer streams files from disk, so size is not a memory problem, but time is: it uploads one file at a time).
