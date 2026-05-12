---
name: test-plan-and-execution
description: Execute structured end-to-end web testing from user perspective before merge.
---

# Test Plan and Execution (Web Tester)

## Overview
Validate completed functionality through realistic user flows, including happy path, edge cases, and failure states.

## When to Use
- Pre-merge feature validation
- Regression checks after fixes
- UX-critical flow verification

## When NOT to Use
- Pure backend-only changes with no user-facing behavior impact

## Inputs
- Requirements/user stories for target flow
- Environment/build/run instructions
- Branch under test and test data assumptions

## Process
1. Confirm expected behavior and test scope.
2. Execute happy path end-to-end.
3. Execute edge/error scenarios.
4. Capture exact reproduction steps for findings.
5. Classify findings by severity and impact.

## Verification Checklist
- [ ] Core user flow validated end-to-end
- [ ] Invalid/error states exercised
- [ ] Findings include reproducible steps
- [ ] Approval decision matches observed failures

## Failure Modes to Avoid
- Vague findings without reproducible steps
- Skipping negative-path testing
- Declaring pass with unresolved high-impact regressions

## Output Requirements
- Use `summarize` for final output.
- Include `testsRun`, `testsPassed`, `testsFailed` and findings with `stepsToReproduce`.
- Set `approved` consistently with test outcome.
