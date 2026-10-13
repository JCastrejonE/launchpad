#!/usr/bin/env node
/**
 * ui-shot.mjs — SUPERVISOR/AGENT TOOLING (not pipeline/product code; spec 0064).
 *
 * Headless-Chromium screenshot of ONE localhost route in BOTH themes, so the
 * uiux-coder agent (agents/uiux-coder.md) can see the rendered pixels before it
 * signs off on a polish pass. Writes `<out>-light.png` and `<out>-dark.png`;
 * the agent then Reads each PNG (the Read tool renders images) and inspects for
 * AA contrast / layout / motion. Scratch output under `.preflight/` — never
 * committed.
 *
 * Chosen (ponytail ladder, gate-1 decision 5): a small script the agent runs
 * via its existing Bash tool + Reads the PNG — zero new session tool surface,
 * reuses the puppeteer devDependency the impeccable detector already assumes.
 *
 * Usage:  node scripts/ui-shot.mjs <url> --out <prefix>
 *   <url>    the route to shoot, e.g. http://localhost:3000/forge (localhost only)
 *   --out    output path prefix, e.g. .preflight/uishot
 *            → writes <prefix>-light.png and <prefix>-dark.png
 */

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const url = argv[0];
  const outIndex = argv.indexOf("--out");
  const out = outIndex !== -1 ? argv[outIndex + 1] : undefined;
  if (!url || !out) {
    throw new Error("usage: node scripts/ui-shot.mjs <url> --out <prefix>");
  }
  const { hostname } = new URL(url);
  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    throw new Error(`ui-shot.mjs: refusing non-localhost url ${url}`);
  }
  return { url, out };
}

async function main() {
  const { url, out } = parseArgs(process.argv.slice(2));
  fs.mkdirSync(path.dirname(out), { recursive: true });

  let puppeteer;
  try {
    puppeteer = await import("puppeteer");
  } catch {
    throw new Error("puppeteer is required for ui-shot.mjs. Install: pnpm install");
  }

  const launchArgs = process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : [];
  const browser = await puppeteer.default.launch({ headless: true, args: launchArgs });
  try {
    const page = await browser.newPage();
    // Force prefers-color-scheme: light for the first shot — the app's
    // inline theme-init script (apps/web/app/layout.tsx) falls back to
    // prefers-color-scheme when no theme is in localStorage, so without
    // this the "light" shot would inherit the host OS's dark mode setting.
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });

    await page.screenshot({ path: `${out}-light.png` });

    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.screenshot({ path: `${out}-dark.png` });
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
