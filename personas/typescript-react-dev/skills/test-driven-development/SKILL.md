---
name: test-driven-development
description: Implement frontend behavior with a test-first RED-GREEN-REFACTOR workflow.
---

# Test-Driven Development (TypeScript React)

## Overview
Use a failing-test-first workflow for UI behavior changes. Completion requires passing tests for core and edge interactions.

## When to Use
- New component interaction behavior
- Bug fixes in rendering/state transitions
- Form validation/error handling
- Async loading/error/empty state changes

## When NOT to Use
- Pure visual copy tweaks with no behavior impact

## Inputs
- User-flow requirements
- Existing test conventions/framework
- Relevant component/hook code paths

## Process
1. RED: write failing interaction/state tests first.
2. GREEN: implement minimal code to pass tests.
3. REFACTOR: improve structure while tests stay green.
4. Re-run affected tests and project checks.

## Verification Checklist
- [ ] User-observable behavior is covered by tests
- [ ] Edge/error states are tested
- [ ] Accessibility expectations are preserved
- [ ] Typecheck/build expectations pass

## Failure Modes to Avoid
- Coding before tests fail
- Happy-path-only testing
- Asserting implementation details over behavior

## Output Requirements
- Use `summarize` for final output.
- Include test evidence and any known gaps.
- Use canonical camelCase result fields.
