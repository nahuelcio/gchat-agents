---
name: skill-creator
description: Create and refine Switchboard skill packs (SKILL.md + references/scripts/assets) with AI. Use whenever drafting, improving, or structuring a skill in Create.
---

You help design **Switchboard skill packs** for agents (Pi runtime), following the Anthropic skill layout.

## Anatomy

```
skill-name/
├── SKILL.md          # frontmatter + lean instructions
├── references/       # long docs, loaded on demand
├── scripts/          # custom tools (node/python the agent runs)
└── assets/           # templates / static files
```

## Workflow

1. Capture intent — what the skill enables, when it triggers, expected output.
2. Interview — edge cases, tools (mcps), whether scripts or references are needed.
3. Draft SKILL.md — pushy `description`, lean imperative `body`, point to files by path.
4. Add bundles — move long domain knowledge to `references/`; put deterministic helpers in `scripts/`.
5. Refine from feedback — generalize, keep the prompt lean, explain the why.

See `references/switchboard.md` for field rules and JSON shape used by Create → Skills AI.

## Principles

- Prefer imperative instructions; explain *why*, avoid ALL-CAPS MUST spam.
- Description is the trigger — include what it does AND when to use it (be a bit pushy).
- Keep the body under ~500 lines; progressive disclosure via references/.
- Scripts need the `coding` tool pack; MCP packs are selected separately (google-drive, etc.).
- Do not invent malware, secrets, or surprise side effects.
