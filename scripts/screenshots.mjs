// Captures dashboard screenshots for the README and the site from the dev build's sample data.
//
//   pnpm screenshots            all shots, light and dark
//   pnpm screenshots router     just the named shots
//
// The shots, their pages and heights are in apps/site/src/lib/screenshots.json. The script starts
// the dashboard with VITE_AUTH_DISABLED=true (no API, sample data). README shots go to
// .github/readme/ as PNG; site shots go to apps/site/public/screenshots/ as WebP, full size and
// 1440 wide. SITE_SHOTS below are README-only shots of one element on the site's own pages, taken
// from the site's dev server.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
import sharp from "sharp";
import SHOTS from "../apps/site/src/lib/screenshots.json" with { type: "json" };

const PORT = 5199;
const BASE = `http://localhost:${PORT}`;
const SITE_PORT = 5198;
const SITE_BASE = `http://localhost:${SITE_PORT}`;
const README_DIR = ".github/readme";
const SITE_DIR = "apps/site/public/screenshots";

/** The dev build's own labels, swapped for the demo workspace's. */
const SWAPS = [
  ["Dev workspace", "Acme"],
  ["Dev (auth disabled)", "acme-labs"],
];

/** Hides the closest `selector` around the given text, so a marketing shot isn't a wall of warnings. */
const hideAround = (page, text, selector) =>
  page
    .getByText(text)
    .first()
    .evaluate((el, sel) => el.closest(sel)?.style.setProperty("display", "none"), selector);

/** Steps after loading the page, for shots that open or trim something. */
const STEPS = {
  // One Needs attention row (the offline machine) tells the story; a second for the same machine is noise.
  runners: (page) => hideAround(page, "studio-mini needs a runner update", "div"),
  // The setup nudge is for new workspaces, not the runner order.
  router: (page) => hideAround(page, "Set up a repo", "section"),
  history: async (page) => {
    await page.getByText("fix(api): start a new pick runner").first().click();
    await page.getByRole("dialog").getByText("Test", { exact: true }).first().click();
  },
};

/** README shots of one element on a site page, on a transparent background. */
const SITE_SHOTS = {
  // The Mac app's menu and Jobs window, as drawn on /download with made-up jobs (MacAppPreview.astro).
  mac: { path: "/download", selector: ".dl-preview .mac-stage", width: 1280 },
};

const only = process.argv.slice(2);
const pick = (shots) => Object.keys(shots).filter((name) => !only.length || only.includes(name));
const names = pick(SHOTS);
const siteNames = pick(SITE_SHOTS);

async function waitForServer(base) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base)).ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`Nothing started on ${base}`);
}

const start = (filter, args, env = {}) =>
  spawn("pnpm", ["--filter", filter, "dev", ...args], {
    env: { ...process.env, ...env },
    stdio: "ignore",
    detached: true,
  });

function prepare(swaps) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const [from, to] of swaps) node.nodeValue = node.nodeValue.replaceAll(from, to);
  }
  // Operator pages show in dev builds but not to anyone using the dashboard.
  document.querySelector('nav[aria-label="Admin"]')?.style.setProperty("display", "none");
  // The dashboard's own footer links are noise in a screenshot.
  document.querySelector("footer")?.style.setProperty("display", "none");
}

const servers = [
  names.length &&
    start("@relayrunner/web", ["--port", String(PORT), "--strictPort"], {
      VITE_AUTH_DISABLED: "true",
    }),
  // Without --ignore-lock, Astro moves to the background under a coding agent, or defers to a dev
  // server that's already running.
  siteNames.length && start("@relayrunner/site", ["--port", String(SITE_PORT), "--ignore-lock"]),
].filter(Boolean);

try {
  await Promise.all([
    names.length && waitForServer(BASE),
    siteNames.length && waitForServer(SITE_BASE),
  ]);
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
    for (const name of siteNames) {
      const shot = SITE_SHOTS[name];
      await page.setViewportSize({ width: shot.width, height: 900 });
      await page.goto(SITE_BASE + shot.path);
      await page.waitForLoadState("networkidle");
      // Leaves the element's rounded corners see-through on GitHub's light and dark pages.
      await page.evaluate(() => {
        for (const el of [document.documentElement, document.body]) el.style.background = "none";
      });
      const image = sharp(await page.locator(shot.selector).screenshot({ omitBackground: true }));
      const file = `${name}-${scheme}`;
      await image.png({ palette: true, colors: 256 }).toFile(`${README_DIR}/${file}.png`);
      console.log(file);
    }
    await context.close();
  }
  await browser.close();
} finally {
  for (const server of servers) process.kill(-server.pid);
}
