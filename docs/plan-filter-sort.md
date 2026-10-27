# Plan: filtering and sorting on every dashboard screen

**Written 2026-10-27.** How to add filtering and sorting to each screen of the dashboard, against the code as it is today, in the order the PRs should land. It is independent of [plan-app-pr-review.md](plan-app-pr-review.md) and can go before or after A4.

---

## 0. Done when

| Screen | Yes/no check |
|---|---|
| Runs | Show only failed scheduled runs from last week, sorted by cost. Page past the first 25. Copy the URL into another tab: same list. |
| Run findings | On a run with 20+ findings, show the high and critical violations of one rule whose evidence is under `src/payments`, critical first. |
| Rules | Find a rule by part of its external id; show the ESMA rules changed in the last 30 days that were never audited, oldest first. |
| Settings | Show only the sources that are off, or only EU sources. |
| Overview | Every number on the page is a link to the list it counts, already filtered. |
| All | Back and forward restore the previous filter. A filter that matches nothing says so and offers **Clear**. Another tenant's data never appears under any filter. |

---

## 1. What the code says today

1. **Runs are capped at 20.** `GET /runs` in [src/web/server.ts](../src/web/server.ts) returns the newest 20 with no parameters, and the [runs page](../web/src/app/(dashboard)/runs/page.tsx) says so. Filtering or sorting only those 20 would hide matches, so the runs list needs paging before anything else.
2. **Finding counts are computed after the query.** `countFindings` groups findings for the run ids already fetched. Sorting runs by violations or critical count has to move that aggregate into the query as a subquery join.
3. **The run page already filters the right way.** Status and severity chips are links that rewrite the URL; the server page reads `searchParams` and the API filters (`FindingsQuery` in [schemas.ts](../src/web/schemas.ts)). Nothing is filtered in the browser. This is the pattern to copy: the URL is the state, so links can be shared, the back button works, and nothing needs client state.
4. **The rules list is unbounded.** `GET /rules` returns every rule (about 40 in production today, growing with every source switched on), ordered by `last_changed_at`.
5. **Settings has eight rows** and will not grow beyond the source catalog. It does not need the API involved.
6. **Severity has no natural sort order in SQL.** It is text; "critical first" needs a `CASE` expression. Same for status.
7. **Search must stay simple.** `ILIKE` on a few columns is enough at this size. `pg_trgm` would need an extension that PGlite (the GitHub Action's database) may not have, so it stays out until a list is slow.
8. **Tenancy.** Every filter is added inside the existing tenant `WHERE`, never instead of it. Each new parameter gets a cross-tenant test, as in the A2 tests in [tests/webApi.test.ts](../tests/webApi.test.ts).

---

## 2. Shared design

### URL contract

Every list reads the same parameters, so the parsing and the toolbar are written once:

| Parameter | Form | Example |
|---|---|---|
| Multi-value filters | comma list, validated against a fixed set | `status=failed,skipped` |
| Search | `q`, trimmed, at most 100 characters | `q=PCI` |
| Date range | `from`, `to` as `YYYY-MM-DD` (inclusive, UTC) | `from=2026-10-01` |
| Sort | `sort=<key>` from a per-list whitelist, `order=asc\|desc` | `sort=cost&order=desc` |
| Paging | `page` (1-based), `limit` (fixed choices: 25, 50, 100) | `page=2` |

Unknown values return 400 with the field named, as `commaList` already does. Defaults are left out of the URL, so a plain `/runs` is the default view.

### API

- One `ListQuery` builder in [schemas.ts](../src/web/schemas.ts) composes the pieces above, so each route declares its filters and sort keys in a few lines.
- Sort keys map to SQL columns or expressions in a per-route table; nothing from the URL is put into SQL as text. Every sort adds `id` as a tie-breaker, so pages are stable.
- Paged lists keep returning a JSON array, so the CLI, the e2e mock and older dashboards keep working, and add an `x-total-count` header. The dashboard reads the header to draw the pager and the "Showing 26–50 of 112" line.

### Dashboard

- `web/src/lib/list-params.ts`: parses `searchParams` into typed filters (the `pick` helper on the run page moves here), and builds hrefs that change one parameter and keep the rest.
- Components in `web/src/components/list/`:
  - `FilterChips`: the run page's chips, extracted.
  - `SearchBox`: a client component that updates `q` with `router.replace` after a 300 ms pause, so typing does not stack up history entries.
  - `SelectFilter` and `DateRange`: plain `<select>` and `<input type="date">`, styled like the chips.
  - `SortHeader`: a table header link that cycles the sort, with `aria-sort` set.
  - `Pager`: previous and next links plus the "Showing x–y of n" line, announced in an `aria-live` region.
  - `ClearFilters`: shown when any parameter is set.
- Filter links keep `prefetch={false}`, as the existing chips do (DEF-004), so a page full of links does not cost a server render each.
- On narrow screens the toolbar folds into a **Filters** disclosure with the active filter count, so tables keep their width.

---

## 3. Per screen

### F1. Runs (with the shared pieces)

- **Filters:**
  - Status: running, completed, skipped, failed.
  - Trigger: scheduled, manual, installed, pull request, push.
  - Started between two dates.
  - "Has critical violations".
  - Repository, a select shown once a tenant has more than one repo (A5 provides the list).
- **Sort:** started (default, newest first), duration, cost, violations, critical.
- **Paging:** 25 per page. The description changes from "The 20 most recent runs" to the result count.
- **API:** `ListRunsQuery` gains the parameters above. Counts become a `LEFT JOIN` on a grouped findings subquery, used both for sorting and for the existing `counts` field, which replaces the separate `countFindings` call on this route.
- **Index:** `audit_runs (tenant_id, started_at DESC)` in a small migration. The existing `(tenant_id, id DESC)` index still serves the default order.
- **Unchanged:** the run audit button's polling (`runStatuses`) keeps asking for the default first page.

### F2. Run findings

- **Filters:** the existing status and severity chips, plus:
  - Rule: a select of the rules that have findings in this run.
  - File: an evidence path prefix, such as `src/payments`.
  - Search `q`: matches the obligation or the rationale.
- **Sort:** severity (default, critical first, then violation before needs review), status, rule, file path.
- **API:** `FindingsQuery` gains `rule`, `path`, `q`, `sort` and `order`. The path filter tests the `evidence` jsonb: `EXISTS (SELECT 1 FROM jsonb_array_elements(evidence) e WHERE e->>'path' LIKE $prefix || '%')`. No paging yet; a run has at most a few hundred findings. Add it when one goes over 200.
- **Chip counts:** the numbers on the chips stay the run's totals. They describe the run, not the current filter.

### F3. Rules

- **Filters:**
  - Search `q` over title and external id.
  - Source, multi-select from the source catalog plus the demo fixtures.
  - Audited: yes or no.
  - Changed since: 7, 30 or 90 days.
  - Effective-date range.
- **Sort:** last changed (default), first seen, effective date, title, source.
- **Paging:** 50 per page.
- **API:** `GET /rules` gains the parameters above. The tenant-scoped `last_audited` subquery stays as it is; "audited: no" is `last_audited.run_id IS NULL`.
- **Index:** `rules (last_changed_at DESC)`.

### F4. Settings and overview

- **Settings:** filtering happens in the browser, because the eight rows are already on the page.
  - Filters: on/off, region, and whether the source was set on this page.
  - Sort: name, region, rules collected, last checked.
  - The URL still holds the state, so the view can be shared.
- **Overview:** this is a summary page, so it gets links instead of controls.
  - Each tile links to the latest run filtered to what it counts. For example, Critical violations links to `/runs/:id?status=violation&severity=critical`.
  - The "N rules tracked across M audit runs" line links to `/rules` and `/runs`.
  - Once A5 has a tenant's repos, a repository select joins the header and scopes the tiles. Until then there is nothing to choose.

---

## 4. Tests

- **API** ([tests/webApi.test.ts](../tests/webApi.test.ts) and a new `tests/listQuery.test.ts`), per route:
  - each filter alone and combined;
  - each sort key in both directions;
  - paging boundaries and `x-total-count`;
  - 400 on unknown values;
  - another tenant's rows absent under every filter.
- **e2e** ([dashboard.spec.ts](../web/tests/e2e/dashboard.spec.ts)):
  - each screen: apply a filter, sort, page;
  - check that the URL changed, that back restores the previous view, and that **Clear** resets it.
  
  [mock-api.mjs](../web/tests/e2e/mock-api.mjs) implements the same parameters over its fixtures, with enough runs (30) to page.
- **Accessibility:** sort headers expose `aria-sort`, the result count is announced, and every control has a label. Checked with the existing Playwright run.

---

## 5. Order and size

| PR | Contents | Size |
|---|---|---|
| F1 | Shared URL contract, `ListQuery`, list components, runs screen, index migration | about 1.5 days |
| F2 | Findings filters and sort on the run page | about 1 day |
| F3 | Rules screen, index migration | about 1 day |
| F4 | Settings (browser-side) and overview links | about half a day |

Each PR ships on its own and leaves the other screens as they are. F1 is first because the other three reuse its pieces. F3 can share F1's migration if the two land together.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| A sort on a computed count is slow on a big tenant | Counts come from one grouped subquery over the page's tenant; measure with production data before adding a stored counter |
| Filters leak across tenants | Filters are added inside the tenant `WHERE`; one cross-tenant test per parameter |
| Search input floods the server | Debounced `router.replace`, `q` capped at 100 characters, `ILIKE` with escaped `%` and `_` |
| URLs saved before a change stop working | Unknown sort keys and filter values return 400 at the API, but the dashboard drops them and shows the default view instead of an error page |
| The paging header is lost through the Next.js proxy | Server components call the API directly (`apiFetch`), so the header never passes through a route handler; the e2e pager test catches a regression |

---

## 7. Open questions for you

1. **Saved views:** should a user be able to save a named filter, such as "my failed runs"? It needs a table and the user id from Clerk; this plan leaves it out.
2. **CSV export** of a filtered list: cheap on top of this (same query, different serializer). Worth adding to F1?
3. **Findings across runs:** a separate "All findings" screen filtered by rule, file and severity over every run. This is the natural next step after F2, but it is a new screen rather than filtering on an existing one.
