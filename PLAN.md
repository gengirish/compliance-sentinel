# Compliance Sentinel Agent — Build Plan

**Portfolio P1 · Week 5 deliverable · Agentic System**

One-liner: a LangGraph agent scrapes regulatory portals daily, embeds new rules into a Legal RAG store, audits a target codebase against them, and emits an audit-ready PDF report with citations plus Slack/email alerts for critical findings. Runs as a BullMQ cron worker on Fly.io. Shipped as a public GitHub repo plus a Loom demo.

---

## 1. Scope and definition of done

**In scope (must ship)**

1. Daily scrape of 2 regulatory sources with change detection (new or amended rules only).
2. Legal RAG store: chunked regulation text with embeddings in Postgres + pgvector.
3. LangGraph audit graph that maps obligations in new rules to evidence in a target codebase.
4. PDF report (WeasyPrint) with findings, severity, regulation citations, and `file:line` code citations.
5. Slack webhook + email alert when any finding is `critical`.
6. BullMQ repeatable job (cron) running the pipeline daily on Fly.io, plus an on-demand trigger for demos.
7. Public GitHub repo with README, architecture diagram, `.env.example`, Dockerfile, `fly.toml`, and a sample report committed.
8. Loom demo (3–5 min).

**Out of scope (say so in README)**

- Legal advice or guaranteed coverage. The report is decision support, not a legal opinion.
- Auto-remediation of code. The agent reports; it does not open PRs (stretch goal only).
- Multi-tenant SaaS UI. A single health/report endpoint is enough.

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
| Regulatory sources (v1) | **Federal Register** (official JSON API, no scraping fragility) and **EUR-Lex / GDPR amendments page** (Playwright, JS-rendered) | One API source proves the pipeline reliably; one Playwright source proves the scraping requirement. |
| Target codebase | A seeded fixture repo `demo-target-app/` with planted violations (PII in logs, no data-retention job, plaintext secrets, missing consent capture, no breach-notification hook) | Makes the Loom demo deterministic and the findings verifiable. |
| Report storage | Fly Tigris (S3-compatible) bucket; local `./reports` in dev | Signed download link in the Slack alert. |
| Audit trigger | Only when the diff step finds new rule content (content hash changed) | Keeps daily LLM cost near zero on quiet days. |

---

## 3. Architecture

```
            +---------------- BullMQ cron (daily 06:00 UTC) ----------------+
            |                                                                |
  Playwright / Federal Register API                                          |
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

**Services on Fly.io** (one app, two process groups):

- `web`: tiny Hono/Express server. `GET /health`, `GET /reports/:id` (signed redirect), `POST /runs` (manual trigger, token-protected). Fly machines can autostop.
- `worker`: BullMQ worker + scheduler registration for the repeatable job. Always on, 1 machine.

---

## 4. Data model (Drizzle, Postgres)

- `sources` — id, name, kind (`api` | `playwright`), url, last_checked_at.
- `rules` — id, source_id, external_id, title, effective_date, url, content_hash, raw_text, first_seen_at, last_changed_at.
- `rule_chunks` — id, rule_id, ordinal, section_ref, text, embedding `vector(1024)`, metadata jsonb. HNSW index.
- `code_chunks` — id, repo, path, start_line, end_line, text, embedding. Re-indexed when repo commit SHA changes.
- `audit_runs` — id, started_at, finished_at, status, trigger (`cron` | `manual`), rules_in_scope int[], report_url, cost_usd.
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
9. **notify** — Slack Block Kit message + Resend email with summary and signed link.

Guardrails: per-run token budget; `max_retries` with backoff per node; checkpointer so a crash mid-fan-out resumes instead of restarting; `interrupt_before` hook left in place for an optional human review stage (not wired in v1).

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
- Slack webhook + Resend email; dry-run mode when env vars are missing.

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

1. 20s: problem statement and the 40+ hrs/week claim framed as "manual regulatory monitoring + code review".
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
│  ├─ scrape/        federalRegister.ts, eurLex.playwright.ts, diff.ts
│  ├─ rag/           chunker.ts, embed.ts, retrieve.ts, indexRepo.ts
│  ├─ graph/         state.ts, nodes/*.ts, graph.ts
│  ├─ report/        template.html, render.ts (WeasyPrint), upload.ts
│  ├─ notify/        slack.ts, email.ts
│  ├─ queue/         queue.ts, worker.ts, schedule.ts
│  ├─ web/           server.ts
│  └─ db/            schema.ts, migrations/
├─ demo-target-app/  seeded Express app with planted violations
├─ samples/          report-example.pdf
├─ tests/            diff, chunker, verify_citations, golden audit
├─ Dockerfile  docker-compose.yml  fly.toml  .env.example  README.md
```

---

## 10. Environment variables

`DATABASE_URL`, `REDIS_URL`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `SLACK_WEBHOOK_URL`, `RESEND_API_KEY`, `ALERT_EMAIL_TO`, `TIGRIS_*` (bucket, key, secret, endpoint), `TARGET_REPO_PATH` or `TARGET_REPO_URL`, `RUN_TRIGGER_TOKEN`, `AUDIT_CRON` (default `0 6 * * *`), `MAX_RUN_COST_USD`.

---

## 11. Stretch goals (only after DoD is met)

- Open a GitHub issue per critical finding (Octokit).
- Second target repo via `TARGET_REPO_URL` clone at run time.
- Human-in-the-loop approval stage using LangGraph `interrupt`.
- Rule-to-control mapping cache so repeated obligations skip the LLM.
