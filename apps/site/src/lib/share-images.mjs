// Share images (Open Graph cards) and the README hero, drawn with Satori and rasterized with resvg.
// The docs and integration cards render at build time (src/pages/og/); the home card and the README
// hero are written to disk by `pnpm images` (scripts/images.mjs). Paths are relative to apps/site,
// where both run.
import { readFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";

const read = (path) => readFileSync(path);

const fonts = [
  ...[400, 500, 600, 700].map((weight) => ({
    name: "Hanken Grotesk",
    weight,
    data: read(
      `node_modules/@fontsource/hanken-grotesk/files/hanken-grotesk-latin-${weight}-normal.woff`,
    ),
  })),
  ...[400, 500].map((weight) => ({
    name: "JetBrains Mono",
    weight,
    data: read(
      `node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-${weight}-normal.woff`,
    ),
  })),
];

const svg = (path) => `data:image/svg+xml;base64,${read(path).toString("base64")}`;
const logo = svg("public/assets/runner-head.svg");
const provider = (id) => svg(`public/providers/${id}.svg`);
// Some logos are a PNG wrapped in an SVG, which Satori draws blank: use the PNG itself.
const logoOf = (id) =>
  read(`public/providers/${id}.svg`)
    .toString()
    .match(/href="(data:image\/png;base64,[^"]+)"/)?.[1] ?? provider(id);

// A tiny element factory, so the layouts read like markup. Satori lays out every element with
// flexbox, and an element with more than one child needs `display: flex`.
const h = (type, style, ...children) => ({
  type,
  props: {
    style: { display: "flex", boxSizing: "border-box", ...style },
    children: children.flat(),
  },
});
const img = (src, size, style = {}) => ({
  type: "img",
  props: { src, width: size, height: size, style },
});

const light = {
  bg: "#ffffff",
  ink: "#0e1a11",
  body: "#4d5a50",
  mute: "#677269",
  go: "#178a2e",
  line: "#e3e8e1",
  lane: "#ffffff",
  first: "#eef7ee",
  firstEdge: "#9fd3a6",
};
const dark = {
  bg: "#0b0d10",
  ink: "#e6edf3",
  body: "#b4bcc6",
  mute: "#8b949e",
  go: "#3fb950",
  line: "#272c35",
  lane: "#161a20",
  first: "rgba(63, 185, 80, 0.14)",
  firstEdge: "rgba(63, 185, 80, 0.55)",
};

const mono = (size, color, weight = 400) => ({
  fontFamily: "JetBrains Mono",
  fontSize: size,
  fontWeight: weight,
  color,
});
const caps = (c) => ({
  color: c.mute,
  fontSize: 15,
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
});

/** One runner in a runner order: its position, logo and name, with an optional note on the right. */
function lane(c, { n, id, name, note, state }) {
  const on = state === "on";
  const off = state === "off";
  return h(
    "div",
    {
      alignItems: "center",
      gap: 14,
      padding: "13px 18px",
      borderRadius: 10,
      border: `1px solid ${on ? c.firstEdge : c.line}`,
      background: on ? c.first : off ? "transparent" : c.lane,
      fontSize: 20,
      fontWeight: 700,
      color: off ? c.mute : c.ink,
    },
    h("div", { width: 16, ...mono(15, on ? c.go : c.mute, 500) }, String(n)),
    img(provider(id), 32, off ? { opacity: 0.6 } : {}),
    h("div", {}, name),
    note
      ? h(
          "div",
          { marginLeft: "auto", fontSize: 15, fontWeight: 600, color: on ? c.go : c.mute },
          note,
        )
      : [],
  );
}

const brand = (c, size = 26, suffix) =>
  h(
    "div",
    { alignItems: "center", gap: 12, fontSize: size, fontWeight: 700, color: c.ink },
    img(logo, Math.round(size * 1.7)),
    h("div", {}, "relayrunner"),
    suffix ? h("div", { color: c.mute, fontWeight: 500 }, suffix) : [],
  );

/**
 * The landing pages' card: a headline on the left (its `accent` lines in green), and on the right a
 * queued job skipping busy machines for the next runner in the order.
 */
function routeCard({ headline, accent, sub, lanes, url, size = 72 }) {
  const c = dark;
  return h(
    "div",
    {
      width: 1200,
      height: 630,
      position: "relative",
      alignItems: "center",
      gap: 56,
      padding: "0 72px",
      background: c.bg,
      color: c.ink,
      fontFamily: "Hanken Grotesk",
    },
    h(
      "div",
      { flexDirection: "column", flex: 1 },
      brand(c),
      h(
        "div",
        {
          flexDirection: "column",
          marginTop: 40,
          fontSize: size,
          fontWeight: 700,
          lineHeight: 1.02,
          letterSpacing: "-0.045em",
        },
        h("div", {}, headline),
        [accent].flat().map((line) => h("div", { color: c.go }, line)),
      ),
      h("div", { marginTop: 24, color: c.body, fontSize: 24, lineHeight: 1.45 }, sub),
    ),
    h(
      "div",
      { flexDirection: "column", gap: 12, width: 500, flexShrink: 0 },
      h(
        "div",
        {
          alignItems: "center",
          gap: 12,
          padding: "14px 18px",
          borderRadius: 10,
          border: `1px solid ${c.line}`,
          background: c.lane,
          ...mono(17, c.body),
        },
        h("div", { width: 10, height: 10, borderRadius: 5, background: "#d29922" }),
        h("div", {}, "ci / test"),
        h("div", { marginLeft: "auto", color: c.mute }, "queued"),
      ),
      h("div", { margin: "2px 0 2px 22px", width: 2, height: 18, background: c.go }),
      h("div", caps(c), "Runner order"),
      lanes.map((l, i) => lane(c, { n: i + 1, ...l })),
    ),
    h(
      "div",
      { position: "absolute", left: 72, bottom: 40, color: c.mute, fontSize: 18, fontWeight: 500 },
      url,
    ),
  );
}

const busyMachines = { id: "machines", name: "Your machines", note: "Busy", state: "off" };

/** The home page card. */
export function homeCard() {
  return routeCard({
    headline: "One router for",
    accent: "every CI runner.",
    sub: "Run jobs on your own machines and send the rest to hosted runners when they're busy.",
    lanes: [
      busyMachines,
      { id: "blacksmith", name: "Blacksmith", note: "Takes the job", state: "on" },
      { id: "github", name: "GitHub-hosted" },
    ],
    url: "relayrunner.dev",
  });
}

/**
 * An integration page's card: your machines first, and this provider when they're busy. The
 * runner order shows it taking the job, with GitHub-hosted runners after it (on GitHub's own card,
 * nothing after it). `url` is the page's address without the scheme.
 */
export function integrationCard({ id, name, url }) {
  const github = id === "github";
  const runner = github ? "GitHub-hosted" : name;
  return routeCard({
    headline: "Your machines first.",
    accent: [`${name} when`, "they're busy."],
    size: 60,
    sub: `relayrunner sends each job to your own machines and falls back to ${
      github ? "GitHub-hosted runners" : name
    } on its own. No workflow edits.`,
    lanes: [
      busyMachines,
      { id, name: runner, note: "Takes the job", state: "on" },
      ...(github ? [] : [{ id: "github", name: "GitHub-hosted" }]),
    ],
    url,
  });
}

/**
 * The integrations index card: jobs split across runner clouds. On the right, a week of jobs with
 * each runner's share: the runners that cost nothing (your machines, the minutes plans include)
 * take the most, then the cheapest per-minute clouds. The shares are illustrative.
 */
export function integrationsCard({ url }) {
  const c = dark;
  const run = "#d29922";
  const included = [
    { id: "machines", name: "Your machines", pct: 38, tone: c.go },
    { id: "blacksmith", name: "Blacksmith", pct: 22, tone: "#2ea043" },
    { id: "github", name: "GitHub-hosted", pct: 14, tone: "#238636" },
  ];
  const perMinute = [
    { id: "depot", name: "Depot", pct: 12, tone: run },
    { id: "ubicloud", name: "Ubicloud", pct: 9, tone: "#bb8009" },
    { id: "namespace", name: "Namespace", pct: 5, tone: "#9e6a03" },
  ];
  const row = ({ id, name, pct, tone }) =>
    h(
      "div",
      { alignItems: "center", gap: 12, height: 44 },
      img(provider(id), 28),
      h("div", { width: 150, fontSize: 19, fontWeight: 700 }, name),
      h(
        "div",
        { flex: 1, height: 12, borderRadius: 6, border: `1px solid ${c.line}`, background: c.lane },
        // The biggest share (38%) nearly fills its track.
        h("div", { width: `${Math.round((pct / 40) * 100)}%`, borderRadius: 6, background: tone }),
      ),
      h("div", { width: 48, justifyContent: "flex-end", ...mono(17, c.body, 500) }, `${pct}%`),
    );
  const group = (label, tag, rows) =>
    h(
      "div",
      { flexDirection: "column", gap: 2 },
      h(
        "div",
        { alignItems: "center", gap: 10, marginBottom: 6 },
        h("div", caps(c), label),
        h("div", mono(14, c.mute), tag),
      ),
      rows.map(row),
    );
  return h(
    "div",
    {
      width: 1200,
      height: 630,
      position: "relative",
      alignItems: "center",
      gap: 52,
      padding: "0 72px",
      background: c.bg,
      color: c.ink,
      fontFamily: "Hanken Grotesk",
    },
    h(
      "div",
      { flexDirection: "column", flex: 1 },
      brand(c),
      h(
        "div",
        {
          flexDirection: "column",
          marginTop: 40,
          fontSize: 60,
          fontWeight: 700,
          lineHeight: 1.02,
          letterSpacing: "-0.045em",
        },
        h("div", {}, "Split your CI across"),
        h("div", { color: c.go }, "every runner cloud."),
      ),
      h(
        "div",
        { marginTop: 24, color: c.body, fontSize: 24, lineHeight: 1.45 },
        "Each job goes to the cheapest runner with room: your machines, the minutes your plans include, then the lowest price per minute.",
      ),
    ),
    h(
      "div",
      {
        flexDirection: "column",
        gap: 18,
        width: 500,
        flexShrink: 0,
        padding: "24px 26px",
        borderRadius: 14,
        border: `1px solid ${c.line}`,
        background: "#0f1216",
      },
      h(
        "div",
        { alignItems: "center", ...mono(16, c.body) },
        h("div", {}, "jobs this week"),
        h("div", { marginLeft: "auto", color: c.mute }, "1,284"),
      ),
      group("Free first", "$0", included),
      group("Then paid", "per minute", perMinute),
    ),
    h(
      "div",
      { position: "absolute", left: 72, bottom: 40, color: c.mute, fontSize: 18, fontWeight: 500 },
      url,
    ),
  );
}

/**
 * The share image for the dashboard's public Evaluate page (app.relayrunner.dev/evaluate/<id>),
 * drawn at build time as /og/evaluate/<id>.png. "Benchmark your CI on <provider>", the provider in
 * a pill of its own brand colours, beside a card like the dashboard's Performance views: a
 * workflow's runs on GitHub over two weeks with the provider's evaluation runs under them, then
 * both runners' run time (range and median) and cost per run. The numbers are illustrative.
 */
export function evaluateCard({ id, name, url }) {
  const c = dark;
  const today = "#9aa3ad";
  const them = "#3987e5";
  const fixed = (src, size) => img(src, size, { flexShrink: 0 });
  return h(
    "div",
    {
      width: 1200,
      height: 630,
      position: "relative",
      alignItems: "center",
      gap: 44,
      padding: "0 64px",
      background: c.bg,
      color: c.ink,
      fontFamily: "Hanken Grotesk",
    },
    h(
      "div",
      { flexDirection: "column", flex: 1 },
      brand(c),
      h(
        "div",
        {
          flexDirection: "column",
          gap: 12,
          marginTop: 40,
          fontSize: 56,
          fontWeight: 700,
          lineHeight: 1.02,
          letterSpacing: "-0.045em",
        },
        h("div", {}, "Benchmark your CI"),
        h("div", { alignItems: "center", gap: 16 }, h("div", {}, "on"), brandPill(c, id, name, 56)),
      ),
      h(
        "div",
        { marginTop: 26, color: c.body, fontSize: 24, lineHeight: 1.45 },
        `See how your own workflows run on ${name}, in time and cost, next to the runners you use today. Nothing in your repo changes.`,
      ),
    ),
    h(
      "div",
      {
        flexDirection: "column",
        gap: 10,
        width: 500,
        flexShrink: 0,
        padding: "18px 24px 8px",
        borderRadius: 12,
        border: `1px solid ${c.line}`,
        background: c.lane,
      },
      h(
        "div",
        { alignItems: "center" },
        h("div", { fontSize: 18, fontWeight: 700 }, "ci / test"),
        h(
          "div",
          { marginLeft: "auto", gap: 18, alignItems: "center", ...mono(14, c.body) },
          h(
            "div",
            { alignItems: "center", gap: 7 },
            h("div", { width: 16, height: 3, background: today }),
            "ubuntu-latest",
          ),
          h(
            "div",
            { alignItems: "center", gap: 7 },
            h("div", { width: 12, height: 12, borderRadius: 6, border: `2.5px solid ${them}` }),
            `${name} evaluation`,
          ),
        ),
      ),
      runsChart(c, { width: 450, height: 190, today, them }),
      h(
        "div",
        { flexDirection: "column", marginTop: 4 },
        rangeRow(c, fixed, {
          logo: logoOf(id),
          label: name,
          tag: "evaluation",
          time: "2:04",
          timeChange: "40%",
          range: [0.3, 0.4, 0.33],
          tone: them,
          cost: "$0.048",
          costChange: "20%",
        }),
        rangeRow(c, fixed, {
          logo: provider("github"),
          label: "ubuntu-latest",
          tag: "today",
          time: "3:28",
          range: [0.6, 0.86, 0.69],
          tone: today,
          cost: "$0.060",
        }),
      ),
    ),
    h(
      "div",
      { position: "absolute", left: 64, bottom: 40, color: c.mute, fontSize: 18, fontWeight: 500 },
      url,
    ),
  );
}

/**
 * A provider's name in a pill of its brand colours: the logo tile's fill behind, the mark's colour
 * for the text, and the mark without its tile, so a dark brand's tile outline doesn't double up with
 * the pill's. Dark fills get an outline of their own to stand off the background.
 */
function brandPill(c, id, name, size) {
  const source = read(`public/providers/${id}.svg`).toString();
  const tile = source.match(/<rect[^>]*\/>/)?.[0];
  const bgFill = tile?.match(/fill="(#[0-9a-fA-F]{3,6})"/)?.[1];
  // The mark's colour: its first plain fill or stroke once the tile is gone.
  const mark = tile ? source.replace(tile, "") : source;
  const markInk = mark.match(/(?:fill|stroke)="(#[0-9a-fA-F]{3,6})"/)?.[1];
  // A tile with a plain fill and a mark in one colour, or else a neutral pill with the whole logo.
  const branded = Boolean(bgFill && markInk);
  const bg = branded ? bgFill : c.lane;
  const ink = branded ? markInk : c.ink;
  const logo = branded
    ? `data:image/svg+xml;base64,${Buffer.from(mark).toString("base64")}`
    : logoOf(id);
  const outline = luminance(bg) < 0.12 ? { border: "2px solid #3a414c" } : {};
  return h(
    "div",
    {
      alignItems: "center",
      gap: Math.round(size * 0.12),
      padding: `${Math.round(size * 0.06)}px ${Math.round(size * 0.42)}px ${Math.round(size * 0.06)}px ${Math.round(size * 0.14)}px`,
      borderRadius: 999,
      background: bg,
      color: ink,
      letterSpacing: "-0.035em",
      ...outline,
    },
    img(logo, Math.round(size * (branded ? 0.95 : 0.8)), { flexShrink: 0 }),
    h("div", { marginTop: -Math.round(size * 0.06) }, name),
  );
}

function luminance(color) {
  const hex =
    color.length === 4
      ? color
          .slice(1)
          .split("")
          .map((d) => d + d)
          .join("")
      : color.slice(1);
  return [0.2126, 0.7152, 0.0722].reduce(
    (sum, weight, i) => sum + weight * (parseInt(hex.slice(i * 2, i * 2 + 2), 16) / 255),
    0,
  );
}

/**
 * Two weeks of a workflow's runs on GitHub (a dot per run, a line through each day's median) and
 * the provider's evaluation runs as rings with a dashed median, like Performance's workflow chart.
 * Drawn as one SVG, with the axis labels laid over it as text.
 */
function runsChart(c, { width, height, today, them }) {
  const max = 6;
  const days = 14;
  const left = 34;
  const bottom = 22;
  const x = (day) => left + (day / (days - 1)) * (width - left - 6);
  const y = (min) => 6 + (1 - min / max) * (height - bottom - 6);
  // A fixed seed, so every provider's card shows the same history.
  let seed = 7;
  const noise = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  const medians = Array.from(
    { length: days },
    (_, day) => 3.4 + noise() * 0.7 + (day === 6 ? 1.1 : day === 7 ? 0.5 : 0),
  );
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`;
  for (const min of [0, 2, 4, 6])
    svg += `<line x1="${left}" x2="${width - 6}" y1="${y(min)}" y2="${y(min)}" stroke="${c.line}"/>`;
  medians.forEach((min, day) => {
    for (let run = 0; run < 2; run++)
      svg += `<circle cx="${x(day) + noise() * 14}" cy="${y(min + noise() * 0.8)}" r="2.5" fill="${today}" opacity="0.35"/>`;
  });
  svg += `<polyline points="${medians.map((min, day) => `${x(day)},${y(min)}`).join(" ")}" fill="none" stroke="${today}" stroke-width="2.5"/>`;
  medians.forEach((min, day) => {
    svg += `<circle cx="${x(day)}" cy="${y(min)}" r="3.5" fill="${today}"/>`;
  });
  [2.6, 2.05, 1.95, 2.1, 2.0].forEach((min, run) => {
    svg += `<circle cx="${x(10.6) + run * 9}" cy="${y(min)}" r="6" fill="none" stroke="${them}" stroke-width="2.5"/>`;
  });
  svg += `<line x1="${x(10.4)}" x2="${x(13)}" y1="${y(2.05)}" y2="${y(2.05)}" stroke="${them}" stroke-width="2" stroke-dasharray="5 4"/></svg>`;
  return h(
    "div",
    { position: "relative", width, height },
    {
      type: "img",
      props: {
        src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
        width,
        height,
        style: { position: "absolute", left: 0, top: 0 },
      },
    },
    [0, 2, 4, 6].map((min) =>
      h(
        "div",
        { position: "absolute", left: 0, top: y(min) - 8, ...mono(11, c.mute) },
        `${min}:00`,
      ),
    ),
    ["Nov 9", "Nov 13", "Nov 17", "Nov 21"].map((label, i) =>
      h(
        "div",
        { position: "absolute", left: x(i * 4) - 16, top: height - 16, ...mono(11, c.mute) },
        label,
      ),
    ),
  );
}

const down = (c) =>
  `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><polygon points="0,1 10,1 5,9" fill="${c.go}"/></svg>`).toString("base64")}`;

/** A smaller-is-better change in green with a down arrow, as in Performance's tables. */
const drop = (c, text, size) =>
  h(
    "div",
    { alignItems: "center", gap: 5, ...mono(size, c.go) },
    img(down(c), Math.round(size * 0.7), { flexShrink: 0 }),
    text,
  );

/** One runner as a row of Performance's Runners table: run time with its range and median, and cost. */
function rangeRow(c, fixed, { logo, label, tag, time, timeChange, range, tone, cost, costChange }) {
  const track = 110;
  const [low, high, median] = range;
  return h(
    "div",
    { alignItems: "center", gap: 12, padding: "15px 0", borderTop: `1px solid ${c.line}` },
    fixed(logo, 26),
    h(
      "div",
      { width: 140, flexDirection: "column" },
      h("div", { fontSize: 19, fontWeight: 700, whiteSpace: "nowrap" }, label),
      h("div", mono(12, c.mute), tag),
    ),
    h("div", { width: 52, ...mono(18, c.ink, 500) }, time),
    h("div", { width: 62 }, timeChange ? drop(c, timeChange, 14) : []),
    h(
      "div",
      { position: "relative", width: track, height: 10, borderRadius: 5, background: "#22272f" },
      h("div", {
        position: "absolute",
        left: low * track,
        width: (high - low) * track,
        height: 10,
        borderRadius: 5,
        background: tone,
        opacity: 0.45,
      }),
      h("div", {
        position: "absolute",
        left: median * track - 1.5,
        top: -5,
        width: 3,
        height: 20,
        borderRadius: 2,
        background: tone,
      }),
    ),
    h(
      "div",
      { marginLeft: "auto", flexDirection: "column", alignItems: "flex-end" },
      h("div", mono(17, c.ink), cost),
      costChange ? drop(c, costChange, 13) : [],
    ),
  );
}

/** A docs page's card: its sidebar section, title, description and address. */
export function docsCard({ section, title, description, url }) {
  const c = light;
  return h(
    "div",
    {
      width: 1200,
      height: 630,
      flexDirection: "column",
      justifyContent: "space-between",
      padding: "52px 72px 48px",
      borderTop: `12px solid ${c.go}`,
      background: c.bg,
      color: c.ink,
      fontFamily: "Hanken Grotesk",
    },
    brand(c, 26, "docs"),
    h(
      "div",
      { flexDirection: "column" },
      section ? h("div", { color: c.go, fontSize: 26, fontWeight: 600 }, section) : [],
      h(
        "div",
        {
          marginTop: 10,
          fontSize: title.length > 28 ? 64 : 80,
          fontWeight: 700,
          lineHeight: 1.04,
          letterSpacing: "-0.04em",
        },
        title,
      ),
      description
        ? h(
            "div",
            {
              marginTop: 18,
              maxWidth: 960,
              color: c.body,
              fontSize: 30,
              lineHeight: 1.35,
              lineClamp: 2,
            },
            description,
          )
        : [],
    ),
    h("div", { paddingTop: 24, borderTop: `1px solid ${c.line}`, ...mono(19, c.mute) }, url),
  );
}

/** The README hero: jobs going through relayrunner to a runner order, in either theme. */
export function readmeHero(theme) {
  const c = theme === "dark" ? dark : light;
  const job = (name) =>
    h(
      "div",
      {
        padding: "13px 16px",
        borderRadius: 10,
        border: `1px solid ${c.line}`,
        background: c.lane,
        ...mono(17, c.ink),
      },
      name,
    );
  const wire = h("div", { flexGrow: 1, height: 2, margin: "0 20px", background: c.go });
  return h(
    "div",
    {
      width: 1280,
      height: 480,
      alignItems: "center",
      padding: "0 72px",
      borderRadius: 24,
      border: `1px solid ${c.line}`,
      background: c.bg,
      color: c.ink,
      fontFamily: "Hanken Grotesk",
    },
    h(
      "div",
      { flexDirection: "column", gap: 12, width: 290, flexShrink: 0 },
      h("div", { ...caps(c), marginBottom: 2 }, "GitHub Actions"),
      job("ci / test"),
      job("ci / lint"),
      job("release / build"),
    ),
    wire,
    h(
      "div",
      { flexDirection: "column", alignItems: "center", gap: 10, width: 170, flexShrink: 0 },
      img(logo, 84),
      h("div", { fontSize: 22, fontWeight: 700 }, "relayrunner"),
    ),
    wire,
    h(
      "div",
      { flexDirection: "column", gap: 10, width: 400, flexShrink: 0 },
      h("div", { ...caps(c), marginBottom: 4 }, "Your runner order"),
      lane(c, { n: 1, id: "machines", name: "Your machines", state: "on" }),
      lane(c, { n: 2, id: "self-hosted", name: "Self-hosted runners" }),
      lane(c, { n: 3, id: "blacksmith", name: "Blacksmith" }),
      lane(c, { n: 4, id: "github", name: "GitHub-hosted" }),
    ),
  );
}

/** Renders an element to PNG bytes. `scale` draws it at that multiple of its CSS size. */
export async function renderPng(element, scale = 1) {
  const { width, height } = element.props.style;
  const markup = await satori(element, { width, height, fonts });
  const png = new Resvg(markup, { fitTo: { mode: "width", value: width * scale } })
    .render()
    .asPng();
  // A plain Uint8Array rather than a Node Buffer, so a Response takes it as a body.
  return new Uint8Array(png);
}
