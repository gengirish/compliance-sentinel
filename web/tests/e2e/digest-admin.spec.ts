import { expect, test, type Page } from "@playwright/test";

// The mock API reports 3 active, 1 pending and 2 unsubscribed subscribers, email on, Slack off,
// and previews a fixture whose html is "<h1>Digest preview</h1>".

const digest = (page: Page) => page.getByRole("region", { name: "Weekly digest" });

test("the settings page shows the digest's subscribers, schedule and channels", async ({ page }) => {
  await page.goto("/settings");
  const card = digest(page);
  await expect(card.getByRole("heading", { name: "Weekly digest", level: 2 })).toBeVisible();
  const counts = card.getByRole("definition");
  await expect(counts).toHaveText(["3", "1", "2"]);
  await expect(card.getByText("Mondays 07:00 UTC, covering the last 7 days")).toBeVisible();
  await expect(card.getByText("Email to 1 team recipient and every active subscriber")).toBeVisible();
  await expect(card.getByText("Slack off")).toBeVisible();
  await expect(card.getByText(/Email is not configured/)).toHaveCount(0);
  // The digest adds no list items, so the sources list keeps its eight rows.
  await expect(page.getByRole("listitem")).toHaveCount(8);
});

test("preview renders the email in a sandboxed frame without sending it", async ({ page }) => {
  await page.goto("/settings");
  const card = digest(page);
  await card.getByRole("button", { name: "Preview" }).click();
  await expect(card.getByText("Regulatory digest: 2 rule changes")).toBeVisible();
  await expect(card.getByText(/2 rules, 19 Oct 2026 to 26 Oct 2026, cost \$0\.01\. Nothing was sent\./)).toBeVisible();

  const frame = card.locator("iframe");
  await expect(frame).toHaveAttribute("sandbox", "");
  await expect(frame).toHaveAttribute("title", /Digest preview/);
  await expect(page.frameLocator("iframe[title^='Digest preview']").getByRole("heading", { name: "Digest preview" })).toBeVisible();
});

test("a test send goes to the address given, and a bad address is refused", async ({ page }) => {
  await page.goto("/settings");
  const card = digest(page);
  const email = card.getByRole("textbox", { name: "Test recipient email" });
  await expect(email).toHaveValue("");

  await email.fill("ops@example.com");
  await card.getByRole("button", { name: "Send test" }).click();
  await expect(card.getByRole("status").filter({ hasText: "Sent to ops@example.com" })).toBeVisible();

  // The browser's own email check is switched off, so the route's validation answers.
  await card.locator("form").evaluate((form: HTMLFormElement) => (form.noValidate = true));
  await email.fill("not-an-email");
  await card.getByRole("button", { name: "Send test" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Enter a valid email address." })).toBeVisible();
});

test("sending to everyone takes a confirm, and cancel backs out", async ({ page }) => {
  await page.goto("/settings");
  const card = digest(page);
  const sendNow = card.getByRole("button", { name: "Send to everyone now" });

  await sendNow.click();
  await expect(card.getByText("Send to 3 subscribers and the team now?")).toBeVisible();
  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(card.getByText("Send to 3 subscribers and the team now?")).toHaveCount(0);
  await expect(card.getByText(/Queued/)).toHaveCount(0);

  await sendNow.click();
  await card.getByRole("button", { name: "Confirm" }).click();
  await expect(card.getByRole("status").filter({ hasText: "Queued (job e2e-digest-job)" })).toBeVisible();
});
