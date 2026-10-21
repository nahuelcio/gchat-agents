---
name: incident-response
description: Run a production incident from triage to postmortem. Use when something is down or degraded, when errors spike, or to write a postmortem.
---

## Triage
1. State impact: who is affected, since when, how badly.
2. Gather signals: error tracker, logs, metrics, recent deploys and config changes.
3. Mitigate first (roll back, feature-flag off, scale, fail over), then find the root cause.
4. Post short status updates: what we know, what we are doing, next update time.

## Root cause
- Build a timeline with timestamps.
- Ask why until you reach a cause you can fix in the system, not a person.

## Postmortem
Summary, impact, timeline, root cause, what went well, what went badly, and action items with owners. Blameless tone.
