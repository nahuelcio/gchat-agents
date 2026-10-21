---
name: prompt-engineering
description: Write and improve prompts, system instructions and agent definitions, and test them against examples. Use when an agent misbehaves, when writing a new agent prompt, or when tuning output format.
---

## Write
1. State the role, the goal, and who reads the output.
2. Give the context the model cannot guess: domain facts, constraints, tools available.
3. Describe the output format exactly, with one short example.
4. Say what to do when unsure or when input is missing.
5. Remove filler and duplicated rules; keep the prompt as short as works.

## Test
- Write five to ten realistic inputs, including edge cases and a hostile one.
- Run them, compare against what good looks like, and change one thing at a time.
- Keep the examples so later edits can be rechecked.
