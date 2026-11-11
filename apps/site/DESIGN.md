---
name: RunnerDuty
description: Run your GitHub Actions on your own machine.
colors:
  go: "#3fb950"
  go-hover: "#4fcc61"
  go-ink: "#03140a"
  go-soft: "rgba(63, 185, 80, 0.14)"
  go-edge: "rgba(63, 185, 80, 0.55)"
  pulse: "#9af0a8"
  diff-add: "#7ee391"
  run: "#d29922"
  run-ink: "#1b1303"
  run-edge: "rgba(210, 153, 34, 0.5)"
  del: "#f0817a"
  bg: "#0b0d10"
  bg-deep: "#07080a"
  dormant: "#101317"
  raised: "#161a20"
  raised-2: "#1c2129"
  line: "#272c35"
  line-soft: "#1d2128"
  meter-track: "#23272f"
  route-idle: "#3a3f49"
  idle: "#4a515c"
  ink: "#e6edf3"
  ink-2: "#b4bcc6"
  mute: "#8b949e"
typography:
  display:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "min(64px, 4.45vw)"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  display-compact:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "clamp(36px, 10vw, 64px)"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "clamp(32px, 3.6vw, 48px)"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  wordmark:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    letterSpacing: "-0.01em"
  figure:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.02em"
  lede:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.6
  lede-page:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "clamp(17px, 1.4vw, 19px)"
    fontWeight: 400
    lineHeight: 1.55
  body:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.6
  body-compact:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.2
  caption:
    fontFamily: "Hanken Grotesk Variable, Hanken Grotesk, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  code:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.6
  code-block:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.75
  data:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.3
rounded:
  xs: "3px"
  tag: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  pill: "999px"
spacing:
  tight: "8px"
  row: "12px"
  panel: "14px"
  inset: "18px"
  block: "clamp(36px, 4vw, 56px)"
  split: "clamp(40px, 6vw, 96px)"
  section: "clamp(72px, 9vw, 128px)"
  gutter: "clamp(20px, 5vw, 72px)"
components:
  button-primary:
    backgroundColor: "{colors.go}"
    textColor: "{colors.go-ink}"
    rounded: "{rounded.md}"
    padding: "15px 18px"
  button-primary-hover:
    backgroundColor: "{colors.go-hover}"
    textColor: "{colors.go-ink}"
  button-outline:
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  button-demo:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "5px 10px"
  route-toggle:
    backgroundColor: "{colors.bg-deep}"
    textColor: "{colors.mute}"
    rounded: "{rounded.pill}"
    padding: "4px"
  route-toggle-local:
    backgroundColor: "{colors.go}"
    textColor: "{colors.go-ink}"
    rounded: "{rounded.pill}"
    padding: "9px 18px"
  route-toggle-hosted:
    backgroundColor: "{colors.run}"
    textColor: "{colors.run-ink}"
    rounded: "{rounded.pill}"
    padding: "9px 18px"
  panel:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
  panel-dormant:
    backgroundColor: "{colors.dormant}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.lg}"
  instruction-panel:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "{spacing.inset}"
  code-card:
    backgroundColor: "{colors.bg-deep}"
    textColor: "{colors.ink}"
    typography: "{typography.code-block}"
    rounded: "{rounded.lg}"
    padding: "18px 20px"
  command-badge:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
  chip-pick:
    textColor: "{colors.mute}"
    rounded: "{rounded.pill}"
    padding: "3px 9px"
  chip-pick-on:
    backgroundColor: "{colors.go-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "3px 9px"
---

# Design System: RunnerDuty

## Overview

**Creative North Star: "The Live Route"**

RunnerDuty's world is a working routing diagram drawn on near-black. Line, state and colour all describe one fact: where CI is running right now. Surfaces are quiet tonal slabs held by 1px hairlines, and the only saturated things on screen are route lines, status marks and the primary action. When the route changes, everything that reports it changes with it.

The density is that of a developer tool, not a brochure. Check rows, diffs, command lists and terminal cards are real content and sit at working sizes, with generous section spacing around them. A heavy grotesque speaks in short declarative headings, and a monospace carries the things a developer would actually type or read back. Depth comes from tone first. Motion is reserved for the route itself: pulses travel, lines draw, status marks resolve.

**Key Characteristics:**

- Near-black ground with tonal panels and 1px hairlines; no gradients, no blur.
- Route lines (3px, solid when live, dashed when idle) are the connective motif.
- Colour is signal: nearly everything off the route is neutral.
- Hanken Grotesk for the voice, JetBrains Mono for code, commands and data.
- Route state is global: one change repaints every element that reports it.

## Colors

A neutral blue-black field with two signal hues and one reserved coral, all tuned to read against dark panels.

> **Pending confirmation.** The colour semantics, green for your machine, the live route, passed states and the primary action, and amber for minutes being spent or a running job, are pending the user's confirmation. Treat the assignments in this section as provisional until then. Two cases to settle with that decision: a job running on your machine shows the amber spinner while the same panel reports 0 minutes billed, and queued jobs are also amber although they are neither running nor spending.

### Primary

- **Signal Green** (#3fb950): your machine, the live route, passed checks, the primary action. Also positive marks such as the "Built for" list, the brand mark, text selection, focus rings and skip link.
- **Bright Green** (#4fcc61): the primary action's hover fill, nothing else.
- **Green Ink** (#03140a): text and glyphs set on a green fill, such as the button label and the check inside a passed status mark.
- **Green Wash** (rgba(63, 185, 80, 0.14)): fill of a selected job chip.
- **Green Edge** (rgba(63, 185, 80, 0.55)): 1px edge of a surface lit by the local route, and of a selected chip.
- **Pulse Green** (#9af0a8): the bright head travelling along the page spine.
- **Added Line Green** (#7ee391): text of added diff lines, over a 12% Signal Green tint.

### Secondary

- **Meter Amber** (#d29922): the hosted route when active, quota ticks, the minutes meter and counter, running and queued status marks.
- **Amber Ink** (#1b1303): text set on an amber fill, such as the toggle label on the hosted route.
- **Amber Edge** (rgba(210, 153, 34, 0.5)): 1px edge of a surface lit by the hosted route.

### Tertiary

- **Removal Coral** (#f0817a): removed diff lines, over a 9% coral tint, and the "Not for" list heading.

### Neutral

- **Ground** (#0b0d10): the page, and the fill behind floating labels.
- **Well** (#07080a): recessed surfaces that hold code, terminals and the toggle track, plus the "Not for" column.
- **Dormant Slab** (#101317): a panel or destination the route is not on.
- **Raised Slab** (#161a20): standard panels and the instruction surface.
- **Raised Slab 2** (#1c2129): the user's chat bubble, one step above a raised panel.
- **Hairline** (#272c35): borders of every panel, card and control.
- **Soft Hairline** (#1d2128): dividers inside a panel, and the header and footer rules.
- **Meter Track** (#23272f): the unfilled part of a meter.
- **Idle Route** (#3a3f49): dashed route lines not carrying traffic.
- **Idle Ring** (#4a515c): the ring of a status mark that has no job. Non-text only, at 2.18:1 on a raised slab.
- **Ink** (#e6edf3): headings and primary text.
- **Ink 2** (#b4bcc6): secondary text that must stay prominent, such as list items and dormant panel titles.
- **Mute** (#8b949e): ledes, body copy in sections, captions and metadata. Holds at least 5.68:1 on every surface it sits on.

### Named Rules

**The Two Signals Rule.** Green means your machine, the live route, a passed state or the primary action. Amber means minutes being spent or a job running. Pending the user's confirmation; until then, new uses stay inside these meanings.

**The Reserved Coral Rule.** Coral marks removal and exclusion only: removed diff lines and the "Not for" list.

**The One Route Rule.** Route state is page-wide. Every element that reports the route (header status dot, toggle, panels, step terminals, closing destinations) changes together, and no element reports a stale route. The page spine belongs to your machine: solid green on the local route, dashed Idle Route on the hosted one.

**The Solid Means Live Rule.** Route lines are 3px with round caps, solid in the route colour when live and dashed 6 on, 8 off in Idle Route when not. Dashes appear nowhere else.

Shipped drift, not a rule: the step nodes on the spine stay green on the hosted route, while the spine itself goes dashed. New spine elements follow the route.

## Typography

**Display Font:** Hanken Grotesk Variable (with Hanken Grotesk, system-ui, sans-serif), self-hosted
**Body Font:** Hanken Grotesk Variable (same stack)
**Label/Mono Font:** JetBrains Mono Variable (with JetBrains Mono, ui-monospace, monospace), self-hosted, ligatures off

**Character:** A compact, tightly tracked grotesque that sounds certain at large sizes, paired with a plain monospace that reads as the machine talking back.

### Hierarchy

- **Display** (700, up to 64px, 1.02, -0.035em): the one page headline, balanced, one sentence per line. Below 1080px it moves to Display Compact; on short desktop viewports min(56px, 4.2vw).
- **Display Compact** (700, clamp(36px, 10vw, 64px), 1.02, -0.035em): the same headline once the page is a single column.
- **Headline** (700, clamp(32px, 3.6vw, 48px), 1.08, -0.03em): section headings, balanced, capped at 22ch.
- **Title** (700, 21px, 1.25, -0.01em): step and sub-section headings.
- **Wordmark** (700, 20px, -0.01em): the brand name beside its mark, 16px in the footer.
- **Figure** (700, 24px, 1, -0.02em, tabular): live counts such as minutes used, in the signal colour. 20px at phone widths.
- **Lede** (400, 18px, 1.6): section introductions in Mute, capped at 62ch.
- **Lede Page** (400, clamp(17px, 1.4vw, 19px), 1.55): the single introduction under the page headline, capped at 46ch.
- **Body** (400, 17px, 1.6): running copy, capped at 46 to 52ch beside a figure.
- **Body Compact** (400, 16px, 1.5): chat messages, and body copy at phone widths, where line height stays 1.6.
- **Label** (600, 15px, 1.2): check names, toggle options and control text. Panel titles step up to 700.
- **Caption** (400, 13px, 1.4): figure captions and notes under a demonstration.
- **Code** (500, 15px, 1.6): terminals. Copyable instructions use the same size at 400.
- **Code Block** (400, 14px, 1.75): multi-line command output and diffs.
- **Data** (400, 12px, 1.3, tabular): runner labels, check timing, scales.

### Named Rules

**The Code Voice Rule.** JetBrains Mono carries code, commands and data only. Everything a person would say is Hanken Grotesk.

Shipped drift, not a rule: the agent setup card has a sentence-length head set in mono. Mono card heads are for paths and tool names. Check timing and panel feet also shrink to 11px at phone widths; that is a squeeze the build makes for space, not a step on this ramp.

**The Tabular Figures Rule.** Numbers that change in place use tabular figures, so a climbing counter never shifts its neighbours.

## Layout

Content sits in a 1440px maximum container with a fluid side gutter (clamp(20px, 5vw, 72px)). The left gutter is not empty margin: the page spine runs down its centre, and step nodes sit on it, so nothing else may occupy that strip.

Sections stack on a shared vertical rhythm (clamp(72px, 9vw, 128px) top and bottom). Two-part sections use an asymmetric 5:7 split, copy left and evidence right, separated by clamp(40px, 6vw, 96px). Peer content uses equal columns. Internal spacing is a working set rather than a modular scale: 8 to 12px inside groups, 14 to 18px of panel padding, 12 to 18px from a heading to its copy, and clamp(36px, 4vw, 56px) from a section intro to its content.

The header is sticky at 72px on a flat 92% Ground fill, and gains a Soft Hairline only after scrolling. In-page anchors clear it with 88px of scroll padding.

Responsive behaviour is staged. At 1240px wide, the route status drops its "CI route:" prefix. At 1080px, every two-column split collapses to one column. At 760px, equal columns stack, the first two nav links drop out and the wide instruction panel stacks. At 520px, code wraps instead of scrolling, panels tighten to 10 to 11px of padding and the spine narrows to 2px. Desktop viewports under 800px tall compress vertical spacing so the first view still fits.

## Elevation & Depth

A tonal system with a small amount of state-driven shadow. Depth steps run Well, Ground, Dormant Slab, Raised Slab, Raised Slab 2, each separated by a hairline; most surfaces carry no shadow at all. Code recedes into the Well, and working surfaces rise onto the Raised Slab. A panel the route is not on drops to Dormant Slab and a Soft Hairline.

### Shadow Vocabulary

- **Terminal Lift** (`box-shadow: 0 24px 48px -28px rgba(0, 0, 0, 0.8)`): neutral lift under the floating terminal where a route begins. The only shadow present at rest.
- **Route Lift** (`box-shadow: 0 24px 60px -28px color-mix(in srgb, <route colour> 45%, transparent)`): under the active check panel, in either route colour.
- **Local Lift** (`box-shadow: 0 20px 50px -30px rgba(63, 185, 80, 0.45)`, and `0 20px 50px -24px rgba(63, 185, 80, 0.5)` on closing destinations): under a surface lit by the local route. The hosted equivalents ship with an amber edge and no lift.

Route Lift and Local Lift are recorded because they shipped, not as an endorsed device. The Impeccable detector carries an open `dark-glow` warning against them, and that warning has not been resolved.

### Named Rules

**The Lit Edge Rule.** An active surface is announced by a route-coloured 1px edge and a Raised Slab fill. That edge is the signal; coloured lift is secondary and does not extend to new surfaces while the detector warning stands.

**The Tone First Rule.** Separate surfaces with tone and hairlines. Shadows respond to route state, with the single exception of Terminal Lift.

## Shapes

Gently rounded rectangles, stepped by the size of the thing: 3px for meter bars and diff lines, 4px for floating data tags and the tail corner of a chat bubble, 6px for small controls and inline badges, 8px for buttons and the quota bar, 10px for panels and code cards, 12px for large composite surfaces. Fully round forms are reserved for things that are states or choices: the route toggle, job chips, status marks and pulses. The route line's curves are the system's one free-form shape, and they run as smooth béziers from a junction to each destination. Corners on the spine use a radius of up to 28px. The brand mark is the same fork in miniature, drawn in a round-capped stroke.

## Components

### Buttons

Decisive and plain: one solid action per view, everything else recedes.

- **Shape:** gently rounded (8px); small demo controls 6px.
- **Primary:** Signal Green fill, Green Ink label at 700 and 17px, 15px by 18px padding, drawn copy icon at 19px. Fills its panel when stacked, and sizes to content inside the wide instruction panel.
- **Hover / Focus:** fill moves to Bright Green over 0.2s; press scales to 0.985 on the ease-out curve; focus shows the global 2px Signal Green ring at a 3px offset.
- **Confirmation:** on copy, the icon swaps to a check and the label names what happened and what to do next, then resets after 2.6s.
- **Outline:** transparent with a Hairline border and Ink label; hover moves the border to Mute.
- **Demo control:** Raised Slab, Hairline border, 600 at 13px. When its route is current it disables, loses its border and fill, and takes the route colour as text.

### Chips

- **Style:** pill outline with Hairline border, Mute text, mono 500 at 13px, used for job names.
- **State:** selected chips take Green Wash, Green Edge and Ink text.

### Cards / Containers

- **Corner Style:** 10px for panels and code cards, 12px for composite surfaces such as the instruction panel, chat and comparison blocks.
- **Background:** Raised Slab for working surfaces, Well for code, Dormant Slab for inactive panels.
- **Shadow Strategy:** flat at rest; see Elevation & Depth.
- **Border:** 1px Hairline outside, Soft Hairline between head, rows and foot.
- **Internal Padding:** 14 to 18px; panel heads and check rows 11px by 14px.

### Navigation

Text links in Mute at 15px that rise to Ink on hover over 0.2s, with 32px between items. The route status sits inline as a coloured 8px dot and an Ink route name, so the header always reports the route. A single outline button closes the row.

### Route Toggle (signature)

A pill track in the Well with a sliding thumb in the route colour, two equal options, 600 at 15px. The thumb moves over 0.5s on the ease-out curve, its colour crossfades over 0.4s and the selected label takes the matching ink. It is a radio group, so arrow keys switch the route. A small command badge below it (mono 500 at 13px, Raised Slab, 6px) shows the equivalent command.

### Route Line (signature)

Three stacked strokes on the page spine (a base, a live stroke drawn by scroll position, and a travelling pulse), and a trunk with two béziers around each junction. Pulses are 5.5px dots with an 11px halo at 18% opacity for a real job, and 3px dots for ambient traffic, taking 1.5s from origin to destination with an eased arrival. Route colour transitions take 0.5s. With reduced motion, the page holds a static local route: the spine is drawn in full, nothing travels and checks show as passed.

### Check Panel

A GitHub-style run list: head with title and runner label, check rows of a status mark, name and timing, and a foot with the meter or billing state. Status marks are 16px circles: an Idle Ring when empty, an amber ring when queued, a spinning amber arc at 0.9s when running, and a solid green disc with a drawn check when passed. The meter is a 6px bar on Meter Track. Panels transition between lit and dormant over 0.6s.

### Code Card

A Well surface with a Soft Hairline head. Terminals show a Mute `$` prompt, Ink commands and Ink 2 output. Diffs show context in Mute, removals in coral and additions in Added Line Green, each on a faint tint that runs the full line width with a 3px radius. Long lines scroll sideways until phone widths, where they wrap.

## Do's and Don'ts

### Do:

- **Do** use the frontmatter tokens, which map one-to-one to the custom properties in the stylesheet where those exist.
- **Do** draw every route as a 3px round-capped line that is solid when live and dashed 6 on, 8 off when idle.
- **Do** repaint every route-reporting element together when the route changes.
- **Do** use 1px Hairline borders and tonal steps before reaching for a shadow.
- **Do** announce an active surface with a route-coloured 1px edge and a Raised Slab fill.
- **Do** use tabular figures for any number that updates in place.
- **Do** theme browser surfaces from the palette: Signal Green selection with Green Ink text, a 2px Signal Green focus ring at a 3px offset, and a dark scrollbar over Ground.
- **Do** use the ease-out curve (cubic-bezier(0.16, 1, 0.3, 1)) for movement, and give every animated state a static reduced-motion form.
- **Do** draw icons as SVG with round caps and a consistent 2.2 to 2.4 stroke.

### Don't:

- **Don't** use coral for the hosted route, for general warnings or for decoration.
- **Don't** set sentences or interface labels in JetBrains Mono.
- **Don't** use Idle Ring or Idle Route for text; neither reaches a readable contrast.
- **Don't** use dashed lines for dividers or borders; a dash always means an idle route.
- **Don't** use gradients or backdrop blur; the header scrim is a flat fill.
- **Don't** extend coloured lift to new surfaces while the `dark-glow` warning stands.
- **Don't** place a small label above a heading; the heading carries the section on its own.
- **Don't** place content in the left gutter, which belongs to the spine.
