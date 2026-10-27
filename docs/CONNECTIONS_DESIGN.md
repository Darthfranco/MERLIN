---
name: MERLIN Connection Center
description: Scoped design reference for the local, simulated connection directory and setup guides.
colors:
  action-blue: "#185c9e"
  action-hover: "#104778"
  action-soft: "#eaf2f9"
  focus-blue: "#1264ac"
  ink: "#172a3b"
  muted-ink: "#4e6070"
  page: "#f4f6f8"
  surface: "#ffffff"
  divider: "#d8e0e7"
  field-border: "#718596"
  secondary-border: "#bccbd7"
  connected-ink: "#185d38"
  easy-ink: "#245d40"
  easy-surface: "#edf5ef"
  medium-ink: "#73521c"
  medium-surface: "#faf3e7"
  hard-ink: "#82433b"
  hard-surface: "#f8efed"
  error-ink: "#943414"
  error-surface: "#fff2ec"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    lineHeight: 1.5
  headline:
    fontSize: "2rem"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.03em"
  title:
    fontSize: "1.15rem"
    lineHeight: 1.2
  row-title:
    fontSize: "0.96rem"
    fontWeight: 650
    lineHeight: 1.4
  description:
    fontSize: "0.84rem"
  label:
    fontSize: "0.76rem"
    fontWeight: 600
rounded:
  badge: "4px"
  control: "6px"
  notice: "8px"
  panel: "12px"
spacing:
  compact: "8px"
  control: "12px"
  group: "16px"
  section: "24px"
  column: "32px"
components:
  button-primary:
    backgroundColor: "{colors.action-blue}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.action-blue}"
    rounded: "{rounded.control}"
  text-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 12px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
---

# Design System: MERLIN Connection Center

## Overview

**Creative North Star: "Simple and functional"** — inherited from the existing prototype.

This is a scoped Operate utility surface extending [MERLIN's existing design reference](../DESIGN.md). It records the built [HTML](../public/connections/index.html), [CSS](../public/connections/styles.css), and [interactions](../public/connections/app.js), rather than replacing the project's identity or selecting its final application platform. The owner's task is find a company or category, understand setup effort, try a simulated connection, and manage that selection. Product boundaries and maintenance instructions remain in [Connection Center](CONNECTIONS.md).

The built directory contains 45 routes across 15 categories. Persistent demo disclosure, compact rows, and an ordinary setup page keep exploration understandable. There are no account/device API calls; Connected records a catalog ID in this browser only.

**Key Characteristics:**

- Search and filters precede a readable directory.
- Setup effort and connection state have explicit text labels.
- Flat white surfaces, dark ink, restrained blue actions, and familiar controls inherit the local prototype.
- Setup guides occupy the page, with ordinary back navigation and no modal.

The degraded regex detector's palette/type/radius advisories compare this surface with the older text harness. Additional difficulty colors, a larger directory heading, compact badge corners, and stronger field borders are scoped differences recorded here. They do not establish a new global visual world. Review evidence is in [browser QA](../.impeccable/review/connections/qa.json); the six adjacent raster files are screenshots of authored UI, not shipping imagery. The UI uses original simple SVG geometry, no external font or media, and no added package dependency.

Final scoped review disposition: **ship** after the field-boundary correction. All six final captures were refreshed; browser QA, 21 focused tests, and the full 444-test run are recorded in [STATUS.md](STATUS.md). These checks do not establish live integration support or constitute a complete accessibility audit.

## Colors

Action blue identifies links and controls; its soft tint marks current navigation and supports the demo banner. Dark ink and muted ink separate route names from explanations on the pale page and white content surfaces. Green supports the simulated Connected state; Easy, Medium, and Hard use green, amber, and warm red tinted badges. Availability restrictions remain visible as text.

**The Labeled State Rule.** Color reinforces the words Easy, Medium, Hard, and Connected in demo mode; it never substitutes for them.

**The Field Boundary Rule.** Inputs and selects use the stronger field-border token, which clears 3:1 against adjacent white and page surfaces. The lighter divider token separates content regions and must not replace an interactive field boundary.

## Typography

The inherited native system stack is a utility-interface choice. It is not a new display identity. The headline token is the desktop directory heading; setup titles are slightly smaller (1.8rem), and both become compact on mobile (1.7rem). Row titles, body descriptions, and smaller labels establish a short scanning hierarchy. Guide prose uses a modest reading size (0.86rem) and a bounded measure (65ch). Counts use tabular numerals to avoid visual shifts.

**The Useful Hierarchy Rule.** Route names and actions carry emphasis; category metadata and supporting guidance remain subordinate. Keep labels readable without introducing decorative headings.

## Layout

The centered page has a maximum width (1320px), desktop side padding (32px), and a compact brand/navigation bar. The demo banner remains above both the directory and setup view. Search fills the main filter row, followed by Company and Setup difficulty selectors. Desktop uses a category rail (212px), a column gap (32px), and one bordered list containing rows; each row aligns its description, difficulty, and action. The rail becomes sticky at wide sizes (1100px and above).

At the intermediate breakpoint (1050px), columns tighten and row icons temporarily disappear. At mobile width (760px and below), search spans the row, company/difficulty selectors share the next row, and a labeled Category selector replaces the rail. Rows place the description above the rating/action pair. The narrow breakpoint (380px) reduces padding and stacks the demo notice. This is a responsive list, not a card grid.

Setup is a two-column page with summary/details beside the guide; on mobile, summary precedes guide in one column. The hash route identifies the selected entry. Returning from setup restores list filters, scroll position, and the initiating control's focus; top-level Browse/Connected navigation resets filters.

## Elevation & Depth

White fill, pale canvas, and single-pixel separators define hierarchy. There are no shadows, gradients, or decorative animations. The toast is a fixed dark status surface. Buttons transition background and border color briefly (140ms); reduced-motion preference removes transitions.

**The Flat Surface Rule.** Maintain separation through fill, spacing, and borders on this utility surface.

## Shapes

Small control corners, slightly rounder notices, and larger container corners use the documented radius tokens. Difficulty badges and numeric counts use the compact badge radius. Circular difficulty dots and numbered guide markers reinforce text; they are not standalone controls. Original line SVGs identify categories without implying vendor affiliation or verified hardware support.

## Components

- **Buttons:** guide confirmation uses filled blue; list actions and secondary actions use white bordered controls. Easy routes offer Connect directly, while Medium/Hard routes offer View setup. Every route name opens its guide. Connected rows show a check, Connected, and Demo · Manage, and open that entry's setup page. Buttons and form controls have a minimum height (44px); desktop search/filter fields are taller (54px).
- **Search and filters:** query, company, category, and difficulty combine locally. Search matches company names, aliases, devices, and categories, ignoring case and accents. The search has an accessible label and a named clear control; selects have visible labels. Reset filters returns focus to search. No-match and no-connections states provide different explanations and recovery actions.
- **Navigation:** Browse/Connected uses current-page semantics; desktop category buttons expose their selected state. Counts describe available routes/selections, never reachable devices. Mobile category selection stays synchronized with the desktop state.
- **Setup guide:** summary, household difficulty explanation, prerequisites, numbered steps, limitations, and an official reference precede the local demo action. Real setup instructions are reference material; completing them is not required to try the demo. The reference opens a separate tab only when clicked.
- **Connection state:** Connect adds an allowed catalog ID to versioned local browser storage. Disconnect removes it; clear-all requires an inline confirmation. The page remains usable when storage fails, with a visible warning. Do not turn temporary in-session selection into a claim of durable persistence. Cross-tab changes update the UI and retain a useful focus destination.
- **Feedback and access:** a skip link reaches main content; visible keyboard focus uses an outline (3px) and offset (3px). Setup navigation focuses its title. Result counts and outcome toasts use polite status announcements; result announcements are delayed briefly (180ms). Toasts expire (4.5 seconds), while connection state and storage warnings remain visible in the page. Clear-all focuses Keep connections first and restores an appropriate navigation/control target after dismissal.

## Do's and Don'ts

- **Do** preserve the demo banner and local-state wording through every view.
- **Do** describe difficulty as household setup effort, retaining route prerequisites and restrictions.
- **Do** keep visible focus, accessible names, text state labels, filter-preserving back navigation, and reduced-motion support.
- **Do** preserve browser-only ID storage and visible failure feedback when extending this prototype.
- **Don't** present Connected as authorized, discovered, tested, or controllable hardware.
- **Don't** collect credentials or imply that a setup-guide step ran through this interface.
- **Don't** promote this scoped directory composition, system typography, or review screenshots into MERLIN's final product identity.
