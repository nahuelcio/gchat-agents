---
name: sql-review
description: Review and optimize SQL queries, schemas and migrations for correctness and performance. Use for slow queries, schema changes, migrations, or index design.
---

## Review
1. Correctness: joins that duplicate rows, NULL handling, time zones, off-by-one ranges, missing WHERE on UPDATE or DELETE.
2. Performance: read the query plan, look for full scans, missing or unused indexes, functions on indexed columns, N+1 patterns, and huge OFFSETs.
3. Migrations: locking on large tables, backfills in batches, reversible steps, and deploy order with the code.
4. Safety: parameterized queries only, least-privilege roles.

## Report
Each issue with the query, why it is a problem, and the rewritten query or index. Measure before and after when you can.
