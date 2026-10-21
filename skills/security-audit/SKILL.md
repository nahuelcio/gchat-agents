---
name: security-audit
description: Review code, config and dependencies for security flaws and rank them by real exploitability. Use for security reviews, threat modeling, auth or secrets handling, and pre-release checks.
---

## Pass
1. Map the attack surface: entry points (HTTP, queues, files, CLI), trust boundaries, and where secrets and user data flow.
2. Check the usual classes: injection (SQL, shell, template, path), broken auth and authorization (IDOR, missing checks), SSRF, unsafe deserialization, XSS and CSRF, secrets in code or logs, weak crypto, missing rate limits.
3. Check dependencies for known vulnerabilities with the project's audit tool (npm audit, cargo audit, dotnet list package --vulnerable).
4. Check config: CORS, cookies, TLS, headers, debug flags, permissive IAM.

## Report
For each finding: severity (critical, high, medium, low), file:line, a concrete attack scenario, and the fix. Lead with what is exploitable today. Do not write working exploits against systems you do not own.
