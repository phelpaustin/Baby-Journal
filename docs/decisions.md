# Decision log

One line per decision: what, why, what was rejected, and who has confirmed it. "Awaiting you" means it was built with a sensible default and needs the owners' yes or no. Add a line whenever something is decided, and review this page every year.

| # | Decision | Why | Rejected | Status |
|---|---|---|---|---|
| 1 | PocketBase 0.40.6 (pinned) as the only server | One binary, SQLite, rules and routes in one place; easy to back up and restore | Firebase (the old stack), a Postgres service | Decided in the architecture |
| 2 | All writes go through `/api/bj/*` routes; collections are read-only to clients | Atomic, idempotent, last-owner-safe rules cannot be expressed as collection rules | Direct collection writes | Built, tested |
| 3 | Originals live in their own collection (`media_originals`) | PocketBase lets anyone who can read a record fetch all its files; a separate collection is what keeps viewers away from originals | One `media` table | Awaiting you |
| 4 | The server makes its own display, poster and playback copies and ignores the client's | A viewer's privacy must not depend on the client; every derived file is checked for GPS and device tags | Trusting client-made previews | Awaiting you |
| 5 | Registration is closed: an account exists only through an invite | Nothing to attack or spam; invites are single-use, 7 days | Open sign-up | Awaiting you |
| 6 | Journal creation only for the first user and existing owners | Invited family cannot create journals and use storage | Anyone may create | Awaiting you |
| 7 | Entry text is plain text, shown with line breaks, never as HTML | Rendering other people's HTML is a risk with no benefit yet | Rich text now | Awaiting you |
| 8 | Password sign-in only; no e-mail reset; recovery by command line | No mail relay to run; two owners can always reset | Google sign-in, e-mail links | Awaiting you |
| 9 | File tokens last 1 hour, sign-in 30 days | The 2-minute default breaks video seeking; removal revokes tokens at once anyway | Defaults | Awaiting you |
| 10 | TLS passthrough on the VPS with PROXY protocol | The VPS holds no certificate and no data; Caddy sees the real client address | TLS at the VPS; plain forwarding | Decided in the architecture, tested |
| 11 | Admin UI and superuser API reachable only from home and the tunnel | The internet sees only the app's API | Public admin login | Built, tested |
| 12 | Certificate by the TLS-ALPN challenge only | Only port 443 reaches the Mac | HTTP challenge; DNS challenge (needs a plugin build) | Awaiting you; switch if issuance fails |
| 13 | No Caddy-level rate limiting; PocketBase's per-address limits do the work | A plugin build for little gain | A rate-limit plugin | Awaiting you |
| 14 | FileVault on the Mac | Trade-off: protection if stolen versus staying down after a power cut | | **Open**: owner to decide |
| 15 | Backup: restic, one run per night, verified before anything is marked protected | A failed or killed run must protect nothing | Marking on upload | Built, tested |
| 16 | Preview copies are not in the offsite backup (they are re-made after a restore) | Halves the repository | Back everything up | Awaiting you (`backup_include_derived`) |
| 17 | Nightly verification samples files; the monthly check re-hashes 5 %; a restore re-hashes everything | A full nightly re-hash does not scale | Full re-hash every night | Awaiting you |
| 18 | Trash is purged after 30 days only if a verified backup holds it; dry run until switched on | A deletion must never be the only copy | Immediate delete | Built; **switch-on is open** |
| 19 | The offsite repository is Google Drive via rclone | Already available; not append-only, so mitigations are written down | An append-only store | Awaiting you |
| 20 | Retention pruning runs from a second machine | Pruning needs delete rights the backup machine should not hold | Prune from the Mac | Awaiting you |
| 21 | Alert channels | Must not depend on the Mac or the VPS | | **Open**: choose `alert_url` and `healthcheck_url` |
| 22 | Migration keeps original author and written-on time; a repeat import never overwrites | Re-runs are safe; reconcile proves the result | Import as the importing user | Built; the real field mapping needs sample data |
| 23 | Resumable uploads are not built; the pilot decides | Thresholds: over 2 % failing or restarting, or any file over 1 GB failing on mobile data | Build now | Open until the pilot |
| 24 | Pilot length and people | At least two weeks, owners plus one editor and one viewer, oldest phone included | | **Open**: owner to confirm |
| 25 | Caddy upgrade to 2.11.9 | Passes all 35 network tests | Stay on 2.11.8 | **Open**: owner to decide |
| 26 | The monitor runs as root with its own state folder | `wg show` needs root; separate folder keeps the backup's files owned by its own user | Run as the service user | Awaiting you |
