import { expect, test, type Page } from "@playwright/test";

// The mock API serves all eight sources from mock-sources.mjs: on are Federal Register, SEC
// (set here) and FCA; off are FINRA, ESMA (set here), ASIC, EUR-Lex and MAS.

/** Source names in the order the settings page lists them. */
const listed = (page: Page) => page.getByRole("listitem").locator("a[target=_blank]").allInnerTexts();

test("settings filters sources by state and region, and Clear resets them", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("listitem")).toHaveCount(8);

  await page.getByRole("group", { name: "Filter by state" }).getByRole("link", { name: /^Off/ }).click();
  await expect(page).toHaveURL(/\/settings\?state=off$/);
  await expect(page.getByRole("listitem")).toHaveCount(5);
  await expect(page.getByText("5 of 8 sources")).toBeVisible();

  await page.getByRole("group", { name: "Filter by region" }).getByRole("link", { name: /^EU/ }).click();
  await expect(page).toHaveURL(/state=off&region=EU$/);
  expect(await listed(page)).toEqual(["ESMA", "EUR-Lex"]);

  await page.getByRole("group", { name: "Filter by where the switch is set" }).getByRole("link", { name: /^Set here/ }).click();
  await expect(page).toHaveURL(/set=here/);
  expect(await listed(page)).toEqual(["ESMA"]);

  // Off and in the UK matches nothing.
  await page.goto("/settings?state=off&region=UK");
  await expect(page.getByText("No sources match these filters")).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveCount(0);

  await page.getByRole("link", { name: "Clear" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("listitem")).toHaveCount(8);
  await expect(page.getByRole("link", { name: "Clear" })).toHaveCount(0);
});

test("settings sorts sources, and back restores the previous view", async ({ page }) => {
  await page.goto("/settings");
  // Name, A–Z, is the default.
  expect(await listed(page)).toEqual(["ASIC", "ESMA", "EUR-Lex", "FCA", "Federal Register", "FINRA", "MAS", "SEC"]);

  const sorts = page.getByRole("group", { name: "Sort sources" });
  await sorts.getByRole("link", { name: /Rules collected/ }).click();
  await expect(page).toHaveURL(/sort=rules&order=desc/);
  expect((await listed(page)).slice(0, 4)).toEqual(["Federal Register", "FCA", "SEC", "ESMA"]);

  await sorts.getByRole("link", { name: /Last checked/ }).click();
  await expect(page).toHaveURL(/sort=checked&order=desc/);
  // Latest check first; the three never checked come last, by name.
  expect(await listed(page)).toEqual(["Federal Register", "SEC", "FCA", "ESMA", "EUR-Lex", "ASIC", "FINRA", "MAS"]);

  // A second click reverses the order, but never-checked sources still sort last.
  await sorts.getByRole("link", { name: /Last checked/ }).click();
  await expect(page).toHaveURL(/sort=checked&order=asc/);
  expect(await listed(page)).toEqual(["EUR-Lex", "ESMA", "FCA", "SEC", "Federal Register", "ASIC", "FINRA", "MAS"]);

  await sorts.getByRole("link", { name: /Region/ }).click();
  await expect(page).toHaveURL(/sort=region&order=asc/);
  expect((await listed(page))[0]).toBe("ASIC");

  await page.goBack();
  await expect(page).toHaveURL(/sort=checked&order=asc/);
  await expect.poll(() => listed(page)).toEqual(["EUR-Lex", "ESMA", "FCA", "SEC", "Federal Register", "ASIC", "FINRA", "MAS"]);
  // Active chips say so in their accessible name rather than with aria-current.
  await expect(sorts.getByRole("link", { name: /Last checked.*ascending.*\(filter on\)/ })).toBeVisible();
});

test("flipping a switch keeps the filters in the URL", async ({ page }) => {
  await page.goto("/settings?region=SG,AU");
  await expect(page.getByRole("listitem")).toHaveCount(2);
  const mas = page.getByRole("switch", { name: "Scrape MAS" });
  await expect(mas).toHaveAttribute("aria-checked", "false");

  await mas.click();
  await expect(mas).toHaveAttribute("aria-checked", "true");
  const row = page.getByRole("listitem").filter({ hasText: "MAS" });
  await expect(row.getByText("Set here")).toBeVisible();
  // The switch reloads the page after saving; the reload keeps the URL, so the filtered view survives.
  await expect(page).toHaveURL(/\/settings\?region=SG(%2C|,)AU$/);
  await expect(page.getByRole("listitem")).toHaveCount(2);

  // Put MAS back on its default for the other tests.
  await row.getByRole("button", { name: "Reset" }).click();
  await expect(mas).toHaveAttribute("aria-checked", "false");
  await expect(row.getByText("Default")).toBeVisible();
  await expect(page).toHaveURL(/region=SG(%2C|,)AU$/);
});

test("the every-source-off warning looks at all sources, not the filtered ones", async ({ page }) => {
  // Every source shown is off, but three others are on, so there is nothing to warn about.
  await page.goto("/settings?state=off");
  await expect(page.getByRole("listitem")).toHaveCount(5);
  await expect(page.getByText(/Every source is off/)).toHaveCount(0);
});

test("overview tiles link to the latest run, filtered to what they count", async ({ page }) => {
  const rsc: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("_rsc=")) rsc.push(new URL(r.url()).search);
  });
  await page.goto("/overview");
  await page.waitForLoadState("networkidle");
  // The tiles are not prefetched (DEF-004).
  expect(rsc.filter((u) => /status=/.test(u))).toEqual([]);

  const tiles = page.getByRole("region", { name: "Findings from run 1" });
  for (const [label, href] of [
    ["Violations", "/runs/1?status=violation"],
    ["Critical violations", "/runs/1?status=violation&severity=critical"],
    ["Needs review", "/runs/1?status=needs_review"],
    ["Compliant", "/runs/1?status=compliant"],
  ]) {
    await expect(tiles.getByRole("link", { name: new RegExp(`^${label}`) })).toHaveAttribute("href", href);
  }

  await tiles.getByRole("link", { name: /^Critical violations/ }).click();
  await expect(page).toHaveURL(/\/runs\/1\?status=violation&severity=critical$/);
  await expect(page.locator("article")).toHaveCount(1);
});

test("overview summary links to rules and runs", async ({ page }) => {
  await page.goto("/overview");
  await expect(page.getByRole("link", { name: "1 rules" })).toHaveAttribute("href", "/rules");
  await page.getByRole("link", { name: "1 audit runs" }).click();
  await expect(page).toHaveURL(/\/runs$/);
});
