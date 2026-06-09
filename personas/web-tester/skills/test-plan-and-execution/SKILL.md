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
1. Confirm expected behavior and the task's defined success criteria.
2. You MUST drive the application through the browser using the
   `playwright-skill` — do not rely on manual reasoning, curl, or
   assumptions. Browser automation results are the required evidence.
3. Execute happy path end-to-end.
4. Execute edge/error scenarios.
5. Capture exact reproduction steps for findings.
6. Classify findings by severity and impact.
7. Map each defined success criterion to a pass/fail result.

## Verification Checklist
- [ ] Each defined success criterion is explicitly verified pass/fail
- [ ] Verification performed via playwright browser automation
- [ ] Core user flow validated end-to-end
- [ ] Invalid/error states exercised
- [ ] Findings include reproducible steps
- [ ] Approval decision matches observed failures
- [ ] `approved` is true ONLY if every success criterion passed

## Failure Modes to Avoid
- Vague findings without reproducible steps
- Skipping negative-path testing
- Declaring pass with unresolved high-impact regressions

## Output Requirements
- Use `summarize` for final output.
- Include `testsRun`, `testsPassed`, `testsFailed` and findings with `stepsToReproduce`.
- Set `approved` consistently with test outcome.
