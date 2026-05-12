---
name: debugging-and-error-recovery
description: Diagnose and fix frontend/UI failures using a structured reproduce-isolate-fix-verify workflow.
---

# Debugging and Error Recovery (TypeScript React)

## Overview
Debug UI failures systematically and apply minimal, validated fixes.

## When to Use
- Interaction or rendering regressions
- Async state/loading/error bugs
- Test failures tied to UI behavior

## When NOT to Use
- New feature work without an active failure

## Inputs
- Reproduction steps and error output
- Relevant component/hook/state paths
- Existing tests for affected flow

## Process
1. Reproduce issue reliably.
2. Isolate failing interaction/state boundary.
3. Add/adjust failing test for issue.
4. Implement minimal targeted fix.
5. Verify core and nearby user flows.

## Verification Checklist
- [ ] Reproduction exists before fix
- [ ] Root cause is explicit
- [ ] Fix is scoped and minimal
- [ ] Related tests and key flows pass

## Failure Modes to Avoid
- Patch-by-guessing without reproduction
- Broad refactors during bugfix
- Declaring done without regression checks

## Output Requirements
- Use `summarize` for final output.
- Include root cause, fix summary, and verification evidence.
