---
name: local-demo
description: Set up and run Compliance Sentinel locally for a demo. Covers prerequisites, install, .env, audit run, digest run, golden eval, real-repo audit, web server, and dashboard. Use when the user asks to run the demo, set up locally, show the report, score results, or start the app.
---

# Local Demo Setup and Run

## Autonomous run

When invoked, execute the following steps in order without asking the user anything. Make decisions at each gate and keep going. Print a one-line status after each step. At the end, print a summary table.

### Gate 0 — Prerequisites
```bash
node --version
pnpm --version
```
- If node < 22: stop, print `BLOCKED: Node >= 22 required (found <version>). Install from https://nodejs.org`.
- If pnpm missing: stop, print `BLOCKED: pnpm not found. Run: npm install -g pnpm@9`.
- Otherwise: continue.

### Gate 1 — Install
Check whether `node_modules` exists in the project root.
- If missing or `package.json` is newer than `node_modules`: run `pnpm install`.
- If already current: skip and note "dependencies already installed".

### Gate 2 — Environment
Check whether `.env` exists in the project root.
- If missing: run `cp .env.example .env` (or `Copy-Item .env.example .env` on Windows PowerShell). Note "created .env from .env.example".
- If present: note "using existing .env".
- Do NOT read or print `.env` contents — it may contain secrets.
- Note whether `ANTHROPIC_API_KEY` appears to be set by checking `node_modules` is present and the audit step will reveal it via the analyst name in output (`claude` vs `offline`).

### Gate 3 — Demo audit
```bash
pnpm audit:run --demo
```
Parse stdout for the summary block:
- `rules in scope`, `obligations`, `violations`, `needs review`, `compliant`, `model cost`, `report` path.
- If the command exits non-zero or prints an error: print the last 10 lines of output, note the failure, then continue to Gate 4 anyway.

### Gate 4 — Golden eval
```bash
pnpm eval:golden
```
Parse stdout for:
- Per-violation FOUND/MISSED lines.
- `recall`, `precision` (both lines), `confirmed real gaps`, `compliant areas wrongly flagged`, `model cost`.
- If the command exits with code 2 (extraction failure): print the error and skip scoring.
- Exit code 1 (misses or false flags) is expected on the offline baseline — note it but do not treat as a hard failure.

### End — Summary report
Print a markdown table:

```
## Local demo results

| Step | Result |
|---|---|
| Node / pnpm | vX.X.X / vX.X.X |
| Analyst | claude (ANTHROPIC_API_KEY set) OR offline (keyword baseline) |
| Audit run | N violations (Y critical, Z high) · $X.XX · reports/run-N.html |
| Golden eval | recall X% · precision Y% (Z% with confirmed gaps) · $X.XX |
| Report | <absolute path to reports/run-N.html> — open in browser |
```

If any gate failed, replace that row with `FAILED: <reason>`.

Do not start the web server or dashboard unless the user explicitly asked for it.

---

## What this skill does

Guides you through running Compliance Sentinel locally end-to-end — from a fresh clone to a cited HTML report — using only the embedded database and no cloud services. No Neon, no Redis, no API keys required for the offline demo.

---

## Step 0 — Check prerequisites

Run these checks first. Fix any failures before proceeding.

```bash
node --version   # must be >= 22
pnpm --version   # must be installed; npm install -g pnpm@9 if missing
```

If Playwright sources are needed (EUR-Lex or MAS):
```bash
npx playwright install chromium
```
Not needed for the offline demo — `--demo` uses bundled fixture rules only.

---

## Step 1 — Install

```bash
pnpm install
```

---

## Step 2 — Environment

```bash
cp .env.example .env
```

For the offline demo **no edits are needed**. The defaults give you:
- Embedded PGlite database under `.data/` (no Neon required)
- Offline keyword analyst instead of Claude (no `ANTHROPIC_API_KEY` required)
- Local hash embedder instead of Voyage (no `VOYAGE_API_KEY` required)

Optional additions for a richer demo:

| Var | What it enables |
|---|---|
| `ANTHROPIC_API_KEY` | Real Claude findings instead of keyword baseline |
| `VOYAGE_API_KEY` | Legal-tuned embeddings (`voyage-law-2`) |
| `SLACK_WEBHOOK_URL` | Live Slack alert on critical findings |
| `AGENTMAIL_API_KEY` + `AGENTMAIL_INBOX_ID` + `ALERT_EMAIL_TO` | Live email alert + two-way inbox |

---

## Step 3 — Run the demo audit

```bash
pnpm audit:run --demo
```

This forces the five bundled demo rules (GDPR, FTC Safeguards, SEC Reg S-P, FCA PS21/3, MAS Notice 655) through the full pipeline against `demo-target-app/` which has planted violations. No scraping, no network calls.

Expected output:
```
Run N completed
  rules in scope : 5
  obligations    : ~35
  violations     : X (critical Y, high Z, ...)
  report         : reports/run-N.html
```

Open `reports/run-N.html` in a browser to see the full cited report.

---

## Step 4 — Run the digest demo

```bash
pnpm digest:run --demo
```

Shows the weekly digest output mode: each demo rule gets a plain-language summary (what it requires, who it applies to, key obligations). No code audit.

---

## Step 5 — Score the run (golden eval)

```bash
pnpm eval:golden
```

Runs the five demo rules against `demo-target-app/` in an isolated in-memory database and scores results against five deliberately planted violations. Saves a timestamped JSON to `reports/eval/` for trend comparison.

Expected output:
```
Golden audit (5 planted violations)
  FOUND   pii-in-logs: Personal data written to application logs
  FOUND   no-retention-job: No data-retention or disposal job
  FOUND   plaintext-secrets: Credentials and secrets in plaintext
  FOUND   missing-consent: Marketing opt-in assumed without consent capture
  FOUND   no-breach-notification: Incident intake has no breach-notification step

  recall    : 100% (5/5)
  precision : XX% of reported violations match a planted one
  precision : XX% match a planted violation or a confirmed real gap
  confirmed real gaps found: no-mfa, no-consent-withdrawal, no-activity-audit-log, ...
  compliant areas wrongly flagged: none
  model cost: $X.XXXX
  result    : reports/eval/golden-<timestamp>-claude.json
```

**Scoring dimensions:**
- **Recall** — fraction of the 5 planted violations found (FOUND vs MISSED)
- **Precision (strict)** — fraction of reported violations that match a planted violation
- **Precision (with confirmed gaps)** — fraction matching a planted violation OR a confirmed real gap (4 real gaps were discovered in Claude runs on 2026-10-27 and confirmed by code review: `no-mfa`, `no-consent-withdrawal`, `no-activity-audit-log`, `no-retention-job-at-registration`)
- **Falsely flagged** — compliant areas (TLS enforcement, access control) incorrectly reported as violations

Exit code 0 = all planted found and no compliant areas flagged; exit code 1 = misses or false flags.

---

## Step 6 — Audit real public repositories

```bash
pnpm audit:real
```

Audits three real open-source repositories at pinned commits using the bundled demo rules. Requires `ANTHROPIC_API_KEY` (refuses to run offline by default to prevent publishing meaningless results).

**Repos in `samples/real/repos.json`:**

| Repo | Why |
|---|---|
| ghostfolio/ghostfolio | TypeScript personal-finance app; holds account + transaction data |
| juice-shop/juice-shop | Deliberately insecure TypeScript shop; must produce findings |
| maybe-finance/maybe | Rails personal-finance app; tests Ruby coverage |

**Per-repo output** written to `samples/real/<owner>__<name>/`:
- `summary.json` — run metadata, costs, obligations count, findings summary
- `labels.json` — every non-compliant finding with a `label` field (null until reviewed by hand: set to `"true_positive"`, `"false_positive"`, `"useful"` or `"noise"`)
- `report.html` — full cited HTML report (same format as the demo run)

**Flags:**
```bash
pnpm audit:real --only juice-shop/juice-shop   # single repo
pnpm audit:real --allow-offline                # run offline baseline (output goes to reports/real-offline/)
```

The offline guard exists because offline keyword results on real code are not meaningful for product evaluation.

---

## Step 7 — Web server (optional, for dashboard demo)

Three processes in separate terminals:

**Terminal 1 — API server**
```bash
pnpm dev:web
# Hono server on http://localhost:8080
# GET /health, GET /runs, GET /runs/:id/findings, GET /rules, GET /stats
```

**Terminal 2 — Dashboard**
```bash
cd web
pnpm install          # first time only
cp .env.example .env.local
# Set SENTINEL_API_URL=http://localhost:8080
# Set SENTINEL_API_TOKEN= (match RUN_TRIGGER_TOKEN in root .env, or leave blank for dev)
pnpm dev
# Next.js dashboard on http://localhost:3000
```

The dashboard pages:
- `/` — landing page with sample finding
- `/overview` — latest run summary + Run Audit button
- `/runs` — run history
- `/runs/[id]` — findings with verdict and severity filters
- `/rules` — all tracked regulations

**Terminal 3 — Queue worker (only needed for the Run Audit button)**
```bash
docker compose up -d   # local Redis on :6379
pnpm dev:worker
```

Without the worker, `POST /runs` returns 200 but the job never executes. For a demo, trigger the audit from the CLI (`pnpm audit:run --demo`) and just show the dashboard read-only.

---

## Common issues

| Symptom | Fix |
|---|---|
| `pnpm: command not found` | `npm install -g pnpm@9` |
| `Cannot find module 'playwright'` | `npx playwright install chromium` |
| `pdftotext: command not found` when `SCRAPE_MAS=true` | Install poppler-utils: `apt-get install poppler-utils` (Linux) or `brew install poppler` (Mac) |
| Dashboard shows "no runs" | Run `pnpm audit:run --demo` first; the dashboard reads from the same `.data/pglite` store |
| Report not opening | `reports/run-N.html` is a local file — open it directly in a browser, or set `PUBLIC_BASE_URL=http://localhost:8080` and use the `/reports/:id` redirect |
| `SCRAPE_EURLEX` fails | Set `SCRAPE_EURLEX=false` in `.env` to skip the browser-based source; `--demo` skips all scraping anyway |
| `audit:real` refuses to run | `ANTHROPIC_API_KEY` is not set — set it, or pass `--allow-offline` to exercise the plumbing only |
| `audit:real` — single repo | Pass `--only owner/name`, e.g. `--only juice-shop/juice-shop` |

---

## Quick reference — all demo commands

```bash
pnpm audit:run --demo          # full audit on bundled rules, no network
pnpm digest:run --demo         # digest mode on bundled rules
pnpm eval:golden               # precision/recall against 5 planted violations
pnpm audit:real                # audit 3 real public repos (requires ANTHROPIC_API_KEY)
pnpm audit:real --only juice-shop/juice-shop  # single real repo
pnpm dev:web                   # API server on :8080
pnpm dev:dashboard             # Next.js dashboard on :3000
pnpm test                      # unit tests (all offline)
```
