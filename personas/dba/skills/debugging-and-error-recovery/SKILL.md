---
name: debugging-and-error-recovery
description: Diagnose and recover from migration or schema issues safely and incrementally.
---

# Debugging and Error Recovery (DBA)

## Overview
Use a structured workflow to reproduce, isolate, and fix migration/schema failures with minimal blast radius.

## When to Use
- Migration failures
- Constraint/index behavior regressions
- Query-plan regressions tied to schema changes

## When NOT to Use
- New feature implementation with no active failure to diagnose

## Inputs
- Error output and failing migration/query context
- Relevant schema objects and migration history

## Process
1. Reproduce issue in controlled steps.
2. Isolate failing object/boundary (table, index, constraint, order).
3. Implement minimal corrective change.
4. Re-verify migration path and integrity behavior.
5. Document root cause and mitigation.

## Verification Checklist
- [ ] Failure is reproducible before fix
- [ ] Root cause is identified, not guessed
- [ ] Fix is minimal and targeted
- [ ] Validation confirms issue resolved without regressions

## Failure Modes to Avoid
- Broad speculative schema changes
- Skipping root-cause analysis
- Fixing symptoms while leaving migration path fragile

## Output Requirements
- Use `summarize` for final output.
- Include root cause, corrective action, and validation evidence.
