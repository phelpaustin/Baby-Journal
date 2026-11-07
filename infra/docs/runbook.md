# Network and security runbook (architecture v7, build step 4)

This sets up: a small VPS that forwards encrypted traffic only, a WireGuard tunnel to the Mac mini, and Caddy on the Mac mini that ends TLS and serves the app. Nothing here has been run on real hardware yet; the configuration is tested against a local copy of the same chain (`infra/tests/run-all.sh`). Do the steps in order and run the checks at the end of each.

```
phone --TLS--> VPS :443 (HAProxy, raw TCP, no certificate) --WireGuard--> Mac mini
                                                       Caddy :8443 (PROXY protocol accepted from the VPS only)
                                                         --> PocketBase 127.0.0.1:8090
home network --TLS--> Caddy :443 (admin UI reachable here and over WireGuard only)
```

## 0. What you need

- A domain name you control (a subdomain is fine, for example `journal.yourdomain.se`).
- A small VPS (1 vCPU, 1 GB RAM is plenty) running Ubuntu 24.04 or Debian 12, with your SSH key on a non-root user that has sudo.
- The Mac mini, the external SSD, and no port forwarding on your router (the Mac dials out).
- On your own computer: `ansible-core`, `wireguard-tools`, and this repository.

## 1. Fill in the settings

1. Edit `infra/ansible/group_vars/all.yml`: `domain`, `acme_email`, `vps_public_ip`, `vps_admin_user`, and `mac_arch` (`arm64` for Apple Silicon).
2. Copy `inventory.example.yml` to `inventory.yml` and set the two addresses and users.
3. Generate keys and put them in the vault:

       cd infra/ansible
       wg genkey | tee /dev/stderr | wg pubkey      # run twice: once for the VPS, once for the Mac
       wg genpsk
       cp vault.example.yml vault.yml               # paste the keys in
       ansible-vault encrypt vault.yml

   Keep an offline copy of the vault password and of the keys (architecture section 8). Without them you cannot rebuild the tunnel.
4. Checksums for the Mac binaries: from the release pages, copy the SHA-256 of `pocketbase_0.40.6_darwin_<arch>.zip` and `caddy_2.11.8_mac_<arch>.tar.gz` into `pocketbase_sha256` and `caddy_sha256`. The download is refused if they do not match.

## 2. The VPS

    cd infra/ansible
    ansible-playbook -i inventory.yml vps.yml --ask-vault-pass

Then point the DNS **A record** of your domain at the VPS address.

Checks:

- `ssh` still works with your key, and password login is refused: `ssh -o PubkeyAuthentication=no deploy@<vps>` must fail.
- `sudo nft list ruleset` shows only 22, 443 and the WireGuard port open.
- `sudo wg show` lists the Mac as a peer (no handshake yet is normal).
- `sudo find / -name '*.pem' -o -name '*.key' 2>/dev/null` finds no certificate or TLS key. The VPS must hold none. (WireGuard keys live in `/etc/wireguard`.)

## 3. The Mac mini (once, by hand)

1. Create a **standard (non-admin) user** named `babyjournal` (System Settings, Users). Nobody signs in as it; it only runs the services.
2. Format the external SSD as APFS and name it `BabyJournal`. Then create the marker file the mount guard looks for:

       touch /Volumes/BabyJournal/.bj-volume-marker

3. Install helpers: `brew install wireguard-tools bash`.
4. System Settings: Energy, "Start up automatically after a power failure" on, and prevent automatic sleeping. (The play also sets this with `pmset`.)
5. **Decision, FileVault:** with FileVault on, the Mac waits at a password screen after every restart, so the journal stays down after a power cut until someone types the password. With it off, a stolen Mac exposes the internal disk (the journal data lives on the SSD, which you can encrypt separately, but an encrypted SSD also needs unlocking after a restart). Pick one and write it down; see "Decisions" below.

## 4. Deploy to the Mac

    cd client && npm install && npm run build && cd ..
    cd infra/ansible
    ansible-playbook -i inventory.yml macmini.yml --ask-vault-pass     # binaries, Caddy, WireGuard, services
    ansible-playbook -i inventory.yml deploy.yml  --ask-vault-pass     # backend code and the built app

Checks on the Mac:

- `sudo launchctl print system/com.babyjournal.pocketbase | head` and the same for `caddy` and `wireguard`: all running.
- `sudo wg show` shows a recent handshake with the VPS.
- From the VPS: `curl -k --resolve <domain>:443:127.0.0.1 -I https://<domain>/api/health` returns 200 (it travels the tunnel).

## 5. First owner

The admin page is reachable only from the home network or the tunnel. From a computer at home, either add `<mac-lan-ip> <domain>` to `/etc/hosts`, or use `curl --resolve`, then open `https://<domain>/_/`. Create the admin login, then the first user (registration is invite-only), as in the main README.

## 6. Acceptance checks (the step 4 gate)

Run these from a phone on **mobile data** (not your home Wi-Fi) unless stated.

| Check | Expected |
|---|---|
| Open `https://<domain>` | The app loads with a valid certificate issued by Let's Encrypt. |
| `https://<domain>/_/` | 404 (admin page hidden from the internet). Also `/api/settings` and `/api/logs`. |
| `https://<domain>/_/` from home Wi-Fi with the hosts override | The admin login appears. |
| Play a long video, drag the slider | It seeks without restarting. |
| Upload a 1 GB video on mobile data | Completes; the entry shows the video; the original's SHA-256 matches. |
| An outsider's token, and a removed member's token, for an original, a thumbnail and a poster | All refused. |
| `openssl s_client -connect <domain>:443 -servername <domain> </dev/null` from anywhere | The certificate chain is Let's Encrypt's, issued to your domain (proves TLS ends at home). |
| Stop `wg-quick` on the Mac | The site is unreachable; start it again and it recovers within about a minute with no action on the VPS. |
| Unplug the SSD | PocketBase stops on purpose and an alert is sent (if `alert_url` is set); plug it back and it restarts. |
| Pull the Mac's power, then restore it | It restarts by itself (note the FileVault decision). |

## 6b. Backups (step 5)

After the network works, set up the backup job: see `recovery.md`. In short: create the backup administrator (`pocketbase superuser create backup@journal.local <password>`), run `rclone config` as the service user for the offsite storage, set `restic_repository`, `healthcheck_url` and `alert_url` in `group_vars/all.yml`, add `vault_restic_password` and `vault_backup_pb_password` to the vault, run `macmini.yml` and `deploy.yml`, then run the first backup by hand and the restore drill before relying on it.

## 7. Drills worth doing once

- **VPS compromise.** Assume an attacker has root on the VPS. They can see connection times and addresses and can drop traffic, but hold no certificate and no data. Rebuild: new VPS, `vps.yml`, update the DNS record, and rotate the WireGuard keys (below).
- **Lost vault password.** You cannot decrypt the keys, but nothing else depends on it: generate new keys, re-encrypt, run both plays.

## 8. Rotating the WireGuard keys

1. Generate new key pairs and a new preshared key; update `vault.yml`.
2. Run `vps.yml`, then `macmini.yml`. There is about a minute of downtime while both ends restart.
3. Check `sudo wg show` on both ends.

## 9. Rolling back

- A bad release: re-run `deploy.yml` from the previous git tag. PocketBase applies migrations forward only, so restore the data from backup if a migration was the problem (build step 5).
- A bad network change: `ansible-playbook ... --check --diff` first. The play validates each config (`haproxy -c`, `nft -c`, `caddy validate`, `sshd -t`, `plutil -lint`) before installing it, so a typo cannot take the service down.

## Decisions to confirm

1. **FileVault** (section 3, step 5): availability after a power cut versus protection if the Mac is stolen.
2. **TLS-ALPN challenge only.** The VPS forwards port 443 only, so Caddy gets its certificate with the TLS-ALPN challenge (HTTP challenge is disabled). If issuance fails, switch to a DNS challenge (needs a Caddy build with your DNS provider's plugin).
3. **Home access goes through the tunnel by default.** At home, the name resolves to the VPS, so traffic leaves and returns. Add a local DNS entry (router or Pi-hole) pointing the name at the Mac's LAN address to keep it local and faster.
4. **Access logs** are kept 7 days on the Mac, with file tokens and credentials removed. The VPS keeps no request logs (it cannot see requests) and 7 days of system logs.
5. **No Caddy-level rate limiting.** PocketBase's own per-address limits do the work (sign-in 10 per minute); Caddy rate limiting needs a plugin build. Say if you want it.

## Not verified yet (needs real infrastructure)

- A real VPS, a real WireGuard tunnel across the internet and home CGNAT, and real Let's Encrypt issuance.
- The macOS side: launchd services starting at boot, `wg-quick` under launchd, the mount guard with a real unplugged SSD, `pmset` and the firewall commands. The templates are checked for syntax only.
- `sshd -t` on the hardening file (sshd is not installed in the test environment; Ansible runs it before installing the file).
- Behaviour on mobile networks and very slow uplinks (the tests use loopback).
- Keep-alive and long-upload behaviour across a home router that drops idle connections.
