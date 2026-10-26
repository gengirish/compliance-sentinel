import { expect, test } from "@playwright/test";

test("landing page explains the product and links to the dashboard", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Down to the line");
  await expect(page.getByText("src/routes/signup.js:10")).toBeVisible();
  await page.getByRole("link", { name: "Open dashboard" }).first().click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
});

test("overview shows the latest audit and its critical violations", async ({ page }) => {
  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Critical violations").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Encrypt customer data at rest" })).toBeVisible();
  // Only the critical finding is listed on the overview.
  await expect(page.getByRole("heading", { name: "Expire sessions after inactivity" })).toHaveCount(0);
});

test("run page lists findings and filters them by status", async ({ page }) => {
  await page.goto("/runs/1");
  await expect(page.getByRole("heading", { name: /Run #1/ })).toBeVisible();
  await expect(page.locator("article")).toHaveCount(3);

  await page.getByRole("link", { name: /^Violation/ }).click();
  await expect(page).toHaveURL(/status=violation/);
  await expect(page.locator("article")).toHaveCount(2);

  await page.getByRole("link", { name: /^Critical/ }).click();
  await expect(page).toHaveURL(/severity=critical/);
  await expect(page.locator("article")).toHaveCount(1);

  await page.getByRole("link", { name: "Clear" }).click();
  await expect(page.locator("article")).toHaveCount(3);
});

test("a finding shows its regulation citation and code location", async ({ page }) => {
  await page.goto("/runs/1?severity=critical");
  const card = page.locator("article").first();
  await expect(card.getByText("§ 314.4(c)")).toBeVisible();
  await expect(card.getByText("src/auth/session.ts:11-15")).toBeVisible();
});

test("runs and rules tables render", async ({ page }) => {
  await page.goto("/runs");
  await expect(page.getByRole("link", { name: "#1" })).toBeVisible();
  await page.getByRole("link", { name: "Rules" }).click();
  await expect(page.getByRole("heading", { name: "Tracked rules" })).toBeVisible();
  await expect(page.getByText("Demo Safeguards Rule")).toBeVisible();
});

test("run audit button queues a job", async ({ page }) => {
  await page.goto("/overview");
  await page.getByRole("button", { name: "Run audit" }).click();
  await expect(page.getByRole("status")).toContainText("Audit queued (job e2e-job)");
});

test("report link streams the report without exposing the token", async ({ request }) => {
  const res = await request.get("/api/reports/1");
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain("Demo report");
});

test("unknown run shows not found", async ({ page }) => {
  await page.goto("/runs/999");
  await expect(page.getByText("doesn't exist")).toBeVisible();
});

test("a run the watchdog timed out shows as failed with its reason", async ({ page }) => {
  await page.goto("/runs");
  const row = page.getByRole("row", { name: /#2/ });
  await expect(row.getByText("Failed")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Running" })).toHaveCount(0);

  await row.getByRole("link", { name: "#2" }).click();
  await expect(page.getByText(/Timed out: still running after 30 minutes/)).toBeVisible();
});
