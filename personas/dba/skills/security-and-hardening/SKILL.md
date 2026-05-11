---
name: security-and-hardening
description: Apply baseline data security and integrity checks for schema and migration work.
---

# Security and Hardening (DBA)

## Overview
Enforce data integrity and reduce security/operational risk in database changes.

## When to Use
- New tables/columns/constraints/indexes
- Changes that affect sensitive data
- Migrations with potentially destructive impact

## When NOT to Use
- Pure planning tasks with no database changes

## Inputs
- Proposed schema/migration diff
- Data integrity requirements
- Access/sensitivity constraints

## Process
1. Verify integrity constraints (PK/FK/unique/check) are explicit.
2. Identify sensitive data handling implications.
3. Confirm migrations avoid unintended destructive behavior.
4. Call out risky operations and required approvals.

## Verification Checklist
- [ ] Integrity protections are explicit
- [ ] Sensitive data considerations are addressed
- [ ] Risky/destructive operations are flagged
- [ ] Migration safety is documented

## Failure Modes to Avoid
- Under-constrained schema changes
- Hidden destructive behavior
- Missing risk callouts for production-impacting changes

## Output Requirements
- Use `summarize` for final output.
- Include security/integrity checks performed and residual risk.
