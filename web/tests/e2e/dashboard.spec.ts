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
  await expect(page.getByRole("status")).toContainText("Audit queued.");
  // The queue's job id is not a run number, so it must not be shown as one.
  await expect(page.getByRole("status")).not.toContainText("e2e-job");
});

test("a triggered audit reaches Completed on the runs list without a reload", async ({ page }) => {
  await page.goto("/runs");
  const newest = page.getByRole("row").nth(1);
  const before = await newest.getByRole("link").first().textContent();

  await page.getByRole("button", { name: "Run audit" }).click();
  await expect(page.getByRole("status")).toContainText("Audit queued");
  // The new run appears and finishes with no page.reload(): the page polls while it is in progress.
  await expect(newest.getByRole("link").first()).not.toHaveText(before!);
  await expect(newest.getByText("Completed")).toBeVisible({ timeout: 25_000 });
  await expect(page.getByRole("status")).toBeEmpty();
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

  await row.getByRole("link", { name: "#2" }).click();
  await expect(page.getByText(/Timed out: still running after 30 minutes/)).toBeVisible();
});

test("run links and filter chips are not prefetched", async ({ page }) => {
  const rsc: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("_rsc=")) rsc.push(new URL(r.url()).pathname + new URL(r.url()).search);
  });

  await page.goto("/runs/1");
  await page.waitForLoadState("networkidle");
  await page.goto("/runs");
  await page.waitForLoadState("networkidle");

  // Only the handful of nav links may prefetch, never one request per row or chip.
  expect(rsc.filter((u) => /status=|severity=/.test(u))).toEqual([]);
  expect(rsc.filter((u) => /^\/runs\/\d+/.test(u))).toEqual([]);
});

test("a skipped run says why, and shows — rather than blank counts", async ({ page }) => {
  await page.goto("/runs");
  const row = page.getByRole("row", { name: /#3/ });
  await expect(row.getByText("Skipped")).toBeVisible();
  await expect(row.getByRole("cell").filter({ hasText: "Skipped" })).toHaveAttribute("title", /No new or amended rules/);
  await expect(row.getByText("—")).toHaveCount(2);

  await row.getByRole("link", { name: "#3" }).click();
  await expect(page.getByText("No new or amended rules since the last check")).toBeVisible();
});
