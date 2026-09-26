// Captures the launch video's frames from index.html, one screenshot per frame.
// Run by demo/launch/render.sh from a scratch directory that holds index.html, its fonts and demo frames.
//
//   node render.mjs frames [fps] [seconds]   → frames/00000.png ...
//   node render.mjs stills 1.5 7.2 ...       → stills/t1.5.png ... (for checking layouts)
//
// Chromium: CHROME_PATH if set, otherwise Playwright's own download.

import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright-core";

const [mode = "frames", ...rest] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(new URL("index.html", import.meta.url).pathname).href);
await page.evaluate(() => globalThis.ready);

if (mode === "stills") {
  mkdirSync("stills", { recursive: true });
  for (const s of rest) {
    await page.evaluate((t) => globalThis.render(t), Number(s));
    await page.screenshot({ path: `stills/t${s}.png` });
  }
} else {
  const fps = Number(rest[0] ?? 30);
  const seconds = Number(rest[1] ?? 22);
  mkdirSync("frames", { recursive: true });
  const n = Math.round(fps * seconds);
  for (let i = 0; i < n; i++) {
    await page.evaluate((t) => globalThis.render(t), i / fps);
    await page.screenshot({ path: `frames/${String(i).padStart(5, "0")}.png` });
    if (i % 60 === 0) console.log(`frame ${i}/${n}`);
  }
}
await browser.close();
