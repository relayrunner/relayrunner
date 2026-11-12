// Share images (Open Graph cards) and the README hero, drawn with Satori and rasterized with resvg.
// The docs cards render at build time (src/pages/og/[...route].ts); the home card and the README
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

/** The home page card: a queued job skipping busy machines for the next runner in the order. */
export function homeCard() {
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
          fontSize: 72,
          fontWeight: 700,
          lineHeight: 1.02,
          letterSpacing: "-0.045em",
        },
        h("div", {}, "One router for"),
        h("div", { color: c.go }, "every CI runner."),
      ),
      h(
        "div",
        { marginTop: 24, color: c.body, fontSize: 24, lineHeight: 1.45 },
        "Run jobs on your own machines and send the rest to hosted runners when they're busy.",
      ),
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
      lane(c, { n: 1, id: "machines", name: "Your machines", note: "Busy", state: "off" }),
      lane(c, { n: 2, id: "blacksmith", name: "Blacksmith", note: "Takes the job", state: "on" }),
      lane(c, { n: 3, id: "github", name: "GitHub-hosted" }),
    ),
    h(
      "div",
      { position: "absolute", left: 72, bottom: 40, color: c.mute, fontSize: 18, fontWeight: 500 },
      "relayrunner.app",
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
  return new Resvg(markup, { fitTo: { mode: "width", value: width * scale } }).render().asPng();
}
