---
name: using-agent-skills
description: Meta-skill for selecting and loading workflow skills dynamically. Use at task start or when scope changes.
---

# Using Agent Skills

## Overview
Select the minimum set of relevant workflow skills for the current task, load them, and adapt selection if scope changes.

## When to Use
- Start of every non-trivial task
- When requirements/scope change mid-task
- When output quality degrades and process guidance is needed

## When NOT to Use
- Skills are already loaded and scope has not changed

## Inputs
- Current persona
- Task instructions/context
- Optional requested skill list in task text/context

## Requested Skill List Format

If the coordinator/user specifies skills, use this format in instructions/context:

```json
{
  "requestedSkills": [
    "planning-and-task-breakdown",
    "security-and-hardening",
    "test-driven-development"
  ]
}
```

You may also accept a plain-text list (e.g., `requestedSkills: security-and-hardening, test-driven-development`).

## Skill Selection Map

Use available local skills from mounted skill directories:

- Planning/architecture: `planning-and-task-breakdown`, `risk-and-assumptions`
- Implementation: `incremental-implementation`, `test-driven-development`
- Security-sensitive work: `security-and-hardening`
- Failure diagnosis: `debugging-and-error-recovery`
- Review: `code-review-and-quality`
- Manual validation: `test-plan-and-execution`
- Integration: `merge-and-validate`
- Final handoff: `summarize` (always)

## Process
1. Parse task intent and detect any requested skill list.
2. Resolve requested skills against locally available skills.
3. Select minimal required skill set for task risk/profile.
4. Load each selected skill using `read` on its `SKILL.md`.
5. Execute task using loaded skill workflows.
6. Re-evaluate and load additional skills if scope changes.

## Verification Checklist
- [ ] Selected skills match task intent and risk
- [ ] Requested skills were loaded when available
- [ ] Missing requested skills were explicitly noted
- [ ] `summarize` is used for final output

## Failure Modes to Avoid
- Loading all skills by default (context bloat)
- Skipping testing/security skills for risky changes
- Ignoring requested skill lists from instructions/context
- Failing to re-evaluate skill selection after scope drift

## Output Requirements
- In final summary text, list which workflow skills were applied.
- Use `summarize` to produce `/output/result.json`.
