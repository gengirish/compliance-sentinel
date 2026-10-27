import { expect, test } from "@playwright/test";

// The mock API accepts any sign-up and treats only this token as a real emailed link.
const TOKEN = "e2e-subscriber-token-0001";

test("a visitor signs up for the weekly digest from the landing page", async ({ page }) => {
  await page.goto("/#digest");
  const email = page.getByRole("textbox", { name: "Email address" });
  await email.fill("reader@example.com");
  await page.getByRole("button", { name: "Subscribe" }).click();
  await expect(page.getByRole("status")).toContainText("Check reader@example.com for a confirmation link");
  await expect(email).toBeHidden();
});

test("the confirmation link activates the subscription, and a bad one says so", async ({ page }) => {
  await page.goto(`/subscribe/confirm?token=${TOKEN}`);
  await expect(page.getByRole("heading", { name: "You're subscribed" })).toBeVisible();
  await expect(page.getByText("reader@example.com")).toBeVisible();

  await page.goto("/subscribe/confirm?token=not-a-real-token-at-all");
  await expect(page.getByRole("heading", { name: "Could not confirm" })).toBeVisible();
});

test("unsubscribing takes a click, not just opening the link", async ({ page }) => {
  await page.goto(`/unsubscribe?token=${TOKEN}`);
  await expect(page.getByText("Stop sending the weekly regulatory digest")).toBeVisible();
  await page.getByRole("button", { name: "Unsubscribe" }).click();
  await expect(page.getByRole("status")).toContainText("reader@example.com will get no more digests");

  await page.goto("/unsubscribe?token=not-a-real-token-at-all");
  await page.getByRole("button", { name: "Unsubscribe" }).click();
  // Filtered by text: Next's route announcer is also role=alert.
  await expect(page.getByRole("alert").filter({ hasText: "This link is invalid." })).toBeVisible();
});
