---
name: incremental-implementation
description: Deliver backend/API changes in small, verifiable slices to reduce risk and improve reviewability.
---

# Incremental Implementation (TypeScript API)

## Overview
Implement API work in focused increments that can each be tested and validated before moving to the next slice.

## When to Use
- Multi-step endpoint/service changes
- Work touching validation + business logic + persistence
- Changes where rollback/scope control matters

## When NOT to Use
- Tiny one-line fixes with no meaningful branching/validation overhead

## Inputs
- Requirements and acceptance intent
- Existing route/controller/service conventions
- Relevant test coverage baseline

## Process
1. Confirm scope and assumptions.
2. Implement the smallest viable behavior slice.
3. Validate with tests/type checks.
4. Expand to next slice only after green verification.
5. Keep commits/files focused and traceable.

## Verification Checklist
- [ ] Each slice has a clear observable outcome
- [ ] Tests cover changed behavior (happy + error path)
- [ ] Type safety remains strict
- [ ] No unrelated refactors were introduced

## Failure Modes to Avoid
- Large multi-concern diffs in one pass
- Skipping intermediate verification
- Expanding scope opportunistically

## Output Requirements
- Use `summarize` for final output.
- Describe completed slices and evidence run.
- Use canonical camelCase result fields.
