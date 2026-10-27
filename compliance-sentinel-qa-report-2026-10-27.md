# QA Test Report — Compliance Sentinel

**Verdict:** GO WITH FIXES — the core flows work end to end (audit queue → run → findings → PDF report → settings), but the same audit returns different verdicts on a re-run, and the scanned code shows secrets in plain text. Both need fixing before real customers use it.

| Passed | Failed | Blocked | Not run | S1 | S2 | S3 | S4 |
|---|---|---|---|---|---|---|---|
| 13 | 6 | 0 | 5 | 0 | 3 | 3 | 4 |

## 1. Environment
| Field | Value |
|---|---|
| Target URL | https://compliance-sentinel-web.vercel.app (demo deployment; Clerk in development mode) |
| Browser / agent | Chrome + Claude in Chrome (side panel) |
| Viewport(s) | 809x569 desktop; 375px wide (simulated with a same-origin iframe, because the window could not be resized) |
| Test identity | Girish's signed-in Clerk account (Google OAuth) |
| Date / time | 27/10/2026, 16:14–16:25 IST (10:44–10:55 UTC) |
| Depth | Deep |
| State changes made | Queued 1 manual audit (**Run #22, $0.560 model cost**). SEC source toggled on → off → Reset → off, so it ends back at its original state (off, "Set here"). |

## 2. Test matrix
| ID | Flow | Objective | Result | Notes |
|---|---|---|---|---|
| OV-01 | Overview | KPIs load and match the latest run | PASS | 26 / 10 / 9 / 0, matching Run #21. After the new run they updated to Run #22. |
| OV-02 | Run audit (demo rules) | Audit queues, runs and completes | PASS | `POST /api/runs → 202`. Button shows a spinner and is disabled while the request is in flight. Run #22 completed in 1m 40s. |
| RUN-01 | Runs list | Table renders and links resolve | PASS | 18 runs. Report icons have aria-labels ("Report for run 21"). |
| RUN-02 | Run detail #21 | Findings and evidence expanders work | PASS | 35 findings. Regulation and code-evidence `<details>` expand. See DEF-006 for the label problem. |
| RUN-03 | Run detail while running | Shows a progress state | **FAIL** | DEF-004 |
| RUN-04 | Re-run determinism | Same rules + same repo → same verdicts | **FAIL** | DEF-001 |
| RUN-05 | Invalid run IDs | /runs/18, /9999, /abc, /-1 handled | **FAIL (S4)** | The friendly 404 page renders, but the HTTP status is 200. DEF-008 |
| RPT-01 | PDF report | `/api/reports/21` opens the PDF | PASS | Redirects to a signed Tigris URL. The "Regulatory audit of demo-target-app" PDF renders. |
| RPT-02 | Report access control | Unsigned bucket URL is denied | PASS | `…/reports/run-5.pdf` without a signature → `AccessDenied` |
| RPT-03 | Report API negatives | Bad IDs return clean errors | PASS | `abc → 400 {"error":"invalid run id"}`; `9999`, `14` → `404 {"error":"no report for this run"}` |
| RUL-01 | Rules list | 48 rules; source counts match Settings | PASS | Federal Register 5, SEC 5, FINRA 6, FCA 4, ESMA 10 all match |
| SET-01 | Toggle source | Change persists across a reload | PASS | `PUT /api/settings/sources/sec → 200`, and the change survived a reload. The refresh request that follows fails, see DEF-005. |
| SET-02 | Reset source | Returns to the default and updates the badge | PASS | The badge changed from "Set here" to "Default" and the toggle went ON (the default) |
| UI-01 | User menu | Menu items are readable | **FAIL** | DEF-002 |
| RESP-01 | Mobile 375px | No horizontal page overflow on 5 pages | PASS | scrollWidth 360 ≤ 375 on Overview, Runs, Run detail, Rules, Settings |
| A11Y-01 | Keyboard / structure | Visible focus, `lang`, `<main>`, heading order | PASS | Focus ring is visible. `lang="en"`. There is one H1 per page. |
| A11Y-02 | Accessible names | Every control has a distinct name | **FAIL (S4)** | DEF-009 |
| SEC-01 | Evidence handling | Secrets in scanned code are not displayed | **FAIL** | DEF-003 |
| CON-01 | Console | No JS errors across pages | PASS | 0 errors. One warning about Clerk dev keys (DEF-010). |

## 3. Defects (highest severity first)

### DEF-001 · Re-running the same audit changes verdicts and severities — S2 · Functional (AI output) · Confirmed 1/1 re-run
- **Where:** /runs/21 vs /runs/22
- **Steps to reproduce:** 1. Note the results of Run #21 (manual, demo rules, 6 rules, demo-target-app). 2. With no changes, click **Run audit** with "Demo rules" checked. 3. Compare the Run #22 findings with Run #21.
- **Expected:** Same code and same rules should give the same verdicts and severities, with findings that can be tracked from run to run.
- **Actual:** Critical went from 10 to 12, High from 16 to 14, Needs review from 9 to 10. 28 of the 35 obligation titles in #21 do not appear word for word in #22, because the obligations are reworded on each run. Some verdicts changed for the same obligation:
  - "Encrypt all customer information in transit…": **Needs review / Medium → Violation / Critical**
  - "Make and maintain written records documenting compliance…": **Needs review / Medium → Violation / High**
  - "Detect unauthorized access to or use of customer information…": **Violation / High → Violation / Critical**
- **Evidence:** I compared the DOM of `/runs/21` and `/runs/22` (35 vs 36 article cards). The Overview KPIs changed with no input change.
- **Suspected cause (suspected):** Obligations are re-extracted by the LLM on every run and have no stable IDs or caching. Verdicts come from a single non-deterministic sample. I did not verify that the repo snapshot hash was identical for both runs; it is shown only in the PDF.
- **Why it matters:** For a compliance product, a finding that flips between Medium and Critical with no change destroys trust and makes trend lines and "fixed" tracking meaningless.

### DEF-002 · User-menu items are nearly invisible — S2 · Accessibility / UI · Always 2/2
- **Where:** Avatar menu (top right), on any page
- **Steps:** 1. Click the avatar. 2. Look at "Manage account" and "Sign out".
- **Expected:** Readable text with at least 4.5:1 contrast.
- **Actual:** The text is `rgba(0,0,0,0.62)` on a `rgb(17,24,39)` background, roughly 1.1:1. "Sign out" can barely be seen.
- **Suspected cause (confirmed from computed styles):** The Clerk `UserButton` appearance has no dark theme (`@clerk/themes` dark or `appearance.variables`) while the app is dark.

### DEF-003 · Code evidence shows secrets from the scanned repo verbatim — S2 · Security · Always
- **Where:** /runs/21 → GDPR Art. 32 finding → evidence `src/config.js:4-17`
- **Steps:** 1. Open Run #21. 2. Expand the `src/config.js` evidence.
- **Expected:** Values that look like credentials (passwords, JWT secrets, API keys) are masked in the UI and the PDF.
- **Actual:** The DB password and JWT signing secret appear in clear text. They are dummy values in the demo repo, but with a real customer repo the product would copy live secrets into its database, UI and the PDF reports it shares.
- **Suggested fix:** Run a secret-redaction pass (gitleaks/trufflehog patterns or entropy checks) on evidence snippets before storing or rendering them.

### DEF-004 · Running run says "This run produced no findings" and never refreshes — S3 · Functional / UX · 1/1
- **Where:** /runs/22 while status = Running
- **Steps:** 1. Queue an audit. 2. Open the new run while it is running. 3. Wait 20 seconds or more.
- **Expected:** An "Audit in progress…" state, with auto-refresh or polling until the run finishes.
- **Actual:** All counters show 0 and the page says "This run produced no findings", which reads as a completed clean run. The page did not update after 20 seconds; the user has to reload manually. The Runs list also does not poll.

### DEF-005 · Server refresh after a Settings change returns 503 — S3 · Console / Network · Always 3/3
- **Where:** /settings, toggle or Reset on any source
- **Steps:** 1. Toggle SEC. 2. Watch the network log.
- **Expected:** `PUT /api/settings/sources/sec → 200`, then the RSC refresh → 200.
- **Actual:** The PUT returns 200, but `GET /settings?_rsc=bc0vx → 503` every time (toggle on, toggle off, Reset). The UI still looks right because of client state, and the change persists. A manual `fetch('/settings?_rsc=bc0vx', {headers:{RSC:'1'}})` returned 200.
- **Suspected cause (suspected):** `router.refresh()` sends headers (e.g. `Next-Router-State-Tree`) that make the Settings server render fail. Check the Vercel function logs for that request ID.

### DEF-006 · Regulation citations labelled "Chunk 679" / "Chunk 686" — S3 · Content · Always
- **Where:** Run #21, findings for FCA PS21/3 and MAS Notice 655
- **Expected:** A human citation such as "SYSC 15A.2" or "Clause 4.1".
- **Actual:** The summary label falls back to the internal retrieval chunk ID. The expanded text is correct.

### DEF-007 · Inconsistent effective-date format on Rules — S4 · Content
- **Where:** /rules. GDPR (eur-lex) shows "25 May 2018" while every other rule uses ISO "2024-08-02". The corrigendum shows "—".

### DEF-008 · Unknown runs return HTTP 200 (soft 404) — S4 · Network
- **Where:** /runs/18, /runs/9999, /runs/abc, /runs/-1. Each renders "404 · That page or run doesn't exist." with status **200**. `/nonexistent-page` correctly returns 404.
- **Fix:** Call `notFound()` in the run page when the lookup misses.

### DEF-009 · Missing or duplicate accessible names — S4 · Accessibility
- At narrow widths the nav is icon-only. The icons have aria-labels but no visible tooltip, and the logo link has **no accessible name**.
- Settings has six buttons all named "Reset", with no source context. Use `aria-label="Reset SEC to default"`.
- The avatar alt text reads "Girish Hiremath's logo" (Clerk's default).

### DEF-010 · Clerk running with development keys — S4 · Config
- Console: `Clerk has been loaded with development keys…`. The user menu shows "Development mode". This is fine for a demo but blocks production (strict usage limits).

## 4. Console & network health
| Page | Console errors | Console warnings | Failed requests |
|---|---|---|---|
| /overview | 0 | 1 (Clerk dev keys) | none |
| /runs, /runs/21, /runs/22 | 0 | 1 | none |
| /rules | 0 | 1 | none |
| /settings | 0 | 1 | `GET /settings?_rsc=… → 503` after every change (DEF-005) |
| /api/reports/* | – | – | Correct 400/404 JSON for bad IDs |

## 5. Observations (not defects)
- **Duplicate cron fires:** #5 (06:00, Completed) was followed by #6 (06:01, Skipped), and #10 / #11 (06:00 and 06:01, both Skipped). The scheduler appears to trigger twice each morning.
- **Run ID gaps:** #16 and #18–#20 do not exist. The list says "20 most recent" but shows 18. Failed or aborted runs seem to vanish; consider showing them with a Failed status.
- **Cost shows $0.000 on runs that produced findings** (#5, #7, #8, #9, #12, #13). Cost tracking may be missing, or the results were cached; worth labelling.
- **"—" vs "0"** in the Critical column (#13 has 3 violations, critical "—"; #14 has 0, "—"). Pick one.
- **Overview KPIs** reflect only the latest run, while the subtitle says "48 rules tracked across 18 audit runs". Label the cards "Latest run (#22)".
- **Compliant = 0** in every run, including obligations the text says are met (TLS/HSTS). Check whether "Compliant" is ever emitted.
- **Rules page:** 48 rows with no search, filter or sort. 24 of 48 are "Not yet" audited. There are duplicates (Regulation S-P ×2, GDPR ×3), and non-binding news items are tracked as "rules" (ESMA press releases, "New Q&As available"). "Last changed" shows the scrape time, not the regulatory change date.
- **Settings:** Reset gives no confirmation and doesn't say what the default is (SEC Reset turned it ON). Server dependency notes ("needs Chromium (Playwright) and pdftotext") are shown to end users. MAS has 0 rules and was never checked.
- **Demo rules checkbox** has no explanation and resets to checked on navigation.
- **Run audit** re-enables right after queueing, so repeated clicks could queue several paid runs. Consider a "Run in progress" lock or server-side dedupe. Not tested, to avoid cost.
- **Run detail** with 35+ findings has no filter by severity, verdict or regulation.
- **Mobile:** the runs table scrolls horizontally inside its card with no scroll cue, so the Violations/Critical/Report columns sit off-screen.

## 6. Needs investigation
- Whether DEF-001 drift persists when the repo snapshot hash is confirmed identical. Compare the "Audited snapshot" line in the run-21 and run-22 PDFs.
- Whether DEF-003 secrets also appear in the PDF report (only the UI was checked).

## 7. Not run / out of scope
- Audit with "Demo rules" **unchecked** (live scraped rules). Skipped to avoid about $2 of model cost (Run #17 cost $2.02).
- Double-click or duplicate-submit of Run audit (cost).
- Sign out / Manage account flows (they would end the session).
- Scraper execution and cron behaviour beyond what the run history shows.
- Real-device mobile testing, and a full WCAG contrast audit beyond the user menu.

## 8. Recommended next actions
1. **DEF-001:** Persist extracted obligations per rule version (stable IDs, re-extract only when the rule text hash changes). Run verdicts at temperature 0 or with a 3-sample majority, and show a "changed since last run" diff.
2. **DEF-003:** Add secret redaction to evidence before storage and rendering, including the PDF.
3. **DEF-002:** Apply the Clerk dark theme. **DEF-004:** Add a running state with polling. **DEF-005:** Investigate the RSC 503 in the Vercel logs.
4. Quick wins: DEF-006/007/008/009 and dedupe the cron trigger.
5. Turn these into Playwright tests: DEF-008 (status code), DEF-004 (running-state copy), DEF-002 (contrast via axe), DEF-005 (no 5xx after a settings toggle), RPT-02/03 (report access and error contracts).
6. Record OV-01 → RUN-01 → RPT-01 as a daily smoke shortcut in Claude in Chrome.

---
*Generated by a browser agent under human supervision. Results reflect only what was observed during this session.*
