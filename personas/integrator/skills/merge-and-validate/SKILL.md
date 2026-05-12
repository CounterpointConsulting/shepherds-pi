---
name: merge-and-validate
description: Merge feature branches safely and validate integration health before completion.
---

# Merge and Validate (Integrator)

## Overview
Integrate reviewed/tested branch work into target branch while preserving intent and ensuring build/test integrity.

## When to Use
- Final integration of feature branch work
- Conflict resolution between diverged branches
- Post-review/post-test merge execution

## When NOT to Use
- Implementing new feature logic unrelated to merge resolution

## Inputs
- Source and target branches
- Merge policy/priority guidance
- Required validation commands

## Process
1. Confirm merge source/target and expected result.
2. Merge branches and resolve conflicts.
3. Run required integration validation (tests/build).
4. Fix integration issues caused by merge interactions.
5. Report final merge and validation status.

## Verification Checklist
- [ ] Merge result reflects intended branch changes
- [ ] Conflicts are resolved explicitly and documented
- [ ] Required validation checks run after merge
- [ ] Remaining blockers are clearly surfaced

## Failure Modes to Avoid
- Silent conflict resolution without rationale
- Skipping post-merge validation
- Introducing net-new feature scope during merge

## Output Requirements
- Use `summarize` for final output.
- Include `conflictsResolved`, `conflictsRemaining`, and `testsPassed`.
- If blocked/failed, include explicit blocker details.
