import { expect, test } from "@playwright/test";

// The mock API (tests/e2e/mock-rules.mjs) has 61 rules: the demo rule, 59 numbered notices from
// three sources and one MiCA rule from ESMA.

test("rules page pages at 50 and sorts by a column", async ({ page }) => {
  await page.goto("/rules");
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(50);
  await expect(page.getByRole("status")).toHaveText("Showing 1–50 of 61 rules");
  await expect(rows.first()).toContainText("Demo Safeguards Rule");

  await page.getByRole("link", { name: "Next page" }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(rows).toHaveCount(11);
  await expect(page.getByRole("status")).toHaveText("Showing 51–61 of 61 rules");

  // Sorting goes back to page 1; the first click on Rule sorts A to Z.
  const ruleHeader = page.getByRole("columnheader", { name: "Rule" });
  await ruleHeader.getByRole("link").click();
  await expect(page).toHaveURL(/sort=title&order=asc/);
  await expect(page).not.toHaveURL(/page=/);
  await expect(ruleHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(rows.first()).toContainText("Demo Safeguards Rule");

  await ruleHeader.getByRole("link").click();
  await expect(page).toHaveURL(/sort=title&order=desc/);
  await expect(ruleHeader).toHaveAttribute("aria-sort", "descending");
  await expect(rows.first()).toContainText("MiCA crypto-asset guidelines");

  // First seen is a sortable column too; the MiCA rule was seen first.
  await page.getByRole("columnheader", { name: "First seen" }).getByRole("link").click();
  await page.getByRole("columnheader", { name: "First seen" }).getByRole("link").click();
  await expect(page).toHaveURL(/sort=first_seen&order=asc/);
  await expect(rows.first()).toContainText("MiCA crypto-asset guidelines");
});

test("rules can be searched and filtered by source, cleared, and the back button restores them", async ({ page }) => {
  await page.goto("/rules");
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(50);

  // Search matches the external id as well as the title.
  await page.getByRole("searchbox", { name: "Search rules" }).fill("mica-7");
  await expect(page).toHaveURL(/q=mica-7/);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("MiCA crypto-asset guidelines");

  await page.getByRole("searchbox", { name: "Search rules" }).fill("nothing like this");
  await expect(page.getByText("No rules match these filters")).toBeVisible();
  await page.getByRole("searchbox", { name: "Search rules" }).fill("");
  await expect(rows).toHaveCount(50);

  // Source chips are multi-select; ESMA has 19 notices plus the MiCA rule.
  const sources = page.getByRole("group", { name: "Source" });
  await sources.getByRole("link", { name: "esma" }).click();
  await expect(page).toHaveURL(/source=esma/);
  await expect(page.getByRole("status")).toHaveText("Showing 1–20 of 20 rules");
  await expect(sources.getByRole("link", { name: "esma" })).toHaveAttribute("aria-current", "true");

  await page.getByRole("group", { name: "Changed within" }).getByRole("link", { name: "7d" }).click();
  await expect(page).toHaveURL(/changed=7/);
  await expect(page.getByRole("status")).toHaveText("Showing 1–19 of 19 rules");

  await page.getByLabel("Audited").selectOption("no");
  await expect(page).toHaveURL(/audited=no/);
  await expect(page.getByRole("status")).toHaveText("Showing 1–14 of 14 rules");
  await expect(page.getByText("Not yet")).toHaveCount(14);

  // Back undoes the last filter only.
  await page.goBack();
  await expect(page).not.toHaveURL(/audited=/);
  await expect(page.getByRole("status")).toHaveText("Showing 1–19 of 19 rules");
  await expect(page.getByLabel("Audited")).toHaveValue("");

  await page.getByRole("link", { name: "Clear" }).first().click();
  await expect(page).toHaveURL(/\/rules$/);
  await expect(page.getByRole("status")).toHaveText("Showing 1–50 of 61 rules");

  await page.goBack();
  await expect(page).toHaveURL(/source=esma/);
  await expect(page.getByRole("status")).toHaveText("Showing 1–19 of 19 rules");
});

test("an effective-date range and a smaller page size come from the URL", async ({ page }) => {
  await page.goto("/rules?from=2025-06-01&to=2025-06-30&limit=25");
  await expect(page.getByLabel("Effective from")).toHaveValue("2025-06-01");
  await expect(page.getByLabel("Effective to")).toHaveValue("2025-06-30");
  const rows = page.locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  for (const cell of await page.locator("tbody tr td:nth-child(3)").allTextContents()) {
    expect(cell >= "2025-06-01" && cell <= "2025-06-30", cell).toBe(true);
  }

  // A hand-edited URL with values the API would reject shows the default view, not an error.
  await page.goto("/rules?sort=popularity&audited=maybe&limit=7&page=-1");
  await expect(page.getByRole("status")).toHaveText("Showing 1–50 of 61 rules");
});
