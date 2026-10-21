---
name: api-design
description: Design or review HTTP and RPC APIs: resources, endpoints, errors, pagination and versioning. Use when adding endpoints, writing an OpenAPI spec, or reviewing an API change.
---

## Design
1. Name resources as nouns, use HTTP methods for verbs, and keep URLs predictable.
2. Define request and response shapes with types, required fields and examples.
3. Errors: consistent shape (code, message, details), correct status codes, no stack traces.
4. Lists: pagination (cursor preferred), filtering and sorting.
5. Idempotency for retried POSTs that create things.
6. Auth and permissions per endpoint.
7. Versioning and backward compatibility: never break existing clients silently.

## Review checklist
Breaking changes, missing validation, N+1 calls the client would need, inconsistent naming, and undocumented behavior.
