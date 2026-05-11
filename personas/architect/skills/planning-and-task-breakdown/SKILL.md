---
name: planning-and-task-breakdown
description: Build an implementation plan before coding starts. Use when work needs decomposition into ordered, assignable steps with explicit dependencies and contracts.
---

# Planning and Task Breakdown (Architect)

## Overview
Create a concrete implementation plan that the orchestrator can execute with specialist personas. Planning should happen before implementation starts.

## When to Use
- New features or non-trivial bug fixes
- Work spanning multiple subsystems/personas
- Tasks with unclear dependency order
- Tasks that may benefit from parallel execution

## When NOT to Use
- Tiny, single-file changes with obvious scope and no cross-component impact

## Inputs
- Goal and requirements text
- Relevant codebase context
- Existing project conventions and architecture constraints
- Any branching constraints provided by orchestrator/user

## Process
1. Review requirements and relevant existing code patterns (read-only planning mode).
2. Identify dependency graph and prerequisite steps.
3. Define contracts up front (schema, API, component/data boundaries).
4. Produce small, assignable steps with persona ownership.
5. Mark parallelizable steps vs sequential dependencies.
6. Add risk notes and verification intent for major steps.

## Verification Checklist
- [ ] Every step has a clear outcome and single responsible persona
- [ ] Dependencies are explicit and acyclic (`dependsOn`)
- [ ] Parallelizable steps are clearly identified
- [ ] Contracts are specific enough to prevent integration drift
- [ ] Edge/error paths are represented in the plan

## Failure Modes to Avoid
- Vague steps without concrete outcomes
- Missing dependencies that cause rework
- Mixing implementation code with planning output
- Omitting contracts for parallel work

## Output Requirements
- Use `summarize` to produce final output.
- Ensure plan steps use canonical fields (for example `dependsOn`, `branch`).
- If blocked, return `partial`/`failed` with concrete blockers and next actions.
