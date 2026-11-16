/*
 * The agent setup guide and the agent skills, served from the site so a coding agent can follow
 * them without leaving it: /setup.md is docs/agent-install.md, and /skills/<name>/... are the files
 * in skills/. The repo files stay the source. Their raw GitHub links are rewritten to the site's
 * own URLs at build time, so the guide and skills point at whichever domain the site is built for.
 */

const guide = import.meta.glob("../../../../docs/agent-install.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const skills = import.meta.glob("../../../../skills/*/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const RAW_SKILLS = "https://raw.githubusercontent.com/relayrunner/relayrunner/main/skills/";

export const SETUP_PATH = "/setup.md";
export const skillPath = (file: string) => `/skills/${file}`;

/** Points raw GitHub links to the skills at the site's copies. */
const onSite = (text: string, site: URL) =>
  text.replaceAll(RAW_SKILLS, new URL(skillPath(""), site).href);

/** The setup guide, with its skill links on the site. */
export function setupGuide(site: URL): string {
  const [text] = Object.values(guide);
  if (!text) throw new Error("docs/agent-install.md is missing");
  return onSite(text, site);
}

/** Every skill file, by its path under skills/ (like `relayrunner/SKILL.md`). */
export const skillFiles = () =>
  Object.entries(skills).map(([path, text]) => ({
    file: path.slice(path.indexOf("/skills/") + "/skills/".length),
    text,
  }));

/** A skill file's text, with its skill links on the site. */
export const skillText = (text: string, site: URL) => onSite(text, site);

/** The one-line prompt users paste into their agent. */
export const setupPrompt = (site: URL) =>
  `Set up relayrunner in this checkout using ${new URL(SETUP_PATH, site).href}`;
