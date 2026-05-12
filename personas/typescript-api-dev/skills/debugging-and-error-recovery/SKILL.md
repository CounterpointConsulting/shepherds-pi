---
name: debugging-and-error-recovery
description: Diagnose and fix backend/API failures with a structured reproduce-isolate-fix-verify workflow.
---

# Debugging and Error Recovery (TypeScript API)

## Overview
Use a controlled workflow to fix failures without expanding scope or introducing regressions.

## When to Use
- Failing tests or runtime errors
- Behavior deviating from requirements
- Regression reports after recent changes

## When NOT to Use
- Greenfield implementation without a specific failure signal

## Inputs
- Error output and reproduction steps
- Relevant code paths and recent changes
- Existing tests around failing behavior

## Process
1. Reproduce issue reliably.
2. Isolate failing boundary.
3. Add/adjust failing test for issue.
4. Implement minimal targeted fix.
5. Verify fix and regression safety.

## Verification Checklist
- [ ] Reproduction exists before fix
- [ ] Root cause identified clearly
- [ ] Fix is minimal and scoped
- [ ] Related tests pass post-fix

## Failure Modes to Avoid
- Guess-based fixes without reproduction
- Broad refactors during incident response
- Closing issue without regression checks

## Output Requirements
- Use `summarize` for final output.
- Include root cause, fix summary, and verification evidence.
