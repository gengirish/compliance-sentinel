import { expect, test, type Page } from "@playwright/test";

// The runs list against the mock's 30 runs (tests/e2e/mock-runs.mjs). Other tests may queue a
// run or two first, so totals are read from the page rather than assumed.

const rows = (page: Page) => page.locator("tbody tr");
const pagerText = (page: Page) => page.getByRole("navigation", { name: "Pages" }).locator("p");

/** "Showing 1–25 of 31 runs" → 31. */
async function totalRuns(page: Page): Promise<number> {
  const text = (await pagerText(page).textContent()) ?? "";
  const match = text.match(/of (\d+) runs/);
  expect(match, text).not.toBeNull();
  return Number(match![1]);
}

/** The cost column as numbers, top to bottom. */
async function costs(page: Page): Promise<number[]> {
  const cells = await rows(page).locator("td:nth-child(7)").allTextContents();
  return cells.map((c) => Number(c.replace("$", "")));
}

test("filters by status and trigger through the URL, and back restores the previous filter", async ({ page }) => {
  await page.goto("/runs");
  await expect(rows(page)).toHaveCount(25);

  await page.getByRole("link", { name: "Completed", exact: true }).click();
  await expect(page).toHaveURL(/\/runs\?status=completed$/);
  await expect(page.getByRole("link", { name: "Completed", exact: true })).toHaveAttribute("aria-current", "true");
  await expect(page.getByText(/runs? match(es)? these filters/)).toBeVisible();
  const completed = await totalRuns(page);
  await expect(rows(page)).toHaveCount(completed);
  for (const row of await rows(page).all()) await expect(row.getByText("Completed")).toBeVisible();

  // A second chip narrows within the first: the mock's five completed pull request runs.
  await page.getByRole("link", { name: "Pull request", exact: true }).click();
  await expect(page).toHaveURL(/status=completed&trigger=pull_request/);
  await expect(rows(page)).toHaveCount(5);
  for (const row of await rows(page).all()) {
    await expect(row.getByText("Completed")).toBeVisible();
    await expect(row.getByText("Pull request")).toBeVisible();
  }

  await page.goBack();
  await expect(page).toHaveURL(/\/runs\?status=completed$/);
  await expect(rows(page)).toHaveCount(completed);
  await expect(page.getByRole("link", { name: "Pull request", exact: true })).not.toHaveAttribute("aria-current", "true");

  await page.getByRole("link", { name: "Clear" }).click();
  await expect(page).toHaveURL(/\/runs$/);
  await expect(rows(page)).toHaveCount(25);
});

test("Critical only keeps the runs with a critical violation", async ({ page }) => {
  await page.goto("/runs");
  await page.getByRole("link", { name: "Critical only" }).click();
  await expect(page).toHaveURL(/critical=1/);
  // Each remaining row shows a critical count, never the dash of a run without one.
  await expect(rows(page).first()).toBeVisible();
  for (const row of await rows(page).all()) await expect(row.locator("td:nth-child(6)")).toHaveText(/^[1-9]\d*$/);
});

test("filters by start date and by repository", async ({ page }) => {
  await page.goto("/runs");
  // The date and select controls only write the URL once hydrated.
  await page.waitForLoadState("networkidle");
  // #50 started on 2026-10-01 and #51 the day before.
  await page.getByLabel("Started from").fill("2026-10-01");
  await expect(page).toHaveURL(/from=2026-10-01/);
  await expect(page.getByRole("link", { name: "#50" })).toBeVisible();
  await expect(page.getByRole("link", { name: "#51" })).toHaveCount(0);

  await page.getByLabel("Started to").fill("2026-10-01");
  await expect(page).toHaveURL(/from=2026-10-01&to=2026-10-01/);
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByLabel("Started to")).toHaveValue("2026-10-01");

  await page.getByRole("link", { name: "Clear" }).click();
  await expect(page).toHaveURL(/\/runs$/);
  await page.getByLabel("Repository").selectOption({ label: "Repository #7" });
  await expect(page).toHaveURL(/repo=7/);
  // The mock's repo 7 runs are the even ids from #40.
  for (const link of await rows(page).locator("td:first-child a").allTextContents()) {
    expect(Number(link.slice(1)) % 2, link).toBe(0);
  }
  await expect(page.getByLabel("Repository")).toHaveValue("7");
});

test("sorts by a column header in both directions", async ({ page }) => {
  await page.goto("/runs");
  const cost = page.getByRole("columnheader", { name: "Cost" });
  await expect(cost).toHaveAttribute("aria-sort", "none");
  await expect(page.getByRole("columnheader", { name: "Started" })).toHaveAttribute("aria-sort", "descending");

  await cost.getByRole("link").click();
  await expect(page).toHaveURL(/sort=cost&order=desc/);
  await expect(cost).toHaveAttribute("aria-sort", "descending");
  const down = await costs(page);
  expect(down).toEqual([...down].sort((a, b) => b - a));

  await cost.getByRole("link").click();
  await expect(page).toHaveURL(/sort=cost&order=asc/);
  await expect(cost).toHaveAttribute("aria-sort", "ascending");
  const up = await costs(page);
  expect(up).toEqual([...up].sort((a, b) => a - b));

  await page.goBack();
  await expect(cost).toHaveAttribute("aria-sort", "descending");
});

test("pages through the runs, and back returns to the first page", async ({ page }) => {
  await page.goto("/runs");
  const total = await totalRuns(page);
  expect(total).toBeGreaterThan(25);
  await expect(pagerText(page)).toHaveText(`Showing 1–25 of ${total} runs`);
  await expect(page.getByRole("link", { name: "Previous page" })).toHaveCount(0);

  await page.getByRole("link", { name: "Next page" }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(pagerText(page)).toHaveText(`Showing 26–${total} of ${total} runs`);
  await expect(rows(page)).toHaveCount(total - 25);
  // The oldest run is last.
  await expect(rows(page).last().getByRole("link", { name: "#66" })).toBeVisible();

  // Sorting from page 2 starts again at page 1.
  await page.getByRole("columnheader", { name: "Violations" }).getByRole("link").click();
  await expect(page).toHaveURL(/sort=violations/);
  await expect(page).not.toHaveURL(/page=/);

  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/\/runs$/);
  await expect(pagerText(page)).toHaveText(`Showing 1–25 of ${total} runs`);
});

test("a filter that matches nothing says so and offers Clear", async ({ page }) => {
  await page.goto("/runs?status=skipped&critical=1");
  await expect(page.getByText("No runs match these filters")).toBeVisible();
  await expect(page.locator("table")).toHaveCount(0);

  await page.getByRole("link", { name: "Clear" }).first().click();
  await expect(page).toHaveURL(/\/runs$/);
  await expect(rows(page)).toHaveCount(25);
});

test("unknown values in the URL show the default view instead of an error", async ({ page }) => {
  await page.goto("/runs?status=bogus&sort=name&page=-1&from=yesterday");
  await expect(rows(page)).toHaveCount(25);
  await expect(page.getByRole("columnheader", { name: "Started" })).toHaveAttribute("aria-sort", "descending");
});
