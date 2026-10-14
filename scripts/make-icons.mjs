// Renders icons/icon.svg to the PNG sizes iOS and Android need.
// Usage: node scripts/make-icons.mjs   (needs Playwright + Chromium)
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";

const svg = await readFile(new URL("../icons/icon.svg", import.meta.url), "utf8");
const browser = await chromium.launch();
for (const size of [180, 192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  // Full-bleed square: iOS applies its own rounded mask.
  const square = svg.replace('rx="112"', 'rx="0"');
  await page.setContent(`<style>*{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${square}`);
  await page.screenshot({ path: new URL(`../icons/icon-${size}.png`, import.meta.url).pathname });
  await page.close();
}
await browser.close();
