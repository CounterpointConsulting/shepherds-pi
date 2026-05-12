---
name: code-review-and-quality
description: Perform structured multi-axis code review before merge. Use for correctness, quality, security, performance, and test adequacy assessment.
---

# Code Review and Quality

## Overview
Run a consistent review process and produce prioritized, actionable findings with a clear approval decision.

## When to Use
- Any implementation branch before merge
- Re-review after requested fixes
- High-risk changes touching auth, data, security, or performance-sensitive paths

## When NOT to Use
- Non-code tasks where no implementation diff exists

## Inputs
- Target branch and base branch
- Requirements/spec context for expected behavior
- Diff and any test/build evidence

## Process
1. Review changed code against requirements.
2. Evaluate across five axes: correctness, quality, security, performance, test adequacy.
3. Assign severity per finding (`critical`, `warning`, `suggestion`, `info`).
4. Provide concrete remediation suggestions.
5. Decide approval based on severity rubric.

## Verification Checklist
- [ ] Findings reference concrete files/locations when possible
- [ ] Severity reflects impact and urgency
- [ ] Security/performance checks are not skipped
- [ ] Approval flag matches severity rules

## Failure Modes to Avoid
- Vague feedback without actionable next steps
- Over-indexing on style while missing correctness/security issues
- Inconsistent approval decision vs listed severities

## Output Requirements
- Use `summarize` to emit review results.
- Set `approved=false` if any `critical` or `warning` findings remain.
- Ensure findings include severity, description, and fix guidance.
