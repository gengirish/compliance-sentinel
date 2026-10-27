# Plan: GitHub App with tenants, PR trigger, review loop

**Written 2026-10-27.** Implementation plan for the three items marked *Not started* in [ROADMAP.md §12](../ROADMAP.md): §2b GitHub App and tenants, §3 PR trigger in the hosted App, §5 review loop. The roadmap says *what*; this says *how*, against the code as it is today, in the order the PRs should land.

Decisions already taken in [decisions.md](decisions.md) are assumed: Clerk Organizations with a personal-org fallback (D3), the product's keys with a $25/month tenant cap (D2), review after the report rather than `interruptBefore` (D5).

---

## 0. Done when

| Item | Yes/no check |
|---|---|
| App + tenants | Install the App on a private repo you own. The dashboard shows that repo; **Run audit** produces a report for it. A second Clerk org sees none of it. |
| PR trigger | Open a PR against a connected copy of `demo-target-app` that logs a card number. Within a few minutes a `compliance-sentinel` check run fails with an annotation on that line, and the summary shows the PR's cost. |
| Review loop | Reject a finding, rerun the audit: it does not come back. Reassign one to `low`: it comes back as `low`. `pnpm eval:labels` writes the decisions as JSONL. The overview headline is precision over reviewed findings. |

---

## 1. What the code says that the roadmap does not

These change the design. Each is handled in the PRs below.

1. **The indexer deletes the baseline.** [src/rag/indexRepo.ts](../src/rag/indexRepo.ts) deletes every chunk for the repo whose `commit_sha` differs from the one being indexed. Indexing a PR head would erase the default-branch chunks that the delta compares against. Retention has to become "keep the baseline sha and the current sha".
2. **The setup redirect is not proof of ownership.** After install, GitHub redirects to the setup URL with `?installation_id=…`. That parameter is unauthenticated: anyone can paste another org's id. Linking an installation to a Clerk org must go through GitHub user OAuth (enable "Request user authorization during installation") and confirm the id appears in `GET /user/installations` for that user.
3. **Rules are global, runs are not.** `rules`, `rule_chunks`, `rule_digests` and `embedding_cache` hold public regulation text and content hashes. They stay shared. Tenancy applies to `repos`, `audit_runs`, `findings`, `code_chunks` and the new review tables. Two routes leak across tenants today: `/rules` (its `lastAuditedRunId` is a global max) and `/reports/:id` (any run id gets a signed URL).
4. **"Changed rules" is global, "rules a repo has not been audited against" is per repo.** `collectChangedRules` in [src/pipeline/run.ts](../src/pipeline/run.ts) scrapes, then audits whatever changed. With many repos, the cron has to scrape once and then fan out one audit per repo, each scoped to that tenant's rule packs.
5. **The migration runner splits on `;` at end of line** ([src/db/client.ts](../src/db/client.ts)). No `DO $$ … $$` blocks or functions in migrations: plain statements only. They must also run on PGlite, because the GitHub Action uses it.
6. **Enums are strict on both sides.** `audit_runs.trigger` is `cron | manual` in [schema.ts](../src/db/schema.ts) and in the dashboard's zod `Run` in [web/src/lib/api.ts](../web/src/lib/api.ts). New triggers (`install`, `pull_request`, `push`) break the dashboard parse unless both change in the same PR.
7. **Clone dirs collide.** `cloneRepo` keys its folder by repo name. A PR run and a baseline run of the same repo would overwrite each other once worker concurrency goes above 1. Key it by `repoId-sha`.
8. **Obligation ids are positional** (`${rule.id}-${index}`), so they differ between runs whenever the model returns obligations in a different order. The obligation cache in §3 makes them stable, and both the PR delta and review carry-forward depend on that. So the cache comes first in phase B.

---

## 2. Phase A: GitHub App and tenants (about 5 days)

### Manual steps (you, before A3)

- Register the GitHub App under the `gengirish` account. Permissions: Contents read, Metadata read, Checks write, Pull requests read. Events: `installation`, `installation_repositories`, `pull_request`, `push`. Webhook URL: `https://<fly app>/github/webhook`. Setup URL: `https://<dashboard>/github/setup`. Tick "Request user authorization (OAuth) during installation".
- Enable Organizations in the Clerk dashboard.
- Put the secrets in Fly and Vercel (names in A1).

### A1. Schema and config: `0004_tenants.sql`

- `tenants`: id, name, github_installation_id (unique, nullable for the local tenant), clerk_org_id (unique, nullable), rule_packs `text[]` default `{pci}`, monthly_budget_usd default 25, created_at.
- `repos`: id, tenant_id, github_repo_id (unique), full_name, default_branch, baseline_run_id (nullable), baseline_sha (nullable), active boolean, created_at.
- `audit_runs`: add `tenant_id`, `repo_id`, `head_sha`. Widen `trigger` to `cron | manual | install | pull_request | push`.
- `code_chunks`: add `repo_id` and index `(repo_id, commit_sha, path)`. Keep `repo` text until A2 has moved every reader, then drop it in the same PR.
- Seed: tenant 1 `local` and a repo row for `demo-target-app`. Backfill existing runs and chunks to it. CLI runs, evals and the GitHub Action attach to tenant 1, so none of them need to know tenants exist.
- [src/config.ts](../src/config.ts) and `.env.example`: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM, `\n`-escaped), `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_SLUG`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`. All optional; webhook routes answer 503 without them, like AgentMail.
- Dashboard `Run` zod: widen `trigger`, add optional `repoId` and `headSha`.

### A2. Scope everything by tenant

- `AppDeps` gains `resolveTenant(c)`: reads `x-sentinel-tenant` (a Clerk org id or `user:<id>`) sent by the dashboard and looks up `tenants.id`. The service token stays the trust boundary: only the dashboard holds it, and it sets the header server-side. No header means tenant 1, so the existing CLI and e2e flows keep working.
- Every route in [src/web/server.ts](../src/web/server.ts) filters by tenant: `/runs`, `/runs/:id`, `/runs/:id/findings`, `/stats`, `/reports/:id` (404 for another tenant's run), `/rules` (`lastAuditedRunId` computed over this tenant's runs only). `POST /runs` takes `repoId` and checks that it belongs to the tenant.
- `retrieveCodeEvidence` and `retrieve.ts` filter `code_chunks` by `repo_id`, not by name.
- `indexRepo(db, embedder, root, { repoId, keepShas })`: the delete becomes `repo_id = $1 AND commit_sha NOT IN (current, baseline)`. This fixes item 1.
- **Tests** in [tests/webApi.test.ts](../tests/webApi.test.ts): two tenants with a run each, and for every route an assertion that tenant B reads nothing of tenant A's: lists are empty, by-id lookups return 404. This is the mitigation the roadmap's risk table promises, so it ships in this PR, not later.

### A3. App auth, clone and webhook

- New `src/github/app.ts`: an `@octokit/auth-app` instance from config. `installationOctokit(installationId)` and `installationToken(installationId)`. Tokens stay in memory and are never written to the database or logs.
- `cloneRepo(url, ref, { token, dir })` in [run.ts](../src/pipeline/run.ts): the token goes in through `http.extraheader` (`git -c http.extraheader="AUTHORIZATION: basic …"`) rather than the URL, so it never lands in `.git/config` or an error message. The directory is `.data/repos/<repoId>-<sha>`, removed in `finally`.
- `POST /github/webhook`, mounted before the token middleware like `INBOUND_PATH`. Verify `x-hub-signature-256` (HMAC-SHA256, `timingSafeEqual`), parse with zod, respond within 10s by only enqueuing. Use `x-github-delivery` as the BullMQ `jobId`, so redelivery is a no-op.
  - `installation.created`: upsert a tenant with no Clerk org yet, plus its repos. Enqueue one `install` audit per repo to build the baseline.
  - `installation.deleted` / `suspend`: mark the repos inactive and stop scheduling them. Keep the data, since reports are evidence.
  - `installation_repositories.added/removed`: upsert or deactivate repos, and baseline the added ones.
- `PipelineOptions` gains `tenantId` and `repoId`. When `repoId` is set, `resolveTargetRepo` loads the repo row, mints a token and clones `full_name` at `head_sha ?? default_branch`. The completed run sets `repos.baseline_run_id` and `baseline_sha` when it audited the default branch.

### A4. Queue fan-out and budget

- `AuditJobData` in [src/queue/queue.ts](../src/queue/queue.ts) gains `tenantId`, `repoId`, `headSha`, `baseSha`, `prNumber`, `checkRunId`, and `kind: "audit" | "digest" | "scrape" | "pr"`.
- The daily cron becomes a `scrape` job. It runs `collectChangedRules` once, then enqueues one `audit` per active repo whose tenant's rule packs include a changed rule, passing `ruleIds`. Tenant 1 keeps today's behaviour.
- Budget: before a run starts, sum `cost_usd` over the tenant's runs this calendar month. Over `monthly_budget_usd`: record a `skipped` run with a note saying the budget was reached. `MAX_RUN_COST_USD` stays the per-run cap.
- `processAuditJob` in [worker.ts](../src/queue/worker.ts) routes on `kind`. Its tests extend the existing pattern, with no Redis.

### A5. Dashboard: orgs, install, repos

- [web/src/lib/api.ts](../web/src/lib/api.ts): `apiFetch` adds `x-sentinel-tenant` from `auth()`: `orgId ?? "user:" + userId`.
- `/github/setup` route handler: exchange the OAuth `code`, call `GET /user/installations` and require that the `installation_id` is in the list (item 2). Then `POST /tenants/link` on the API with the installation id and Clerk org (or user). Show an error page otherwise.
- An "Install on GitHub" button (`https://github.com/apps/<slug>/installations/new`) on the overview when the tenant has no installation. A repo picker beside **Run audit** ([run-audit-button.tsx](../web/src/components/run-audit-button.tsx)). Add an `OrganizationSwitcher` to the [user menu](../web/src/components/auth/user-menu.tsx).
- README: delete "Single tenant… every signed-in dashboard user sees every run".
- e2e: [mock-api.mjs](../web/tests/e2e/mock-api.mjs) asserts that the header is sent.

**Phase A exit:** the App + tenants check in §0.

---

## 3. Phase B: PR trigger (about 5 days)

### B1. Obligation cache and stable signatures: `0005_pr.sql`

- `rule_obligations` (rule_id, content_hash, analyst, obligations jsonb, cost_usd, created_at), unique on `(rule_id, content_hash, analyst)`. It is global, because rule text is public. [extractObligations.ts](../src/graph/nodes/extractObligations.ts) reads it first and skips both `isRelevant` and extraction on a hit, storing irrelevant rules as an empty list. Obligation ids are fixed at first extraction, which settles item 8.
- `findings.signature text`: sha256 of `rule_id | normalised obligation | primary evidence path` (or `absent` when there is no evidence). Computed in `aggregate` and indexed with `run_id`. Phase C reuses this same column, so it is defined once here.
- `audit_runs`: add `base_sha`, `pr_number`, `check_run_id`, and `delta jsonb` (counts of introduced, resolved and unchanged).
- Ship this PR on its own. Full audits get cheaper and more repeatable straight away, and the golden eval should show the same recall with lower cost on the second run.

### B2. PR mode in the graph

- `mode: "audit" | "digest" | "pr"` in [state.ts](../src/graph/state.ts), plus `changedPaths` and `baselineRunId`.
- In `routeMode`, PR mode goes to `extract_obligations` (cache hits, so it costs nothing). Then a new `select_obligations` node keeps only the obligations whose keywords or vectors hit a changed path. The rest skip `assess_obligation` entirely.
- Index the changed files at the head sha only; unchanged files reuse the baseline sha's chunks (A2 retention). Retrieval for PR mode searches `head_sha` chunks for changed paths and `baseline_sha` chunks for everything else.
- `aggregate` in PR mode adds the baseline findings for unselected obligations, and baseline findings on unchanged paths, marked as carried. It then computes the delta by signature: introduced, resolved, unchanged.
- Scope: `ruleIds` comes from the baseline run's `rules_in_scope`. With no baseline yet, finish the check as `neutral` with "Baseline audit still running", and do not run.

### B3. Webhook to check run

- `pull_request` `opened | synchronize | reopened`, only for active repos: list the changed files (`GET /pulls/:n/files`, paginated, up to 3,000), create the check run `in_progress` straight away so the PR shows it, and enqueue `pr` with `jobId = pr-<repoId>-<n>-<headSha>`. Run PR jobs at a higher BullMQ priority than cron audits, so they never wait behind a full audit.
- Superseded pushes: when a job starts and the PR head is no longer its sha, complete its check as `neutral` "Superseded by <sha>" and stop.
- On finish, `src/github/checks.ts` sends one annotation per introduced violation (`path`, `start_line`, `end_line`, `annotation_level` from severity, message with the regulation citation), in batches of 50 per `PATCH`, because that is the API limit. The conclusion is `failure` if any introduced violation is critical (later configurable per tenant), otherwise `neutral`. The summary comes from [src/report/markdown.ts](../src/report/markdown.ts) with an "Introduced / Resolved" section and `cost_usd`, plus the dashboard link.
- Errors: the job's final failure completes the check as `neutral` with the error, never leaving it spinning. The stale-run watchdog does the same for runs it reaps.
- `push` to the default branch: run the same PR mode with base set to the old `baseline_sha`. The result becomes the new baseline, so baselines stay current without a full re-audit after every merge.

### B4. Fixture and demo

- Add a test repository: a copy of `demo-target-app` under your account with the App installed.
- [tests/](../tests/): a PR-mode graph test with the offline analyst. The base has no violations; the head adds a `console.log(card)` and must produce exactly one introduced finding; the same head again must produce zero introduced.
- Record the demo video the roadmap's §4 asks for.

**Phase B exit:** the PR trigger check in §0, and a cost per PR run recorded in the README evaluation section.

---

## 4. Phase C: review loop (about 4 days)

### C1. Schema and API: `0006_reviews.sql`

- `finding_reviews` (id, tenant_id, finding_id, signature, reviewer_id (Clerk user), decision `accepted | rejected | reassigned`, new_status, new_severity, note, created_at), indexed on `(tenant_id, signature, created_at desc)`. The latest review per signature wins.
- `findings.suppressed_by_review_id` (nullable). Suppression is a column, not a new `Status` value: `STATUSES` feeds `summarize`, the report, the Markdown renderer, the Action's `--fail-on` and the dashboard enums, and a fourth status would ripple through all of them.
- `POST /findings/:id/review` with a zod body in [src/web/schemas.ts](../src/web/schemas.ts). It checks the finding's tenant, takes the reviewer from an `x-sentinel-user` header set by the dashboard, and copies the signature from the finding.
- `GET /runs/:id/findings` adds `review` (the latest decision, reviewer and time) and leaves suppressed findings out unless `?suppressed=1`.

### C2. Carry-forward

- In `aggregate` (full and PR mode): look up the latest review per signature for this repo.
  - `rejected`: set `suppressed_by_review_id`, and leave the finding out of `summary`, the report, the check annotations and the severity gate.
  - `reassigned`: apply the human `new_status` and `new_severity` before `summarize`.
  - `accepted`: unchanged, shown as accepted.
- The PR delta in B2 ignores suppressed findings, so a rejected false positive never fails a check again.
- The report and the check summary say "N findings hidden by earlier reviews", so suppression is never silent.

### C3. Dashboard

- [finding-card.tsx](../web/src/components/finding-card.tsx): Accept, Reject and Reassign buttons (Reassign opens a severity and status select), a note field, and the current decision with reviewer and date. They submit through a server action that calls the API, so the token stays server-side.
- Run page: a "Show hidden" toggle for suppressed findings.
- Overview headline: **precision over reviewed findings**, `accepted / (accepted + rejected)` among violations, with the count reviewed beside it. It replaces the model's self-reported counts, and says "No reviews yet" until there are some.

### C4. Labels as a regression set

- `pnpm eval:labels` (new `src/cli/exportLabels.ts`) writes JSONL: rule chunk text, obligation, evidence excerpt, model verdict and severity, human verdict and severity, repo and sha. `--tenant` is required, so there is no accidental cross-tenant export.
- `evalGolden.ts --labels <file>`: re-judges the labelled items and reports agreement with the human verdicts. This is the "golden eval runs against exported labels" exit test.
- Seed it from the hand-labelled `samples/real/*/labels.json` once those are confirmed (ROADMAP next step 2).

**Phase C exit:** the review loop check in §0.

---

## 5. Order and size

| # | PR | Depends on | Days |
|---|---|---|---|
| A1 | Tenants schema, config, local tenant seed | | 0.5 |
| A2 | Tenant scoping, indexer retention, cross-tenant tests | A1 | 1 |
| A3 | App auth, token clone, webhook, install baseline | A2, App registered | 1.5 |
| A4 | Scrape-then-fan-out cron, tenant budget | A3 | 0.5 |
| A5 | Clerk orgs, verified setup flow, repo picker | A3 | 1.5 |
| B1 | Obligation cache, finding signatures | A1 | 1 |
| B2 | PR mode in the graph, delta | B1, A2 | 2 |
| B3 | PR webhook, check runs, push-updates-baseline | B2, A3 | 1.5 |
| B4 | PR-mode tests, demo repo, video | B3 | 0.5 |
| C1 | Reviews schema and API | A2, B1 | 0.5 |
| C2 | Carry-forward in aggregate and delta | C1, B2 | 1 |
| C3 | Review UI, precision headline | C1 | 1.5 |
| C4 | Label export, eval against labels | C1 | 1 |

About 14 working days for one person, close to the roadmap's three weeks. B1 can land in parallel with A3–A5, since it only needs A1. Every PR keeps `pnpm test`, `pnpm typecheck` and the Action's local run green: tenant 1 is the guarantee that the Action and CLI never need a tenant.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Cross-tenant read through a route added later | The per-route cross-tenant test in A2 is the template; every new route ships with one |
| Installation hijack via the setup URL | OAuth plus a `/user/installations` check (A5); never trust `installation_id` alone |
| Installation token in logs or `.git/config` | Pass it via `http.extraheader`, delete the clone dir in `finally`, keep tokens out of `log.*` |
| A PR check sits "in progress" forever | Final job failure and the watchdog both complete the check as `neutral` |
| PR cost creeps up | The obligation cache plus changed-path selection; `cost_usd` shown in every check summary; tenant monthly cap |
| Signature too coarse or too fine | It is path-level, so a moved line keeps its review. Two duties in one file stay distinct through the obligation text. Revisit if reviewers report wrong suppressions; the signature lives in one function |
| Inbound email "run audit" has no tenant | Restrict it to tenant 1 (the operator) until there is a per-tenant inbox |

## 7. Open questions for you

1. **Fail on what?** The plan fails a PR check only for introduced critical violations. A per-tenant `fail_on` setting (as in the Action) is cheap to add in B3 if you want it from day one.
2. **Rule packs per tenant.** The default is `{pci}` only (D1). Do tenants get the live scrapers at all, or only fixture packs until a partner asks?
3. **Who may review.** Any member of the Clerk org, or only admins? The plan assumes any member and records who did it.
