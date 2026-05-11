---
name: test-driven-development
description: Implement backend/API changes with a test-first RED-GREEN-REFACTOR workflow.
---

# Test-Driven Development (TypeScript API)

## Overview
Use a failing-test-first loop for behavior changes. Work is complete only when tests prove expected behavior.

## When to Use
- New endpoint or service behavior
- Bug fixes
- Validation/error-handling changes
- API contract updates

## When NOT to Use
- Pure docs/config edits with no behavior impact

## Inputs
- Requirement/spec for expected behavior
- Existing tests and project test conventions
- Relevant route/controller/service code

## Process
1. RED: write/update failing tests first.
2. GREEN: implement minimal code to pass tests.
3. REFACTOR: improve code while tests remain green.
4. Re-run impacted tests and project checks.

## Verification Checklist
- [ ] Behavior change is captured by tests
- [ ] Error path(s) are tested
- [ ] HTTP status and response shape are validated
- [ ] Typecheck/build expectations pass

## Failure Modes to Avoid
- Coding before failing test exists
- Happy-path-only test coverage
- Declaring done without executing tests

## Output Requirements
- Use `summarize` for final output.
- Include test evidence and any gaps/risks.
- Use canonical camelCase result fields.
