---
name: incremental-implementation
description: Deliver schema and migration changes in safe, reversible increments. Use for multi-step database work to reduce migration risk.
---

# Incremental Implementation (DBA)

## Overview
Apply database changes in small, safe slices that preserve integrity and operational safety.

## When to Use
- Multi-step schema evolution
- Changes requiring ordered migrations
- Work where rollback/recovery risk matters

## When NOT to Use
- Read-only analysis tasks with no schema or migration changes

## Inputs
- Current schema and migration history
- Required data model changes
- Query/performance expectations

## Process
1. Confirm conventions and current migration baseline.
2. Apply additive/reversible schema changes first.
3. Add constraints/indexes after foundational structures.
4. Validate migration ordering and dependency safety.
5. Avoid destructive operations unless explicitly requested.

## Verification Checklist
- [ ] Migration naming and ordering are correct
- [ ] Integrity constraints are explicit and appropriate
- [ ] Index choices match expected query paths
- [ ] Operational/rollback risks are documented

## Failure Modes to Avoid
- Large monolithic migration bundles
- Implicit assumptions about existing data quality
- Destructive edits without explicit approval

## Output Requirements
- Use `summarize` for final output.
- Include migrations touched and safety notes.
- Use canonical camelCase result fields where applicable.
