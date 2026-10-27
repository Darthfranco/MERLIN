---
name: MERLIN text prototype
description: Simple, functional local interface for testing Meta search and timer requests.
colors:
  action-blue: "#185c9e"
  action-hover: "#104778"
  action-soft: "#eaf2f9"
  focus-blue: "#1264ac"
  ink: "#172a3b"
  muted-ink: "#4e6070"
  page: "#f4f6f8"
  surface: "#ffffff"
  border: "#ccd5dd"
  input-border: "#8b9eae"
  disabled-surface: "#e3e8ed"
  disabled-ink: "#526373"
  error-ink: "#943414"
  error-surface: "#fff2ec"
  complete-ink: "#185d38"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    lineHeight: 1.5
  headline:
    fontSize: "1.65rem"
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontSize: "1.15rem"
    lineHeight: 1.2
  label:
    fontSize: "0.92rem"
    fontWeight: 600
  help:
    fontSize: "0.86rem"
  countdown:
    fontSize: "1.65rem"
    fontWeight: 600
rounded:
  control: "6px"
  notice: "8px"
  panel: "12px"
spacing:
  compact: "8px"
  control: "12px"
  group: "16px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.action-blue}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.action-blue}"
    rounded: "{rounded.control}"
  text-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
    padding: "22px"
---

# Design System: MERLIN text prototype

## Overview

The owner’s direction is **simple and functional**. This document captures the implemented local text test harness in [public/styles.css](public/styles.css), [public/index.html](public/index.html), and [public/app.js](public/app.js). It is a reference for maintaining this prototype, not a commitment to MERLIN’s final product design or platform.

Readable text, familiar form controls, and explicit execution states make the typed request → Meta → tool → response loop inspectable. The established brief is in [PRODUCT.md](PRODUCT.md); page composition is recorded in [docs/PROTOTYPE_DESIGN.md](docs/PROTOTYPE_DESIGN.md).

## Colors

Action blue identifies primary controls and secondary action text. Pale neutral backgrounds, white panels, dark ink, and muted supporting text carry the main interface. Borders separate regions without decoration. Error notices use warm text on a pale warm surface; completed timers use green text. Every state also has a text label, so color never carries the outcome alone.

## Typography

Use the native system font stack throughout. A compact heading hierarchy keeps controls and current information prominent. Assistant text preserves line breaks and is limited to a readable measure (72ch). Countdown numerals use tabular figures to avoid shifting as time changes. Help, time zones, and privacy text remain visibly subordinate without replacing labels.

## Layout

The page is centered with a maximum width (1240px) and outer padding (28px). The prototype has a wider conversation column and a timer column, separated by the section spacing token. Panels use the documented panel padding.

At the tablet/mobile breakpoint (760px), the columns stack, panel padding becomes (18px), and page padding becomes (20px 16px). At the narrow breakpoint (380px), the header and composer actions stack and the send button takes the available width. Conversation history scrolls within its region; the composer remains outside that scroll region.

## Elevation & Depth

Surfaces are flat. White panels, pale page fill, and single-pixel borders provide separation. There are no shadows, gradients, or decorative animations in this prototype.

## Shapes

Controls use the smallest corner token, notices the middle token, and main panels the largest token. Inputs and secondary buttons have visible borders. Main controls and disclosure controls provide a minimum interaction height (44px).

## Components

- **Buttons:** primary blue for sending or starting; bordered white for secondary actions and examples. Hover darkens the primary control or lightly tints secondary controls. Disabled buttons have explicit muted colors and a disabled cursor. Keyboard focus uses a blue outline (3px) offset from the control (3px).
- **Fields:** visible labels, full-width inputs, and a vertically resizable message field. Enter sends a message; Shift + Enter inserts a line break. Busy requests make their fields read-only and show a working label.
- **Conversation:** plain text entries identify the speaker. Tool results and safe source links accompany replies. Failed and uncertain requests preserve entered text and display distinct recovery guidance.
- **Timers:** rows show a label, textual status, tabular countdown, explicit end time and time zone, and a Cancel or Dismiss action. Polling updates existing rows so keyboard focus is not discarded. Completion announcements use a separate polite live region rather than announcing every countdown tick.
- **Spotify:** the local panel follows the same labeled fields, blue primary actions, and bordered secondary controls. App setup and shuffle/repeat use disclosures; playback, device selection, and music search remain distinct groups. The displayed playback state comes from Spotify, while action feedback describes acceptance separately. Device selection does not itself start playback. Music and device details stay in this panel; the privacy note distinguishes that boundary from text entered into chat.
- **Notices:** configuration guidance, connection state, errors, and persistence warnings are explicit. The expandable manual timer form states that it bypasses Meta.

## Do's and Don'ts

- **Do** retain visible labels, keyboard focus, readable contrast, and text descriptions of state.
- **Do** show actual tool outcomes, sources, timer state, and connection failures.
- **Do** keep the temporary test scope clear when extending this interface.
- **Don't** imply that a requested action succeeded before execution confirms it.
- **Don't** render external reply or tool content as HTML.
- **Don't** treat this prototype’s visual choices as approval of MERLIN’s final interface.

Reviewer disposition: **ship** for the owner-authorized simple, functional test scope. No required design fixes remain in this review.
