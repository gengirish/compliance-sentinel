# Compliance Sentinel — From demo to something people use

**Plan written 2026-10-27.** [PLAN.md](PLAN.md) describes the Week 5 build that shipped. This document is the next six weeks: the seven changes that turn the demo into a product a stranger can install and a YC partner can believe, in the order they should be built and with the files each one touches.

The ordering rule throughout: evidence first, install path second, everything else only after talking to users.

---

## 0. What "done" means

Six weeks from today the repo and the application should show all of the following. Each is a yes/no.

| # | Evidence | Measured by |
|---|---|---|
| A | The audit has run with Claude and Voyage, and the numbers are public | README "Evaluation" section: golden precision/recall over 3 runs, cost per run |
| B | It has run on real code, and the false positives are published too | 3–5 reports on open-source repos committed under `samples/real/`, each violation hand-labelled |
| C | A stranger can install it in five minutes | A GitHub Action on the Marketplace, then a GitHub App; time-to-first-report measured on a fresh repo |
| D | It runs when code changes, not only when rules change | A PR against a connected repo gets a check run with `file:line` annotations within a few minutes |
| E | It is for one buyer | Landing page names one regulation and one role; the demo finding is from that regulation |
| F | Users can correct it, and the corrections are kept | Accept / reject / reassign on every finding, exported as a labelled set |
| G | At least ten conversations with the named buyer | Notes in `docs/customers/` (private); the plan after week 3 is revised from them |

Items 6 and 7 from the original list (fix PRs, Vanta export) are in this plan but gated on G. They are not built on speculation.

---

## 1. Run it for real and publish the numbers (week 1)

**Why first.** Every verified result in the README comes from the keyword `OfflineAnalyst`. The golden test says so in its own comment: it checks plumbing, not model quality. Until Claude has run, every claim about accuracy is unsupported.

### 1a. Golden eval with Claude

- Set `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY` in `.env`. Run `pnpm eval:golden` three times. The script already prints recall, precision, falsely flagged areas and cost ([src/cli/evalGolden.ts](src/cli/evalGolden.ts)).
- Extend `evalGolden.ts` to write a JSON result to `reports/eval/golden-<date>-<n>.json` (score, per-planted-violation found/missed, unexpected findings, cost, model ids, embedder). Three runs give a variance figure; a single run of a nondeterministic model is not a number.
- If recall is below 5/5, fix prompts or retrieval before anything else in this plan. The `CONTROLS` catalogue in [src/graph/controls.ts](src/graph/controls.ts) seeds keyword search; check whether Claude's extracted `searchKeywords` alone retrieve the planted files, since real rules will not have catalogue entries.
- README: replace the "Implemented, not yet run" row with an **Evaluation** section. Table: run, recall, precision, areas wrongly flagged, cost. State the embedder and both model ids.

### 1b. Real repositories

Pick three to five public repos that handle personal or financial data and are the size of a seed-stage product, not a monorepo. Candidates to check for fit: `ghostfolio/ghostfolio` (TypeScript, personal finance), `calcom/cal.com` (TypeScript, heavy PII, GDPR-relevant), `juice-shop/juice-shop` (TypeScript, intentionally vulnerable, a useful "must find things" control), `maybe-finance/maybe` (Rails, finance), `openemr/openemr` (PHP, HIPAA). Check the extension allowlist in [src/rag/indexRepo.ts](src/rag/indexRepo.ts) before choosing; add extensions rather than skipping a good repo.

For each:

1. `TARGET_REPO_URL=https://github.com/... pnpm audit:run --demo` (demo rules are the five excerpts in `fixtures/rules/`; `resolveTargetRepo` already shallow-clones a URL).
2. Keep `MAX_RUN_COST_USD` at a few dollars and add a file-count cap to `indexRepo` so a large repo fails fast instead of embedding everything. Record the cost.
3. Hand-label every `violation` as true or false positive and every `needs_review` as useful or noise. Thirty minutes per repo. Write the labels into `samples/real/<repo>/labels.json`.
4. Commit the PDF and HTML under `samples/real/<repo>/`.

README table: repo, commit, files indexed, obligations, violations, confirmed, false positives, needs_review, cost, wall time. The false positives stay in the table. A partner trusts a 60% precision figure with the misses shown more than a 100% figure on a fixture.

**Done when:** A and B above. Estimated three to four days including labelling.

---

## 2. Five-minute install (weeks 2–3)

Two deliverables, in this order. The Action is two days and needs no tenant work; the App is the hosted product and needs it.

### 2a. GitHub Action (week 2)

A composite or Docker action, `compliance-sentinel/audit-action`, wrapping the existing image:

- Inputs: `anthropic-api-key`, `voyage-api-key` (user brings their own keys at first; no hosted cost), `rules` (default: the bundled set for the chosen regulation, see §4), `fail-on` (`critical` | `high` | `none`).
- Runs `pnpm audit:run --demo --repo $GITHUB_WORKSPACE` with PGlite (no Neon needed; `DATABASE_URL` unset already does this) and renders the HTML report.
- Posts a PR comment with the summary table and the top findings, and uploads the HTML/PDF as a workflow artifact. Uses `GITHUB_TOKEN`; no App installation required.
- Add a `--format=markdown` output to the CLI so the comment body comes from the same renderer as the report.

Publish to the Marketplace. Measure time from "add the workflow file" to "first comment" on a fresh repo. Put that number on the landing page.

### 2b. GitHub App and tenants (week 3)

The App is the identity for everything after this: PR webhooks (§3), private-repo clones, opening PRs (§6).

**Schema** ([src/db/schema.ts](src/db/schema.ts), new migration):

- `tenants`: id, name, github_installation_id (unique), clerk_org_id (nullable), created_at.
- `repos`: id, tenant_id, github_full_name, default_branch, last_audited_sha, created_at.
- `audit_runs.repo_id` (nullable for the legacy single-repo runs; backfill to a "demo" repo row), `audit_runs.head_sha`.
- `code_chunks`: key by `repo_id` instead of the free-text `repo` column; `commit_sha` stays.
- Every API query filters by tenant. `findings` and `rule_digests` inherit through the run.

**Clone path.** `resolveTargetRepo` in [src/pipeline/run.ts](src/pipeline/run.ts) already clones `TARGET_REPO_URL`. Add an installation-token path: mint a token with the App's private key, clone `https://x-access-token:<token>@github.com/<full_name>` at a given sha. Tokens live for an hour; never persist them.

**Webhooks.** New route `POST /github/webhook` in [src/web/server.ts](src/web/server.ts), signature-verified like the AgentMail one. Handle `installation` (create tenant + repos), `installation_repositories`, and in §3 `pull_request`.

**Queue.** `AuditJobData` in [src/queue/queue.ts](src/queue/queue.ts) gains `repoId` and `headSha`. The daily cron fans out one job per repo rather than one job total.

**Dashboard.** Clerk Organizations map to `tenants.clerk_org_id`. The server components already call the API with a service token; add the org id as a header and have the API scope by it. The "every signed-in user sees every run" note in the README goes away.

**Hosted cost.** The App uses the product's keys. Per-tenant budget: `MAX_RUN_COST_USD` becomes a column on `tenants` with a monthly rollup. This is the first pricing lever; see §8.

**Done when:** C above. Install the App on a private repo you own, press **Run audit** in the dashboard, get a report for that repo and no other tenant's data.

---

## 3. Trigger on code changes (week 4)

Rule changes arrive a few times a year. Pull requests arrive daily. This is the recurring use, and the GitHub check run with annotations is the natural output: a check annotation is `path, start_line, end_line, message`, which is exactly the `CodeEvidence` shape already in `findings.evidence`.

**Pipeline mode `"pr"`** alongside `"audit"` and `"digest"` in [src/graph/graph.ts](src/graph/graph.ts):

1. Webhook `pull_request` (`opened`, `synchronize`) enqueues `pr-audit` with repo, head sha, base sha, changed paths.
2. No scrape. Rules in scope are the rules the repo was last audited against (`repos.last_audited_sha` run's `rules_in_scope`).
3. **Obligation cache.** New table `rule_obligations` (rule_id, content_hash, obligations jsonb). `extract_obligations` reads from it when the hash matches and skips the model call. This was the stretch-goal "rule-to-control cache"; it is what makes a PR run cheap.
4. Index only the changed files at head sha. The `embedding_cache` table already dedupes by text hash, so unchanged lines cost nothing.
5. `retrieve` and `assess` run only for obligations whose keywords or vectors hit a changed file. Everything else carries forward from the baseline run.
6. **Delta.** Compare with the baseline findings for the same repo: introduced, resolved, unchanged. Only introduced violations and resolved ones go in the check.
7. Output: a GitHub Check Run (`compliance-sentinel`) with one annotation per introduced violation, conclusion `failure` if any critical, `neutral` otherwise. Summary markdown reuses the §2a formatter.

Cost target: well under a dollar per PR on a typical change. Record `cost_usd` per PR run and show it in the check summary; cheap-and-visible is part of the pitch.

**Done when:** D above. Open a PR against `demo-target-app` that adds a `console.log` of a patient record and the check flags that line within a few minutes.

---

## 4. One regulation, one buyer (week 2, in parallel with the Action)

Eight sources read as breadth. The product needs a buyer with a date.

**Recommendation: PCI DSS 4.0.1, buyer = head of engineering or CTO at a Series A–B fintech with an assessment date.** Reasons: the requirements are the most code-shaped of the candidates (secure development, authentication, logging, cardholder data handling), the assessment is annual so the need recurs, the QSA literally asks for the evidence this tool produces, and the buyer is named by role in every fintech. The alternative is the EU AI Act high-risk obligations (logging, human oversight, technical documentation): more fashionable, more AI startups, but the obligations are less code-mappable and most applicants are not high-risk. DORA and NIS2 are policy-heavy. Verify the current enforcement status of whichever one is chosen before the landing page claims a date.

This is a founder decision. The plan below is written for PCI DSS and swaps cleanly if the ten conversations in §G say otherwise.

**Work:**

- A `fixtures/rules/pci-dss-4-excerpt.json` with the requirements that map to code (3.3, 3.5, 4.2, 6.2, 6.4, 8.3, 8.4, 10.2, 10.3). The text is PCI SSC copyright; the fixture carries requirement numbers and paraphrased obligations, not the standard verbatim. Note this in the fixture.
- Add a payments route to `demo-target-app` with planted PCI violations: PAN in logs, CVV persisted, no TLS on the callback, shared admin credentials. Extend `PLANTED_VIOLATIONS` in [src/eval/golden.ts](src/eval/golden.ts).
- `CONTROLS` entries for those requirements, with `frameworkRefs` (also used by §7).
- Landing page ([web/src/app/page.tsx](web/src/app/page.tsx)): headline for that buyer; the sample finding becomes a PCI requirement with its `file:line`; the "eight sources" copy goes; the Action install snippet and the measured time-to-first-report go in. The dashboard and the scrapers stay, with the other sources off by default (`SCRAPE_*=false`).
- A one-page "why now" for the buyer, in `docs/positioning.md`: the deadline, what the assessor asks for, what this replaces (the spreadsheet), what it does not do (the policy side, which Vanta/Drata already own).

**Done when:** E above, plus a thirty-second demo video of the PR check on the payments route.

---

## 5. Human review that generates data (week 5)

The `interruptBefore` hook in [src/graph/graph.ts:56](src/graph/graph.ts#L56) is commented out. Do not use it. Pausing the graph before the report means no report until someone clicks. Review after the fact instead, and carry decisions forward to the next run.

**Schema:** `finding_reviews` (id, finding_id, reviewer_id (Clerk user), decision `accepted` | `rejected` | `reassigned`, new_status, new_severity, note, created_at). One finding may have several reviews; the latest wins.

**API:** `POST /findings/:id/review` with the zod schema in [src/web/schemas.ts](src/web/schemas.ts). Tenant-scoped.

**Dashboard:** on [web/src/app/(dashboard)/runs/[id]/page.tsx](web/src/app/(dashboard)/runs/[id]/page.tsx), three buttons per finding and a note field, via a server action. The row shows the current decision and who made it.

**Carry-forward:** a finding signature `(rule_id, obligation hash, path)`. In `aggregate`, a new finding whose signature was `rejected` on an earlier run for the same repo is marked `suppressed` and not reported; one that was `reassigned` keeps the human severity. This is what makes the second run feel better than the first.

**Export:** `pnpm eval:labels` writes a JSONL of (rule chunk text, obligation, evidence excerpt, model verdict, human verdict). The dashboard overview gains "precision over reviewed findings" as its headline number, replacing the model's self-reported counts.

**Done when:** F above, and the golden eval can run against the exported labels as a regression set.

---

## 6. Fix, not just report (week 6, gated on §G)

Only after the review loop exists: a fix PR for an unreviewed finding is a liability, a fix PR for an accepted one is a feature.

- Job `remediate` for findings that are `accepted` and `violation`. Claude produces a unified diff constrained to the evidence file(s), using the obligation, the citation and the excerpt. Reject any diff touching a file outside the evidence set.
- Apply on a branch `sentinel/fix-<finding-id>` in a fresh clone (the §2b token), open a **draft** PR via Octokit with the finding, the regulation citation and the rationale. One finding per PR. Cap per run.
- Dashboard: a "Propose fix" button per accepted violation, and a link to the PR when one exists.

**Done when:** the PII-in-logs violation in `demo-target-app` gets a draft PR that removes the field from the log line, and a human can review it.

---

## 7. Plug into where evidence already lives (on demand, gated on §G)

Vanta, Drata and Secureframe all collect policy and infrastructure evidence and have public APIs for custom evidence. None maps requirements to code. Being the code layer next to them is a better position than competing with them, and their marketplaces are distribution.

Build this when a design partner names the tool they use, not before. Scaffolding that costs nothing now:

- `frameworkRefs` on `CONTROLS` (SOC 2 CC6.x, PCI 4.0 requirement ids, ISO 27001 Annex A ids), added in §4.
- An export command, `pnpm export:evidence --run <id> --format vanta|drata`, that writes one evidence document per control with pass/fail, the finding, and the report link. The first integration is a file export the customer uploads; the API push comes after it is wanted.

---

## 8. Sequence and effort

| Week | Build | Talk |
|---|---|---|
| 1 | §1 golden eval with Claude, real-repo reports, README evaluation section | Draft the buyer list (fintechs with public PCI/SOC 2 pages, YC fintech batch lists) |
| 2 | §2a GitHub Action, §4 fixture, demo app payments route, landing page rewrite | First five conversations; show the Action |
| 3 | §2b GitHub App, tenants, installation clone, Clerk orgs | Next five; ask for an install on a real repo |
| 4 | §3 PR trigger, obligation cache, check run with annotations | Revise §4–§7 from what was heard |
| 5 | §5 review loop, carry-forward, label export | Get two design partners reviewing findings |
| 6 | §6 fix PRs if partners asked; otherwise more of §1 on partner repos | Write the application with real numbers |

Estimates assume one person full time. §1 is the only item that can be finished without a decision from you.

---

## 9. Decisions needed from you

1. **Regulation and buyer** (§4). Recommended: PCI DSS 4.0.1, fintech head of engineering. Decide by the end of week 1; the Action and the landing page depend on it.
2. **Who pays for tokens.** The Action uses the user's keys; the App uses yours with a per-tenant cap. Confirm you are willing to carry hosted cost for early tenants.
3. **Clerk Organizations or a simpler tenant switch.** Orgs are the clean path; a single-tenant-per-Clerk-user shortcut saves two days in week 3 if every early tenant is one person.
4. **Real repos** (§1b). Pick from the candidates or name others; the choice sets which languages the indexer must handle well.

## 10. Explicitly not in this plan

- More regulatory sources, MAS inside Docker, weekly digest delivery, the Loom. Finish them if there is slack; none changes the answer to "who uses this and why would they pay".
- Checkpoint resume for crashed runs. A retry starts fresh and that is fine at this scale.
- Multi-region, SOC 2 for the product itself, SSO. After the first paying tenant.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Claude recall on the golden set is poor | Fix in week 1 before building anything on top; retrieval is the usual cause, not the judge prompt |
| Real repos cost too much to index | File-count and byte caps in `indexRepo`; index only tracked source extensions; PR mode indexes the diff only |
| PCI text cannot be reproduced | Fixture carries requirement ids and paraphrases; the report cites the requirement number and links to the standard |
| Tenant data leaks across orgs | Every query takes a tenant id; one test per API route that asserts cross-tenant reads return nothing |
| Fix PRs are wrong | Draft only, one file, only after a human accepted the finding |
| Nobody takes the calls | The Action on the Marketplace is the fallback funnel; the install count is the signal even without conversations |

## 12. Progress

Decisions for §9 are recorded in [docs/decisions.md](docs/decisions.md).

**2026-10-27**

| Item | State |
|---|---|
| §1a Golden eval with Claude | Done. Results saved per run to `reports/eval/`, published runs in [samples/eval/](samples/eval). An eval in which every model call fails now aborts instead of scoring 0% recall and 100% precision |
| §1a Absence of evidence | Fixed. The judge now gets a repository-wide keyword count and the file list, so it can call a control absent. The retention job went from missed in 3 of 3 runs to found in 3 of 3 |
| §1b Real repositories | Done with Claude on ghostfolio, juice-shop and maybe at pinned commits, $3.82 in total. First-pass labels by Claude Code give 42% precision; **a person still has to confirm them** |
| §2a GitHub Action | Built: [action.yml](action.yml), Markdown summary, comment upsert, `--fail-on`. The audit step was verified locally; **not yet run on GitHub or listed on the Marketplace** |
| §4 PCI DSS | Paraphrased PCI DSS v4.0.1 rule file, five planted PCI violations in the demo app, four PCI catalogue controls with `frameworkRefs`, and the landing page rewritten for the fintech buyer |
| §2b GitHub App and tenants | Not started |
| §3 PR trigger | Not started. The Action already covers PRs for users who bring their own key |
| §5 Review loop | Not started |

**Next, in order**

1. **Fix the main false-positive class.** Organisational duties, such as notifying a regulator or running incident response, should be `needs_review`, not violations against unrelated files. This is the cause of most of the 14 false positives on real code. Measure the fix on a fresh set of repositories, not the three already labelled, to avoid tuning to them.
2. **Confirm the real-repo labels by hand.** About 30 minutes per repo, using the notes in each `labels.json`.
3. **Set `VOYAGE_API_KEY`** and rerun the golden eval. All published numbers so far used the local hash embedder.
4. **Run the Action on a real pull request.** Do it in a test repository, then list it on the Marketplace.
5. **Then §2b, §3 and §5,** in that order.
