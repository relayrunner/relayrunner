---
version: 1
slug: "apps-site"
primary_target: "apps/site"
related_targets: []
---

# Landing page (apps/site)

Mode: Persuade. Audience: individual developers whose coding agents burn a private repo's GitHub Actions minutes. Action: copy the agent setup instruction (CLI install is the secondary path). Proof: the real `runs-on` patch, real CLI commands and output, GitHub check rows. Constraints: dark theme; honest caveats (private repos, trusted workflow authors, jobs run as your local user, a relief valve rather than infrastructure); demo data labelled as a simulation.

## Direction contract

THESIS: The page is a live routing diagram. A `git push` forks toward GitHub-hosted or your machine and lands in GitHub's own check rows, so the visitor sees the same CI with a different runner. It refuses the static terminal-screenshot developer landing page.

OWN-WORLD: Near-black ground #0b0d10, raised panels #161a20, 1px #272c35 hairlines, signal green #3fb950 means your machine, the live route, passed or positive states, and the primary action; amber #d29922 means minutes being spent or a job running (so the hosted route, quota ticks and meter are amber); coral #f0817a is reserved for removed diff lines and the "Not for" list. Hanken Grotesk for display and UI, JetBrains Mono only for code, commands and data. Route lines (3px, solid when live, dashed when idle) carrying travelling pulses are the connective motif: one spine leaves the Your machine panel, runs down the left gutter through every section, draws with scroll, and forks again at the closing CTA.

STORY: The visitor recognizes the quota pain, watches a push re-route to their machine with the same checks, believes the switch is one command and reversible, and copies the agent instruction.

FIRST VIEWPORT: Left column (~560px): headline "Same checks. Your machine. No minutes burned.", lede, instruction panel with a full-width copy button, CLI alternative under it. Right: terminal `git push` card, route line into a junction holding a working GitHub / Your machine toggle, fork into two check panels; the active panel lit, checks progressing; hosted panel shows a minutes counter that only climbs while hosted is active.

FORM: Category standard (canon), fork-into-checks variant C chosen from three fork heroes. seed:9dae6244f58da440

SIGNATURE INTERACTION: The route toggle re-routes the pulses, swaps which check panel runs, and freezes or resumes the minutes counter; the demo auto-flips once, then hands control to the visitor. A click pushes immediately down the new branch. Route state is page-wide: header status, step terminals, spine and closing fork all follow it. Reduced motion holds a static local-route state.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
