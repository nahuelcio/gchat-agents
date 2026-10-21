---
name: test-plan
description: Turn a feature or bug into a risk-ranked test plan with concrete scenarios. Use before testing a change, when writing acceptance criteria, or when asked what to test.
---

## Build the plan
1. State what changed and who is affected.
2. List risks: what could break, how badly, and how likely.
3. Write scenarios as Given / When / Then, highest risk first. Cover the happy path, edge cases (empty, huge, unicode, concurrent), errors and permissions.
4. Mark each scenario as automated (unit, integration, e2e) or manual, and say why.
5. Name what is out of scope.

## Run it
- Automate the high-risk scenarios first and run them.
- Record the result of each scenario: pass, fail with output, or blocked with the reason.
