import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const apiCalls = [];
page.on("response", async (res) => {
  const u = res.url();
  const ct = res.headers()["content-type"] || "";
  if (/json/.test(ct) && !/gtm|google|analytics/.test(u)) {
    let body = "";
    try { body = (await res.text()).slice(0, 1200); } catch {}
    apiCalls.push({ url: u.slice(0, 300), status: res.status(), body });
  }
});
await page.goto("https://www.asic.gov.au/regulatory-resources/find-a-document/regulatory-guides", { waitUntil: "domcontentloaded", timeout: 60000 });
try { await page.waitForSelector("a[href*='regulatory-guide-'], a[href*='download.asic.gov.au'], a[href*='/rg-']", { timeout: 30000 }); } catch (e) { console.log("no guide links:", String(e).slice(0, 120)); }
await page.waitForTimeout(3000);
console.log("=== API calls"); for (const c of apiCalls) console.log(JSON.stringify(c));
const info = await page.evaluate(() => {
  const links = [...document.querySelectorAll("a")].filter((a) => /regulatory-guide|download\.asic\.gov\.au|\/rg-?\d/i.test(a.href));
  const sample = links.slice(0, 4).map((a) => { let el = a; for (let i = 0; i < 3 && el.parentElement; i++) el = el.parentElement; return el.outerHTML.slice(0, 1500); });
  return { count: links.length, hrefs: links.slice(0, 8).map((a) => a.href + " | " + a.textContent.trim().slice(0, 80)), sample };
});
console.log("=== count", info.count); console.log(info.hrefs.join("\n")); console.log("=== sample rows"); for (const s of info.sample) console.log(s, "\n-----");
await browser.close();
