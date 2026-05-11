# Skill Template (Shepherds Pi)

Use this structure for all new workflow skills so behavior is predictable across personas.

```markdown
---
name: skill-name
description: One-sentence description of what this skill does and when to use it.
---

# Skill Title

## Overview
1-3 sentences describing scope and objective.

## When to Use
- Bullet list of situations where this skill should be applied.

## When NOT to Use
- Bullet list of situations where this skill is unnecessary or incorrect.

## Inputs
- What context is required (instructions, branch, requirements, constraints).

## Process
1. Ordered, concrete execution steps.
2. Keep steps actionable and verifiable.

## Verification Checklist
- [ ] Concrete checks with objective evidence.
- [ ] Include tests/build/typecheck/manual checks as relevant.

## Failure Modes to Avoid
- Common mistakes to explicitly avoid.

## Output Requirements
- What must be captured in summarize output.
- Reference canonical camelCase result fields where applicable.
```

## Conventions

- Keep `name` aligned with directory name.
- Use concise, imperative wording.
- Prefer evidence-based completion criteria over subjective claims.
- Do not duplicate summarize JSON schema here; reference summarize skill for exact shape.
