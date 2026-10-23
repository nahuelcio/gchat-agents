# Artifact templates

Pass `template` + `fields` to `create_artifact`. The server fills a neutral light/dark theme. **Do not invent HTML.**

| template | Use for |
|---|---|
| `walkthrough` | Numbered steps / how-to |
| `compare` | Side-by-side A vs B |
| `quiz` | 3 multiple-choice questions |
| `cards` | Grid of short cards |

## walkthrough

`EYEBROW`, `TITLE`, `LEAD`, `STEP1_TITLE`, `STEP1_BODY`, `STEP2_TITLE`, `STEP2_BODY`, `STEP3_TITLE`, `STEP3_BODY`, `FOOTNOTE`

## compare

`TITLE`, `LEAD`, `A_TITLE`, `A1`, `A2`, `A3`, `B_TITLE`, `B1`, `B2`, `B3`, `PICK_HINT`

## quiz

`TITLE`, `LEAD`, then for n = 1..3: `Qn`, `Qn_A`, `Qn_B`, `Qn_C`, `Qn_ANSWER`  
`Qn_ANSWER` is `"0"`, `"1"`, or `"2"` (correct option index).

## cards

`TITLE`, `LEAD`, `C1_TITLE`, `C1_BODY`, `C2_TITLE`, `C2_BODY`, `C3_TITLE`, `C3_BODY`

Values are HTML-escaped by the server — plain text only, no tags.
