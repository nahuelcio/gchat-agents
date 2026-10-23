---
name: artifacts
description: Designed HTML pages teammates open inline in team chat — reports, dashboards of numbers, explainers, demos, quizzes. Use when an answer is a page to read or use, not a chat message.
mcps: [switchboard]
---

You publish **artifacts**: self-contained HTML pages that open in the side pane of team chat and can be shared by link.

## When

Reach for an artifact when any of these hold:

- **Comparison.** Two or more options the reader must weigh. Side by side beats stacked.
- **Spatial information.** Diffs, call graphs, module maps, flowcharts, timelines, before/after.
- **Interaction matters.** Parameter tuning, state machines, simulations: things the reader needs to feel.
- **Reference material.** Navigated non-linearly: tabs, collapsibles, jump links.
- **Color or hierarchy carries meaning.** Severity, status, data series.
- **Data.** More than a dozen numbers, a trend, a distribution.
- **One-off editor.** The reader manipulates something (triage, flags, a prompt) and needs the result back as text.
- **It will be shared.** A report to a team, a spec, a post-mortem.
- **Length.** Anything that would be a wall of markdown in chat.

## When not

- Conversational replies or a few sentences; short lists or a single Mermaid diagram (use markdown / ```mermaid)
- Code, config, commands or a diff the user will apply
- Fast iteration on something disposable
- Spreadsheets (use `create_xlsx`); editing the repo (use coding tools)

If unsure, ask yourself: *will the reader do anything with this beyond reading it once?* If not, markdown.

## References

Read the matching file before drafting; read two if the request spans categories.

| If the request is about… | Read… |
|---|---|
| Option comparisons, implementation plans, exploring directions | `references/exploration-and-planning.md` |
| Annotated diffs, PR writeups, code review, module maps | `references/code-review-and-pr.md` |
| Design tokens, component sheets, mockups, interaction prototypes | `references/design-and-prototypes.md` |
| Inline SVG figures, flowcharts, architecture diagrams | `references/diagrams-and-illustrations.md` |
| Charts, dashboards, sortable/filterable tables, metrics | `references/data-and-charts.md` and `references/examples/04-status-report.html` |
| Status reports, post-mortems, explainers, learning material | `references/reports-and-research.md` |
| Slide decks, arrow-key presentations | `references/decks.md` |
| One-off editors: triage boards, flag toggles, prompt tuners | `references/custom-editors.md` |
| Baseline CSS and the list of AI-look tells to avoid | `references/matching-your-style.md` |
| Accessibility and print checklist | `references/accessibility-and-print.md` |

Finished pages to study, all within the contract below: `references/examples/` has `01-sse-comparison`, `02-iri-explainer`, `03-triage-editor`, `04-status-report`, `05-flowchart`, `06-deck`, `07-code-review`, `08-design-tokens`, `09-postmortem` (`.html`). Open the one closest to the request for structure, not to copy its palette.

These references come from [dogum/html-artifacts](https://github.com/dogum/html-artifacts) (Apache-2.0), adapted to this page contract. Where they conflict with the contract below, the contract wins: no external scripts, no storage dependence. Editors must export back to text; clipboard access can fail in the iframe, so always also show the export in a selectable `<textarea>`.

## How to publish

Everything you need is here. Do not read Switchboard's source, the admin API or other templates to find out how publishing works.

1. Gather the content first (queries, files, facts). Write the page once, at the end.
2. Call `create_artifact` with `title` and `html`.
3. Reply with a short intro and the returned **marker** on its own line. Never paste HTML into chat and never invent a marker.

For a quick quiz, step list, two-column comparison or card grid with no design work, `template` + `fields` still works; see `references/templates.md`. Prefer `html` for anything that carries real data.

## The page contract

The server wraps your `html` in a document with charset, viewport and `<title>`, so send content only: a `<style>` block first, then the markup, then any `<script>`. A full document also works; its `<head>` styles are kept.

The page runs in a sandboxed iframe with this Content-Security-Policy. Anything else is silently blocked:

| Allowed | Blocked |
| --- | --- |
| Inline `<style>` and `style=""` | External stylesheets other than Google Fonts |
| Google Fonts: `<link href="https://fonts.googleapis.com/css2?...">` | |
| Inline `<script>` | Every external script (no CDNs: no Chart.js, React, Tailwind, Mermaid) |
| Images from `data:` or `https:` | `fetch`/XHR/WebSocket to anywhere |
| Forms and buttons handled in script | `localStorage`, cookies (opaque origin: wrap any access in try/catch) |

Max size 400 KB. Draw charts yourself with inline SVG (bars, lines, sparklines are a few lines each). Links open in a new tab.

## Design

Treat the page like a designer at a small studio would: deliberate palette, real typography, and a layout that fits this subject. Most pages are utilitarian (reports, plans): polished, not flashy. No giant hero.

**Tokens and themes.** Put the plan at the top of the `<style>` as tokens, then use only tokens:

```css
/* Layout: one line on the concept */
:root { --bg: …; --surface: …; --fg: …; --muted: …; --line: …; --accent: …;
        --good: …; --warn: …; --bad: …;
        --font-display: "…", system-ui, sans-serif; --font-body: "…", system-ui, sans-serif; --font-mono: "…", ui-monospace, monospace; }
@media (prefers-color-scheme: dark) { :root { --bg: …; --surface: …; --fg: …; --muted: …; --line: …; --accent: …; color-scheme: dark; } }
body { background: var(--bg); color: var(--fg); font-family: var(--font-body); }
```

Every color is defined on bare `:root` first and only redefined in the dark block. `body` always sets its own background. Never use a literal color in a component rule. Give the dark theme the same care as the light one; do not just invert it.

**Type.** Pair a characterful display face (used sparingly, for headings) with a readable body face, plus a mono face for numbers and code if needed. Load them from Google Fonts with a real fallback stack. Avoid defaulting to Inter or Space Grotesk. Keep running text near 65 characters wide, headings with `text-wrap: balance`, and `font-variant-numeric: tabular-nums` wherever digits line up.

**Layout.** Use grid/flex with `gap`, not per-element margins. Side gutter of at least 16px. Must work at 400px wide with no horizontal page scroll: rows wrap, children holding text get `min-width: 0`, wide tables and SVGs scroll inside their own `overflow-x: auto` box.

**Hierarchy.** Summary before detail. For a report: a status line at the top (healthy / watch / problem and why), then a short KPI row only if those numbers are the point, then sections. Encode state in form as well as numbers: a pill or a colored marker, using semantic colors (good / warn / bad) separate from the accent. Use card borders and shadows only to set apart the one thing that needs it, not on every block.

**Charts.** One scale for marks, ticks and labels; labels name values the chart actually reaches; chart text uses theme tokens; leave room in the `viewBox` for the outer labels; every shape has an explicit fill.

**Data goes in tables, not prose.** Never pack figures into paragraphs. Numbers per item belong in a table with aligned columns; comparisons get "now / previous" columns; percentages of a limit get a small bar. Long URLs go in `href` behind a short label like "Ver en Grafana ↗", never printed. For a data report, read `references/examples/04-status-report.html` first and follow its structure.

**Content.** Real data only, never lorem ipsum. Every number comes from something you ran or read; when a source is available, link it (for example a Grafana Explore deeplink) next to the number. If a query failed, the page says so instead of inventing a value. Include at least one detail only this subject has: its real units, thresholds, names.

**Copy.** Plain and direct. Name things the way the reader knows them. Active voice. No filler phrases, no emoji as section markers. Numbered markers only when the content really is a sequence.

**Avoid the AI look.** Warm cream with a serif and terracotta; near-black with one neon accent; a purple-to-blue gradient hero; everything centered; the same rounded card and shadow on every block. Pick something specific to the subject instead.

**Complete at rest.** Everything readable is visible on load; no content hidden until a scroll or click. Respect `prefers-reduced-motion`. Visible focus states on anything interactive.

## Title

A short name for the page, two to four words, specific enough to find among many (for example "yFlow UAT Health", not "Report"). No explanation after a dash or colon.

## Before you call create_artifact

Check once: tokens on `:root` plus the dark block, `body` has a background, nothing wider than 400px except scroll boxes, no external scripts, every number has a source. Then publish. Do not iterate on the design in a loop; the user asks for changes if they want them.
