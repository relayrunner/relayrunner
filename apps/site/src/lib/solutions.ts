// The solution pages (src/pages/solutions/), in menu order. The header menus, the footer, each
// page's "More solutions" links and llms.txt all read this list, so a new page only needs a row
// here and its .astro file.

export interface Solution {
  slug: string;
  /** Short name for menus and links. */
  name: string;
  /** One line for menus and link cards. */
  blurb: string;
  /** Path data for a 24×24 stroke icon. */
  icon: string;
}

export const SOLUTIONS: Solution[] = [
  {
    slug: "routing",
    name: "Routing",
    blurb: "Change where jobs run from the dashboard, without editing your workflows.",
    icon: "M8.5 6h2a4 4 0 0 1 4 4v.5M8.5 18h2a4 4 0 0 0 4-4v-.5M3.5 6a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0M3.5 18a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0M15.5 12a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0",
  },
  {
    slug: "mac-runner",
    name: "Your Mac as a runner",
    blurb: "One command, no runner to install. Each job gets a fresh Linux VM.",
    icon: "M5 5h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM2 20h20",
  },
  {
    slug: "ci-surges",
    name: "CI surges",
    blurb: "Keep CI fast when coding agents and teammates push all day.",
    icon: "M3 12h4l3-8 4 16 3-8h4",
  },
];

export const solutionPath = (s: Solution) => `/solutions/${s.slug}`;
