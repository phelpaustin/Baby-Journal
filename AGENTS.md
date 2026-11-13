# AGENTS.md — Token Optimization & Agent Guidelines

## Context & Project Summary
Baby Journal is a self-hosted family archive:
- Backend: PocketBase 0.40.6 (Go/JS hooks in `backend/pb_hooks/`, migrations in `backend/pb_migrations/`).
- Client: React 19 + Vite PWA (`client/src/`). Plain JS, offline-first via IndexedDB outbox queue (`client/src/lib/sync.js`).
- Ops: Python 3 stdlib scripts (`ops/bj_backup.py`, `bj_monitor.py`, `bj_import.py`, `bj_export.py`).
- Infra: Ansible (`infra/ansible/`) for VPS (HAProxy TCP passthrough) and Mac mini (Caddy with TLS-ALPN).

## Token-Saving Rules (Strict)

### 1. File Inspection & Reading
- **Never cat or read whole files** when inspecting code. Use targeted line ranges:
  - In tools: specify `StartLine` and `EndLine`.
  - In shell: use `grep -n`, `head -n`, `tail -n`, or `sed -n 'X,Yp'`.
- **Do not read the 70 KB architecture spec or full README** on routine turns. Consult `CLAUDE.md` or this file first.
- Check changes with `git diff --stat` or `git status -s` before checking full diffs.

### 2. Tool Outputs & Logs
- **Do not dump raw logs to stdout**: Test runners output verbose traces. 
  - Direct logs to files (e.g. `/tmp/bj-check/*.log`).
  - Read only failing lines with `grep -E 'FAIL|Error|x '` or `tail -n 25`.
- Avoid recursive directory walks without depth bounds:
  - Prefer `find dir -maxdepth 2` or `ls -la dir`.

### 3. Execution & Testing
- **Targeted testing only**: Run only the suite touching modified code:
  - Backend: `npm test` inside `backend/` or `./scripts/check.sh backend`
  - Client: `npm test` inside `client/` or `./scripts/check.sh client`
  - Infra: `./scripts/check.sh infra`
  - Ops: `./scripts/check.sh ops "<group>"` (e.g. `ops "restore"`)
- Run full checks (`./scripts/check.sh`) only before final delivery.

### 4. Response Conciseness
- Provide brief status reports (3–6 bullet points):
  1. What was inspected / changed
  2. Verification status (tests passed)
  3. Edge cases or decisions requiring user confirmation
- Do not repeat file contents back in conversational replies.

## Architecture Critical Invariants
- **Viewer isolation**: Raw uploads live in `media_originals`; viewers only access `media` (stripped derivatives).
- **All mutations go through `/api/bj/*`**: PocketBase direct collection writes are disabled.
- **Idempotent sync**: Sync requests use client IDs and base revisions; conflicting writes become conflict rows.
- **Hook scoping**: PocketBase JS handlers run in isolated scopes; always `require(`${__hooks}/lib.js`)` inside handlers.
