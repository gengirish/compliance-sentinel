import { expect, test, type Page } from "@playwright/test";

// Run 90 of the mock API (tests/e2e/mock-findings.mjs): eight findings across three rules.
const RUN = "/runs/90";

const titles = (page: Page) => page.locator("article h3");
const ruleSelect = (page: Page) => page.getByRole("combobox", { name: /^Rule/ });
const pathBox = (page: Page) => page.getByRole("searchbox", { name: /^File path starts with/ });
const searchBox = (page: Page) => page.getByRole("searchbox", { name: /^Search findings/ });
const sortSelect = (page: Page) => page.getByRole("combobox", { name: /^Sort by/ });

test("findings filter by rule", async ({ page }) => {
  await page.goto(RUN);
  await expect(page.locator("article")).toHaveCount(8);
  await expect(ruleSelect(page).locator("option")).toHaveText(["All rules", "Access Control Rule", "Encryption Rule", "Logging Rule"]);

  await ruleSelect(page).selectOption({ label: "Encryption Rule" });
  await expect(page).toHaveURL(/[?&]rule=12(&|$)/);
  await expect(titles(page)).toHaveText(["Encrypt card numbers at rest", "Rotate encryption keys", "Use TLS for API calls"]);
  // The select still offers every rule of the run, and the chips still count the whole run.
  await expect(ruleSelect(page).locator("option")).toHaveCount(4);
  await expect(page.getByRole("link", { name: /^Violation/ })).toContainText("4");
  await expect(page.getByText("3 of 8 findings")).toBeVisible();
});

test("findings filter by file path prefix, combined with a chip", async ({ page }) => {
  await page.goto(RUN);
  await pathBox(page).fill("src/payments");
  await expect(page).toHaveURL(/[?&]path=src%2Fpayments/);
  await expect(titles(page)).toHaveText(["Encrypt card numbers at rest", "Restrict refund approvals", "Log payment attempts"]);

  await page.getByRole("link", { name: /^Violation/ }).click();
  await expect(page).toHaveURL(/status=violation/);
  await expect(page).toHaveURL(/path=src%2Fpayments/);
  await expect(titles(page)).toHaveText(["Encrypt card numbers at rest"]);
});

test("findings search the obligation and rationale", async ({ page }) => {
  await page.goto(RUN);
  await searchBox(page).fill("session");
  await expect(page).toHaveURL(/[?&]q=session/);
  await expect(titles(page)).toHaveText(["Expire idle sessions"]);

  await searchBox(page).fill("nothing like this");
  await expect(page.getByText("No findings match these filters")).toBeVisible();
  await page.getByRole("link", { name: "Clear" }).last().click();
  await expect(page).toHaveURL(new RegExp(`${RUN}$`));
  await expect(page.locator("article")).toHaveCount(8);
  await expect(searchBox(page)).toHaveValue("");
});

test("findings sort by severity by default, and by rule or file", async ({ page }) => {
  await page.goto(RUN);
  // Critical first; within critical, the violation before the one needing review.
  await expect(titles(page).first()).toHaveText("Encrypt card numbers at rest");
  await expect(titles(page).nth(1)).toHaveText("Restrict refund approvals");
  await expect(sortSelect(page)).toHaveValue("severity");

  await sortSelect(page).selectOption({ label: "Rule" });
  await expect(page).toHaveURL(/sort=rule&order=asc/);
  // Access Control Rule first, worst first within it.
  await expect(titles(page).first()).toHaveText("Restrict refund approvals");

  await page.getByRole("button", { name: /switch to descending/ }).click();
  await expect(page).toHaveURL(/sort=rule&order=desc/);
  await expect(titles(page).first()).toHaveText("Retain audit logs for a year");

  await sortSelect(page).selectOption({ label: "File" });
  await expect(page).toHaveURL(/sort=path&order=asc/);
  await expect(titles(page).first()).toHaveText("Retain audit logs for a year"); // infra/logging.tf
  await expect(titles(page).last()).toHaveText("Rotate encryption keys"); // no evidence

  // Back to the default sort leaves the URL clean.
  await sortSelect(page).selectOption({ label: "Severity" });
  await expect(page).toHaveURL(new RegExp(`${RUN}$`));
});

test("Clear resets every filter and the sort", async ({ page }) => {
  await page.goto(`${RUN}?status=violation&rule=11&path=src%2Fauth&q=admin&sort=path&order=desc`);
  await expect(titles(page)).toHaveText(["Require MFA for admin access"]);
  await expect(ruleSelect(page)).toHaveValue("11");
  await expect(pathBox(page)).toHaveValue("src/auth");

  await page.getByRole("link", { name: "Clear" }).click();
  await expect(page).toHaveURL(new RegExp(`${RUN}$`));
  await expect(page.locator("article")).toHaveCount(8);
  await expect(ruleSelect(page)).toHaveValue("");
  await expect(pathBox(page)).toHaveValue("");
  await expect(searchBox(page)).toHaveValue("");
  await expect(sortSelect(page)).toHaveValue("severity");
  await expect(page.getByRole("link", { name: "Clear" })).toHaveCount(0);
});

test("back restores the previous findings view", async ({ page }) => {
  await page.goto(RUN);
  await ruleSelect(page).selectOption({ label: "Access Control Rule" });
  await expect(page.locator("article")).toHaveCount(3);
  await page.getByRole("link", { name: /^Critical/ }).click();
  await expect(titles(page)).toHaveText(["Restrict refund approvals"]);

  await page.goBack();
  await expect(page).toHaveURL(/[?&]rule=11$/);
  await expect(page.locator("article")).toHaveCount(3);
  await expect(ruleSelect(page)).toHaveValue("11");

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${RUN}$`));
  await expect(page.locator("article")).toHaveCount(8);
  await expect(ruleSelect(page)).toHaveValue("");
});

test("the overview's critical violations link still filters the run", async ({ page }) => {
  await page.goto("/runs/1?status=violation&severity=critical");
  await expect(titles(page)).toHaveText(["Encrypt customer data at rest"]);
  // Active chips say so in their accessible name rather than with aria-current.
  await expect(page.getByRole("link", { name: /^Violation.*\(filter on\)$/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Critical.*\(filter on\)$/ })).toBeVisible();
});

test("a hand-edited URL with bad values shows the default view", async ({ page }) => {
  await page.goto(`${RUN}?sort=bogus&order=sideways&rule=abc&status=open`);
  await expect(page.locator("article")).toHaveCount(8);
  await expect(titles(page).first()).toHaveText("Encrypt card numbers at rest");
});
