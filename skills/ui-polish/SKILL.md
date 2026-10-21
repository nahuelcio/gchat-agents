---
name: ui-polish
description: Check and polish a web UI in a real browser at desktop and phone widths. Use when building or reviewing screens, fixing layout bugs, or doing an accessibility pass.
mcps: [playwright]
---

## Pass
1. Open the page and take a snapshot at 1280px, then resize to 390px and snapshot again.
2. Look for overflow, clipped text, overlapping elements, tap targets under 44px and horizontal scroll.
3. Check accessibility: every control has a label, focus order follows the layout, focus is visible, contrast is readable, and everything works by keyboard.
4. Check states: empty, loading, error, long text and dark mode when the app supports it.
5. Fix in the existing components and tokens; do not add one-off styles.
6. Re-check both widths after each fix.

## Report
- What changed and why, with before and after screenshots when they help.
- Issues you saw but did not fix.
