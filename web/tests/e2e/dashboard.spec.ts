import { expect, test } from "@playwright/test";

test("landing page explains the product and links to the dashboard", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Down to the line");
  await expect(page.getByText("schema.sql:49")).toBeVisible();
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

test("sources can be switched on and off, and reset to their default", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Regulatory sources" })).toBeVisible();
  const mas = page.getByRole("switch", { name: "Scrape MAS" });
  await expect(mas).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText(/needs Chromium/)).toBeVisible();

  await mas.click();
  await expect(mas).toHaveAttribute("aria-checked", "true");
  const row = page.getByRole("listitem").filter({ hasText: "MAS" });
  await expect(row.getByText("Set here")).toBeVisible();

  await row.getByRole("button", { name: "Reset" }).click();
  await expect(mas).toHaveAttribute("aria-checked", "false");
  await expect(row.getByText("Default")).toBeVisible();
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
  // The new run appears and finishes without the user reloading: the page polls while it is in progress.
  await expect(newest.getByRole("link").first()).not.toHaveText(before!);
  await expect(newest.getByText("Running")).toBeVisible();
  await expect(newest.getByText("Completed")).toBeVisible({ timeout: 25_000 });
  await expect(page.getByRole("status")).toBeEmpty();
});

test("report link streams the report without exposing the token", async ({ request }) => {
  const res = await request.get("/api/reports/1");
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain("Demo report");
});

test("unknown run shows not found, without a title naming the run", async ({ page }) => {
  for (const path of ["/runs/999", "/runs/abc"]) {
    // The status stays 200: the (dashboard) loading boundary streams before notFound() runs.
    await page.goto(path);
    await expect(page.getByText("doesn't exist")).toBeVisible();
    await expect(page).toHaveTitle("Run not found · Compliance Sentinel");
  }
});

test("every dashboard page has its own title", async ({ page }) => {
  for (const [path, title] of [
    ["/overview", "Overview"],
    ["/runs", "Runs"],
    ["/runs/1", "Run #1"],
    ["/rules", "Rules"],
    ["/settings", "Settings"],
  ]) {
    await page.goto(path);
    await expect(page).toHaveTitle(`${title} · Compliance Sentinel`);
  }
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

test("a code location links to the file on GitHub at the audited commit", async ({ page }) => {
  await page.goto("/runs/1?severity=critical");
  const link = page.locator("article").first().getByRole("link", { name: "Open src/auth/session.ts lines 11–15 on GitHub" });
  await expect(link).toHaveAttribute(
    "href",
    "https://github.com/acme/payments-api/blob/3f2c1a9e8b7d6c5f4e3a2b1c0d9e8f7a6b5c4d3e/src/auth/session.ts#L11-L15",
  );
  await expect(link).toHaveAttribute("target", "_blank");
});

const MOCK_API = `http://127.0.0.1:${process.env.MOCK_API_PORT || "8099"}`;
const MOCK_AUTH = { authorization: "Bearer e2e-token" };

test("the runs list pages to older runs, and each page has its own URL", async ({ page, request }) => {
  const total = async () => Number((await request.get(`${MOCK_API}/runs`, { headers: MOCK_AUTH })).headers()["x-total-count"]);
  try {
    // More than one page of 25: queue runs on the mock, then let them finish so no page polls mid-test.
    for (let n = await total(); n <= 25; n++) await request.post(`${MOCK_API}/runs`, { headers: MOCK_AUTH });
    const count = await total();
    await expect
      .poll(async () => (await (await request.get(`${MOCK_API}/runs`, { headers: MOCK_AUTH })).json())[0].status, { timeout: 25_000 })
      .toBe("completed");

    await page.goto("/runs");
    await expect(page.getByText(`Showing 1–25 of ${count} runs`)).toBeVisible();
    await expect(page.getByRole("link", { name: "#1", exact: true })).toHaveCount(0);

    await page.getByRole("link", { name: "Older" }).click();
    await expect(page).toHaveURL(/\/runs\?page=2$/);
    await expect(page.getByText(`Showing 26–${count} of ${count} runs`)).toBeVisible();
    await expect(page.getByRole("link", { name: "#1", exact: true })).toBeVisible();

    // A deep link lands on the same page; Newer goes back to the plain URL.
    await page.goto("/runs?page=2");
    await expect(page.getByRole("link", { name: "#1", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Newer" }).click();
    await expect(page).toHaveURL(/\/runs$/);
    await expect(page.getByText(`Showing 1–25 of ${count} runs`)).toBeVisible();
  } finally {
    await request.delete(`${MOCK_API}/runs`, { headers: MOCK_AUTH });
  }
});

test("rules can be searched by title or id and filtered by source", async ({ page }) => {
  await page.goto("/rules");
  const searchBox = page.getByRole("searchbox", { name: "Search" });
  const submit = page.getByRole("button", { name: "Search", exact: true });
  await expect(page.getByText("Books and Records Retention")).toBeVisible();

  await searchBox.fill("demo-1");
  await submit.click();
  await expect(page).toHaveURL(/q=demo-1/);
  await expect(page.getByText("Demo Safeguards Rule")).toBeVisible();
  await expect(page.getByText("Books and Records Retention")).toHaveCount(0);

  await searchBox.fill("no such rule");
  await submit.click();
  await expect(page.getByText("No rules match")).toBeVisible();
  await page.getByRole("link", { name: "Clear", exact: true }).click();
  await expect(page).toHaveURL(/\/rules$/);
  await expect(page.getByText("Demo Safeguards Rule")).toBeVisible();

  await page.getByLabel("Source").selectOption("sec");
  await submit.click();
  await expect(page).toHaveURL(/source=sec/);
  await expect(page.getByText("Books and Records Retention")).toBeVisible();
  await expect(page.getByText("Demo Safeguards Rule")).toHaveCount(0);
});

test("the runs and rules lists fit a phone screen without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const path of ["/runs", "/rules"]) {
    await page.goto(path);
    // Rows restyle into cards below `sm`, so the table's scroll box has nothing to scroll.
    const box = page.locator("table").locator("..");
    await expect(box).toBeVisible();
    expect(await box.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  }
});
