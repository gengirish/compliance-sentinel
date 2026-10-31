import { expect, test, type Page } from "@playwright/test";

/** Opens `path`, waits for the service worker to activate, and makes sure it controls the page. */
async function openControlled(page: Page, path: string) {
  await page.goto(path);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // The worker calls clients.claim(), so it usually controls the page already; a reload makes sure.
  const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
  if (!controlled) await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
}

test.describe("progressive web app", () => {
  test("the manifest describes the installed app and its icons exist", async ({ request }) => {
    const res = await request.get("/manifest.webmanifest");
    expect(res.status()).toBe(200);
    const manifest = (await res.json()) as {
      name: string;
      display: string;
      start_url: string;
      icons: { src: string }[];
    };
    expect(manifest.name).toBe("Compliance Sentinel");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/overview");
    expect(manifest.icons.length).toBeGreaterThan(0);

    for (const icon of manifest.icons) {
      const iconRes = await request.get(icon.src);
      expect(iconRes.status(), icon.src).toBe(200);
      expect(iconRes.headers()["content-type"], icon.src).toContain("image/png");
    }
  });

  test("the service worker script is served uncached", async ({ request }) => {
    const res = await request.get("/sw.js");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("javascript");
    expect(res.headers()["cache-control"]).toContain("no-cache");
  });

  test("the service worker registers and controls the dashboard", async ({ page }) => {
    await openControlled(page, "/overview");
    const scriptURL = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? "");
    expect(new URL(scriptURL).pathname).toBe("/sw.js");
  });

  test("a navigation while offline shows the offline page", async ({ page, context }) => {
    await openControlled(page, "/overview");
    await context.setOffline(true);
    try {
      await page.goto("/runs");
      // Matched by text, not role: the offline page draws its title as a <p>, not a heading.
      await expect(page.getByText(/you.re offline/i).first()).toBeVisible();
      await expect(page.getByRole("button", { name: /try again/i })).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });

  test("no API responses or dashboard pages are stored in the caches", async ({ page }) => {
    await openControlled(page, "/overview");
    await page.goto("/runs");
    await expect(page.locator("tbody tr").first()).toBeVisible();

    const cachedPaths = await page.evaluate(async () => {
      const paths: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const req of await cache.keys()) paths.push(new URL(req.url).pathname);
      }
      return paths;
    });

    const apiPaths = cachedPaths.filter((p) => p.startsWith("/api/"));
    expect(apiPaths).toEqual([]);

    // A page is any path outside /_next/ whose last segment has no file extension
    // (/overview, /runs, /runs/1, /). Only the offline fallback may be stored.
    const pagePaths = cachedPaths.filter((p) => {
      if (p.startsWith("/_next/") || p === "/offline") return false;
      const last = p.split("/").pop() ?? "";
      return !last.includes(".");
    });
    expect(pagePaths).toEqual([]);
  });
});
