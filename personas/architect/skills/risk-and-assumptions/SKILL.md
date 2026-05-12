---
name: risk-and-assumptions
description: Surface assumptions, unknowns, and implementation risks during planning. Use when requirements are ambiguous or work spans multiple subsystems.
---

# Risk and Assumptions (Architect)

## Overview
Identify and communicate critical assumptions and risks early so the orchestrator can sequence work safely and ask clarifying questions when needed.

## When to Use
- Requirements are ambiguous or incomplete
- Work has cross-team/cross-layer dependencies
- Any plan with significant migration, integration, security, or performance risk

## When NOT to Use
- Fully specified, low-risk changes with no meaningful uncertainty

## Inputs
- Goal and requirement text
- Existing architecture constraints
- Proposed plan and dependency graph

## Process
1. List explicit assumptions that planning depends on.
2. Identify unknowns that could block or invalidate implementation.
3. Rank top risks (integration, migration, security, performance, scope).
4. Add mitigation strategy for each high-priority risk.
5. Mark items that require user/orchestrator clarification.

## Verification Checklist
- [ ] Assumptions are explicit and testable
- [ ] Unknowns that can block progress are called out
- [ ] Top risks include mitigations
- [ ] Clarification-required items are clearly flagged

## Failure Modes to Avoid
- Hiding assumptions in implicit language
- Treating high-risk unknowns as settled facts
- Providing risks without mitigation options

## Output Requirements
- Include assumptions, risks, and mitigations in final summary content.
- Use `issues`/`suggestions` via `summarize` for escalation guidance.
