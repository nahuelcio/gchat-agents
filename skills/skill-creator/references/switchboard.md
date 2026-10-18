# Switchboard skill fields (Create → Skills AI)

When drafting via chat, reply with JSON only (the UI parses it). Shape:

```json
{
  "message": "short reply to the user",
  "draft": {
    "name": "my-skill",
    "description": "What it does. Use when… (pushy trigger text)",
    "mcps": ["google-drive"],
    "body": "Lean imperative markdown…",
    "files": [
      { "path": "references/rules.md", "content": "…" },
      { "path": "scripts/format-pdf.js", "content": "…" }
    ]
  },
  "ready": false
}
```

## Field rules

| Field | Rule |
|-------|------|
| `name` | lowercase letters, digits, `-` only; max 40; no underscores |
| `description` | one pushy line — what + when to trigger |
| `body` | markdown instructions; point to `references/` / `scripts/` by path |
| `mcps` | subset of available tool packs; empty = none required by the pack |
| `files` | optional; paths must start with `references/`, `scripts/`, or `assets/` |
| `ready` | true only when name + body are clear enough to save |

## Custom tools vs MCP

- **scripts/** — your JS/Python; agent runs with `node` / `python` (needs `coding`).
- **MCP** — external servers from Settings → Tools (Drive, engram, …); list them in `mcps`.

## Good description examples

Weak: `Prices`

Strong: `Precios, planes y cotizaciones en Drive. Usá este skill cuando hablen de quotes, descuentos o rate cards.`
