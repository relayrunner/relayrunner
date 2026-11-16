// Captures dashboard screenshots for the README and the site from the dev build's sample data.
//
//   pnpm screenshots            all shots, light and dark
//   pnpm screenshots router     just the named shots
//
// The shots, their pages and heights are in apps/site/src/lib/screenshots.json. The script starts
// the dashboard with VITE_AUTH_DISABLED=true (no API, sample data). README shots go to
// .github/readme/ as PNG; site shots go to apps/site/public/screenshots/ as WebP, full size and
// 1440 wide.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
import sharp from "sharp";
import SHOTS from "../apps/site/src/lib/screenshots.json" with { type: "json" };

const PORT = 5199;
const BASE = `http://localhost:${PORT}`;
const README_DIR = ".github/readme";
const SITE_DIR = "apps/site/public/screenshots";

/** The dev build's own labels, swapped for the demo workspace's. */
const SWAPS = [
  ["Dev workspace", "Acme"],
  ["Dev (auth disabled)", "acme-labs"],
];

/** Steps after loading the page, for shots that open something. */
const STEPS = {
  history: async (page) => {
    await page.getByText("fix(api): start a new pick runner").first().click();
    await page.getByRole("dialog").getByText("Test", { exact: true }).first().click();
  },
};

const only = process.argv.slice(2);
const names = Object.keys(SHOTS).filter((name) => !only.length || only.includes(name));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`The dashboard didn't start on ${BASE}`);
}

function prepare(swaps) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const [from, to] of swaps) node.nodeValue = node.nodeValue.replaceAll(from, to);
  }
  // Operator pages show in dev builds but not to anyone using the dashboard.
  document.querySelector('nav[aria-label="Admin"]')?.style.setProperty("display", "none");
}

const server = spawn(
  "pnpm",
  ["--filter", "@relayrunner/web", "dev", "--port", String(PORT), "--strictPort"],
  { env: { ...process.env, VITE_AUTH_DISABLED: "true" }, stdio: "ignore", detached: true },
);

try {
  await waitForServer();
  await mkdir(SITE_DIR, { recursive: true });
  const browser = await chromium.launch();
  for (const scheme of ["light", "dark"]) {
    const context = await browser.newContext({
      baseURL: BASE,
      deviceScaleFactor: 2,
      colorScheme: scheme,
    });
    // The dashboard's theme key (apps/web/src/lib/theme.ts).
    await context.addInitScript((theme) => localStorage.setItem("rr-theme", theme), scheme);
    const page = await context.newPage();
    for (const name of names) {
      const shot = SHOTS[name];
      await page.setViewportSize({ width: 1440, height: shot.height });
      await page.goto(shot.path);
      await STEPS[name]?.(page);
      await page.waitForLoadState("networkidle");
      // Lets charts and sheet transitions settle.
      await sleep(1500);
      await page.evaluate(prepare, SWAPS);
      const image = sharp(await page.screenshot());
      const file = `${name}-${scheme}`;
      await Promise.all([
        shot.readme !== false &&
          image.clone().png({ palette: true, colors: 256 }).toFile(`${README_DIR}/${file}.png`),
        image.clone().webp({ quality: 82 }).toFile(`${SITE_DIR}/${file}.webp`),
        image.clone().resize(1440).webp({ quality: 82 }).toFile(`${SITE_DIR}/${file}-1440.webp`),
      ]);
      console.log(file);
    }
    await context.close();
  }
  await browser.close();
} finally {
  process.kill(-server.pid);
}
