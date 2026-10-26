# Compliance Sentinel Agent — Build Plan

**Portfolio P1 · Week 5 deliverable · Agentic System**

One-liner: a LangGraph agent scrapes regulatory portals daily, embeds new rules into a Legal RAG store, audits a target codebase against them, and emits an audit-ready PDF report with citations plus Slack/email alerts for critical findings. Runs as a BullMQ cron worker on Fly.io. Shipped as a public GitHub repo plus a Loom demo.

> Revised 2026-10-26 to match what shipped. The original plan covered two sources, a Resend email alert and a bare API. The build grew to eight sources, a two-way AgentMail inbox, a Next.js dashboard and a weekly digest; the sections below describe that state. The README's "Where the build differs from the plan" section lists the smaller implementation deviations.

---

## 1. Scope and definition of done

**In scope (must ship)**

1. Daily scrape of eight regulatory sources with change detection (new or amended rules only): Federal Register, SEC, FINRA, FCA, ESMA, ASIC, EUR-Lex and MAS (MAS off by default, `SCRAPE_MAS=true`). Each source has its own `SCRAPE_*` switch.
2. Legal RAG store: chunked regulation text with embeddings in Postgres + pgvector.
3. LangGraph audit graph that maps obligations in new rules to evidence in a target codebase.
4. PDF report (WeasyPrint) with findings, severity, regulation citations, and `file:line` code citations.
5. Slack webhook + email alert when any finding is `critical`. Email goes out from the app's own AgentMail inbox, and a reply of "run audit" to that inbox queues a run.
6. BullMQ repeatable jobs (cron) on Fly.io: the daily audit, a weekly "what changed" digest, plus an on-demand trigger for demos.
7. Public GitHub repo with README, architecture diagram, `.env.example`, Dockerfile, `fly.toml`, and a sample report committed.
8. Next.js dashboard (Clerk sign-in) on Vercel: overview, runs, findings per run, tracked rules, and a **Run audit** button.
9. Loom demo (3–5 min).

**Out of scope (say so in README)**

- Legal advice or guaranteed coverage. The report is decision support, not a legal opinion.
- Auto-remediation of code. The agent reports; it does not open PRs (stretch goal only).
- Multi-tenant SaaS. One target repository; every signed-in dashboard user sees every run, there are no roles.

**Definition of done**: a fresh clone + `fly deploy` + one manual trigger produces a PDF with at least 3 correct findings against the seeded demo repo, and the critical alert lands in Slack. Cron fires on schedule in Fly logs.

---

## 2. Key decisions (made now so the build does not stall)

| Decision | Choice | Why |
|---|---|---|
| Language | TypeScript end to end (LangGraph.js, Playwright, BullMQ, `pg`) | BullMQ and Playwright are first-class in Node; matches your existing Next.js work. |
| PDF | WeasyPrint CLI invoked via `child_process` inside the same Docker image | Avoids a second Fly service. Python + Pango/Cairo deps go in the Dockerfile. |
| LLM | Claude via the Anthropic SDK. `claude-sonnet-5-5` for extraction and assessment, `claude-haiku-5-5` for cheap classification/dedupe | Cost-aware; structured outputs via tool use with Zod schemas. |
| Embeddings | Voyage `voyage-law-2` (legal-tuned) with a fallback to a general model | Legal text retrieval quality matters more than anything else here. |
| Database | Neon Postgres with `pgvector`, schema via Drizzle | One DB for rules, chunks, audit runs, findings, and the LangGraph checkpointer. |
| Queue | BullMQ on Upstash Redis (Fly Redis). `maxmemory-policy=noeviction` | Repeatable jobs with cron + retries + backoff out of the box. |
| Regulatory sources | Six over plain HTTP: **Federal Register** (JSON API), **SEC** (the same API filtered to the SEC agency), **FINRA** notices (RSS + page text), **FCA** publications (RSS + page text), **ESMA** news (site-wide RSS), **ASIC** regulatory tracker (server-rendered table, guide PDFs via pdftotext). Two with Playwright: **EUR-Lex** (GDPR and its amending acts, JS-rendered) and **MAS** circulars (JS listing behind a WAF, PDFs via pdftotext; off by default). | The API and RSS sources keep the pipeline reliable; the Playwright sources cover portals that only render in a browser. Each source is isolated, so one failing is logged and skipped. |
| Email | **AgentMail**: the app owns an inbox, sends alerts from it with the PDF attached, and receives replies through a Svix-signed webhook (`POST /inbox/agentmail`). "run audit" from an alert recipient queues a run. | Two-way mail with no extra service; replaced the Resend one-way plan. |
| Dashboard | **Next.js 16 App Router + Clerk** in `web/`, deployed to Vercel with Root Directory `web`. Server components call the Hono API with the token; the browser never sees it. | Separate app and lockfile so the API image and CI are unaffected. |
| Target codebase | A seeded fixture repo `demo-target-app/` with planted violations (PII in logs, no data-retention job, plaintext secrets, missing consent capture, no breach-notification hook) | Makes the Loom demo deterministic and the findings verifiable. |
| Report storage | Fly Tigris (S3-compatible) bucket; local `./reports` in dev | Signed download link in the Slack alert. |
| Audit trigger | Only when the diff step finds new rule content (content hash changed) | Keeps daily LLM cost near zero on quiet days. |

---

## 3. Architecture

```
            +---------------- BullMQ cron (daily 06:00 UTC) ----------------+
            |                                                                |
  FedReg, SEC, FINRA, FCA, ESMA, ASIC (HTTP) + EUR-Lex, MAS (Playwright)     |
            |                                                                |
            v                                                                |
   [1] scrape --> [2] diff (content hash) --> new rules? --no--> log + exit  |
                                                | yes                        |
                                                v                            |
                                 [3] chunk + embed --> Postgres/pgvector     |
                                                |                            |
                                                v                            |
                     +------------ LangGraph audit graph ------------+       |
                     | extract_obligations                           |       |
                     |   +-> Send() per obligation (parallel)        |       |
                     |        retrieve_code_evidence (code RAG+grep) |       |
                     |        assess (compliant | violation | review)|       |
                     |        verify_citations (chunks + file:line)  |       |
                     | aggregate -> severity_gate                    |       |
                     +-----------------------------------------------+       |
                                                |                            |
                              +-----------------+-----------------+          |
                              v                                   v          |
                 [4] render_report (HTML -> WeasyPrint)   [5] notify (Slack/email
                      upload to Tigris                     if any critical)   |
```

The graph has a second output mode, `digest`: `START -> digest_rules` writes a plain-language digest per rule version (summary, what changed, effective date, who it applies to, key obligations) and audits no code. The weekly digest job reuses those digests and sends one round-up by email and Slack.

**Services on Fly.io** (one app, two process groups):

- `web`: Hono server. `GET /health`, `POST /runs` (manual trigger, token-protected), `GET /runs`, `GET /runs/:id`, `GET /runs/:id/findings`, `GET /rules`, `GET /stats`, `GET /reports/:id` (signed redirect), `POST /inbox/agentmail` (Svix-signed webhook, no token). Fly machines can autostop.
- `worker`: BullMQ worker + scheduler registration for the daily audit (`AUDIT_CRON`, 06:00 UTC) and the weekly digest (`DIGEST_CRON`, Monday 07:00 UTC). Always on, 1 machine.

**Dashboard on Vercel**: the Next.js app in `web/` reads the API above with `SENTINEL_API_TOKEN` and signs users in with Clerk. Pages: `/` (public landing), `/overview`, `/runs`, `/runs/[id]`, `/rules`.

---

## 4. Data model (Drizzle, Postgres)

- `sources` — id, name, kind (`api` | `playwright` | `fixture`), url, last_checked_at.
- `rules` — id, source_id, external_id, title, effective_date, url, content_hash, raw_text, previous_raw_text (so a digest can say what changed), first_seen_at, last_changed_at.
- `rule_digests` — id, rule_id, content_hash, kind (`new` | `amended`), digest jsonb, analyst, cost_usd, created_at. One row per rule version.
- `rule_chunks` — id, rule_id, ordinal, section_ref, text, embedding `vector(1024)`, metadata jsonb. HNSW index.
- `code_chunks` — id, repo, path, start_line, end_line, text, embedding. Re-indexed when repo commit SHA changes.
- `audit_runs` — id, started_at, finished_at, status, trigger (`cron` | `manual`), rules_in_scope int[], report_url, cost_usd, error, note.
- `findings` — id, run_id, rule_id, obligation, status (`compliant` | `violation` | `needs_review`), severity (`critical` | `high` | `medium` | `low`), evidence jsonb (`{path, start_line, end_line, excerpt}[]`), citation_chunk_ids int[], rationale.
- LangGraph `PostgresSaver` tables for checkpoints.

---

## 5. LangGraph graph design

State (Zod/Annotation): `runId`, `newRules[]`, `obligations[]`, `findings[]`, `errors[]`, `costUsd`.

Nodes:

1. **extract_obligations** — for each new rule, Claude extracts structured obligations: `{obligation, applies_to, technical_controls[], source_chunk_ids[]}`. Tool-use with a strict schema; reject any output whose `source_chunk_ids` are not in the retrieved set.
2. **fan_out** — `Send("assess_obligation", obligation)` for parallelism with a concurrency cap.
3. **retrieve_code_evidence** — hybrid: pgvector similarity on `code_chunks` + ripgrep for keyword hits derived from `technical_controls` (e.g. `console.log`, `password`, `retention`, `consent`). Returns top-k evidence with `file:line`.
4. **assess** — Claude judges each obligation against evidence → status, severity, rationale, evidence refs. Must cite at least one chunk and one code location or return `needs_review`.
5. **verify_citations** — deterministic: confirm every cited chunk id exists and every `file:line` range exists in the indexed repo at the audited SHA. Drop or downgrade anything that fails.
6. **aggregate** — merge, dedupe findings by (rule, path), compute summary counts.
7. **severity_gate** — conditional edge: any `critical` → `notify` branch after render.
8. **render_report** — Handlebars/EJS HTML → WeasyPrint → PDF → Tigris upload.
9. **notify** — Slack Block Kit message + AgentMail email (PDF attached) with summary and signed link.
10. **digest_rules** — the `digest` output mode: one plain-language digest per rule version, stored in `rule_digests`, no retrieval and no code audit. Reached from `START` instead of `extract_obligations` when the run is started with `mode: "digest"`.

Guardrails: per-run cost cap (`MAX_RUN_COST_USD`); retries with backoff per node; graph state checkpointed to Postgres after each step. Resuming a crashed run from its checkpoint is not wired up: a retry starts a fresh run. `interrupt_before` hook left in place for an optional human review stage (not wired in v1).

---

## 6. Build sequence (6 days + 1 buffer)

**Day 1 — Scaffold, DB, sources**
- `pnpm init`, TS, ESLint, Vitest. Folders: `src/scrape`, `src/rag`, `src/graph`, `src/report`, `src/queue`, `src/web`, `demo-target-app/`.
- Neon Postgres (pgvector) for the database, Docker Compose for Redis. Drizzle schema + migrations.
- Federal Register client (search by agency/topic, pull full text). Playwright scraper for EUR-Lex page with retry + screenshot-on-failure.
- Content-hash diff; persist `rules`. Unit tests on diff logic with fixtures.

**Day 2 — Legal RAG**
- Section-aware chunker (split on article/section headings, 800–1200 tokens, 10% overlap, keep `section_ref`).
- Embedding client with batching and a local cache keyed by hash.
- `retrieveRuleChunks(query, k)` and `retrieveCodeChunks(query, k)` with cosine distance; eval script that prints top-k for 10 hand-written queries.
- Index `demo-target-app/` into `code_chunks`.

**Day 3 — LangGraph agent**
- Implement nodes 1–7. Structured outputs via Anthropic tool use + Zod.
- `PostgresSaver` checkpointer. CLI: `pnpm audit:run --rules <ids>` to run the graph locally against the demo repo.
- Golden test: 5 seeded violations must be found; 2 compliant areas must not be flagged. Record precision/recall in README.

**Day 4 — Report + alerts**
- HTML template: cover, executive summary table, findings grouped by severity, each with regulation citation (title, section, URL, effective date) and code evidence block, appendix of rules in scope, methodology + disclaimer page.
- WeasyPrint render; page numbers, headers; verify with `pdftoppm` snapshot.
- Slack webhook + email (planned as Resend, shipped as AgentMail); dry-run mode when env vars are missing.

**Day 5 — Queue + Fly.io**
- BullMQ queue `compliance`, repeatable job `daily-audit` (cron `0 6 * * *`), job `manual-audit`. Worker with concurrency 1, exponential backoff, dead-letter logging.
- Dockerfile: `node:22-slim` + `python3`, `weasyprint`, `libpango`, `libcairo`, Playwright Chromium deps. Multi-stage.
- `fly.toml` with `web` and `worker` process groups, Neon Postgres, Upstash Redis, Tigris bucket, secrets via `fly secrets set`.
- Deploy, trigger `POST /runs`, confirm PDF + Slack alert end to end.

**Day 6 — Polish and demo**
- README: problem, architecture diagram (Mermaid), how it works, setup in 5 commands, sample report link, eval numbers, cost per run, limitations.
- Commit `samples/report-example.pdf`.
- Loom script (below). Record. Add link to README and portfolio page.

**Day 7 — Buffer** for Fly/WeasyPrint dependency issues and scraper flakiness.

---

## 7. Loom demo script (3–5 min)

1. 20s: problem statement. A rule with a deadline applies to you and an auditor wants proof of where the code meets each requirement. Today an engineer and a compliance person build that mapping by hand in a spreadsheet (Regology 2026: 81% of compliance teams run obligations on manual workflows and spreadsheets). No hours-per-week number: the only measured figure is AscentAI 2026, 1 in 5 teams spend 41+ hours a *month* on all regulatory change work, and it does not isolate mapping.
2. 40s: architecture diagram walkthrough.
3. 60s: trigger a manual run on Fly; show logs: scrape → 2 new rules → embed → graph fan-out.
4. 60s: open the generated PDF; walk one critical finding from regulation section to `file:line`.
5. 30s: Slack alert arriving; click signed link.
6. 30s: show cron registration in BullMQ and the tests/eval output. Close with limitations and next steps.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Scraper breaks when portal markup changes | API source as primary; Playwright source isolated with fixtures, screenshot on failure, alert on zero results. |
| Hallucinated citations | `verify_citations` node rejects any chunk id or `file:line` that does not exist. Findings without evidence become `needs_review`. |
| LLM cost creep | Audit only on new rule hashes; Haiku for cheap steps; per-run budget cap; cost recorded on `audit_runs`. |
| WeasyPrint system deps on Fly | Build the Docker image locally first; pin versions; smoke test `weasyprint --version` in CI. |
| Redis eviction drops jobs | Upstash/Fly Redis with `noeviction`; BullMQ `removeOnComplete` with age limit. |
| Demo day cron timing | `POST /runs` manual trigger with a `?demo=1` flag that forces the demo rules through. |
| Over-claiming legal accuracy | Disclaimer page in every report; README limitations section. |

---

## 9. Repo layout

```
compliance-sentinel/
├─ src/
│  ├─ scrape/        federalRegister.ts, secRules.ts, finraNotices.ts, fcaPublications.ts, esmaNews.ts,
│  │                 asicTracker.ts, eurLex.playwright.ts, masCirculars.playwright.ts, rss.ts, html.ts, pdf.ts, http.ts, diff.ts
│  ├─ digest/        digestRule.ts, weekly.ts, deliver.ts, textDiff.ts
│  ├─ rag/           chunker.ts, embed.ts, retrieve.ts, indexRepo.ts
│  ├─ graph/         state.ts, nodes/*.ts (incl. digest.ts), graph.ts, controls.ts, evidence.ts
│  ├─ llm/           claudeAnalyst.ts, offlineAnalyst.ts
│  ├─ report/        template.html, render.ts (WeasyPrint), upload.ts
│  ├─ notify/        slack.ts, email.ts, agentmail.ts
│  ├─ queue/         queue.ts, worker.ts, schedule.ts
│  ├─ web/           server.ts, schemas.ts
│  ├─ pipeline/      run.ts, watchdog.ts
│  ├─ cli/           auditRun, digestRun, evalGolden, evalRetrieval, indexRepo, migrate
│  └─ db/            schema.ts, client.ts, migrations/
├─ web/              Next.js dashboard (own package.json and lockfile), deployed to Vercel
├─ demo-target-app/  seeded Express app with planted violations
├─ samples/          report-example.pdf, report-example.html
├─ docs/             architecture.json (Archify source), architecture.html, architecture.png
├─ tests/            diff, chunker, verify_citations, golden audit, scrapers against fixtures, digest
├─ Dockerfile  docker-compose.yml  fly.toml  .env.example  README.md
```

---

## 10. Environment variables

`DATABASE_URL`, `REDIS_URL`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `SLACK_WEBHOOK_URL`, `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID`, `AGENTMAIL_WEBHOOK_SECRET`, `ALERT_EMAIL_TO`, `TIGRIS_*` (bucket, key, secret, endpoint), `TARGET_REPO_PATH` or `TARGET_REPO_URL`, `RUN_TRIGGER_TOKEN`, `AUDIT_CRON` (default `0 6 * * *`), `DIGEST_CRON` (default `0 7 * * 1`), `DIGEST_DAYS`, `MAX_RUN_COST_USD`, and one `SCRAPE_*` switch plus query and cap settings per source. The dashboard adds `SENTINEL_API_URL`, `SENTINEL_API_TOKEN` and the Clerk keys. `.env.example` has the full list with defaults.

---

## 11. Stretch goals (only after DoD is met)

- Open a GitHub issue per critical finding (Octokit).
- Second target repo via `TARGET_REPO_URL` clone at run time.
- Human-in-the-loop approval stage using LangGraph `interrupt`.
- Rule-to-control mapping cache so repeated obligations skip the LLM.
