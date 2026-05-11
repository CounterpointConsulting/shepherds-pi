---
name: incremental-implementation
description: Deliver frontend/UI changes in small, verifiable slices to reduce risk and simplify testing/review.
---

# Incremental Implementation (TypeScript React)

## Overview
Implement UI behavior in focused slices that can each be validated from a user-observable perspective.

## When to Use
- Multi-step component/page behavior work
- Changes spanning state, data fetching, and interactions
- Work requiring controlled scope and quick feedback loops

## When NOT to Use
- Trivial non-behavioral copy/style tweaks

## Inputs
- UI requirements and user-flow expectations
- Existing component/state patterns
- Current test coverage baseline

## Process
1. Confirm scope and assumptions.
2. Implement one user-visible behavior slice.
3. Validate via interaction/state tests.
4. Proceed to next slice only after verification.
5. Keep changes focused and avoid unrelated cleanup.

## Verification Checklist
- [ ] Slice delivers clear user-visible outcome
- [ ] Interaction/state tests cover changed behavior
- [ ] Loading/error/empty states handled where relevant
- [ ] Accessibility basics preserved

## Failure Modes to Avoid
- Large multi-concern UI diffs in one pass
- Testing internals instead of user outcomes
- Skipping verification for edge/error states

## Output Requirements
- Use `summarize` for final output.
- Describe slices completed and evidence run.
- Use canonical camelCase result fields.
