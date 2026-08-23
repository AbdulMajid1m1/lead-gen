import { chromium } from "playwright";
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

const runId = process.argv[2];
await page.goto(`http://localhost:4180/research?run=${runId}`, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.screenshot({ path: "/tmp/shots/research-grid.png" });
console.log("grid:", (await page.locator("body").innerText()).length, "chars");

// open the outreach email panel
const btn = page.getByRole("button", { name: /^Email$/ }).first();
if (await btn.count()) {
  await btn.click();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: "/tmp/shots/research-email.png" });
  console.log("email panel: captured");
}

await page.goto("http://localhost:4180/research/history", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.screenshot({ path: "/tmp/shots/research-history.png" });
console.log("history:", (await page.locator("body").innerText()).length, "chars");

await browser.close();
console.log(errors.length ? "CONSOLE ERRORS:\n" + [...new Set(errors)].join("\n") : "no console errors");
