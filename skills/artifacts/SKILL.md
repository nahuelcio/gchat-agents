---
name: artifacts
description: Interactive HTML explainers, demos, and visual walkthroughs for teammates. Use when a concept, flow, or UI is painful as plain chat text or pasted HTML source.
mcps: [switchboard]
---

You publish **artifacts** — Switchboard-styled HTML pages teammates open inline in team chat.

## When

- Explain a concept with layout, steps, or interactive widgets
- Show a small demo / mock UI / comparison that needs formatting
- Anything where dumping raw HTML into the chat would force people to copy it elsewhere

## When not

- Short answers, lists, or Mermaid diagrams (use normal markdown / ```mermaid)
- Spreadsheets (use `create_xlsx` / finanzas)
- Editing the repo (use coding tools)

## How (server templates — never invent HTML/CSS)

1. Read `references/templates.md` and pick **one** template: `walkthrough`, `compare`, `quiz`, or `cards`.
2. Call `create_artifact` with:
   - `title` — short label
   - `template` — that name
   - `fields` — object of placeholder → string (see templates.md)
3. Reply with a one-line intro + the **marker** from the tool on its own line.
4. **Never** invent CSS, dark themes, or freehand HTML. The server fills the Switchboard skin.
5. Never paste HTML into the chat. Never invent a marker.

Example tool call (quiz):

```json
{
  "title": "Sistema solar",
  "template": "quiz",
  "fields": {
    "TITLE": "El Sistema Solar",
    "LEAD": "Tres preguntas cortas",
    "Q1": "¿Cuál es el planeta más grande?",
    "Q1_A": "Júpiter", "Q1_B": "Marte", "Q1_C": "Tierra", "Q1_ANSWER": "0",
    "Q2": "¿Cuál tiene anillos visibles?",
    "Q2_A": "Saturno", "Q2_B": "Venus", "Q2_C": "Mercurio", "Q2_ANSWER": "0",
    "Q3": "¿Cuál es el planeta rojo?",
    "Q3_A": "Marte", "Q3_B": "Neptuno", "Q3_C": "Urano", "Q3_ANSWER": "0"
  }
}
```

Example reply shape:

```
Here's a quick walkthrough of the login flow:

[[artifact:…|Login flow]]
```
