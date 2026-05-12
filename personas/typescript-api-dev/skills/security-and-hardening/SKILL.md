---
name: security-and-hardening
description: Apply baseline API security checks for input handling, auth, data access, and error boundaries.
---

# Security and Hardening (TypeScript API)

## Overview
Apply mandatory security checks for backend changes that process untrusted input or sensitive operations.

## When to Use
- Input parsing/validation changes
- Auth/authz-sensitive routes
- Data access and external integrations
- Error handling for public API responses

## When NOT to Use
- Changes with no backend/runtime behavior impact

## Inputs
- API diff and data flow context
- Validation/auth requirements
- External dependency touchpoints

## Process
1. Validate untrusted input at boundaries.
2. Confirm auth/authz enforcement where required.
3. Ensure unsafe query/command patterns are absent.
4. Check logs/errors for sensitive data leakage.

## Verification Checklist
- [ ] Boundary validation is explicit
- [ ] Authorization checks are present where needed
- [ ] No unsafe untrusted-input execution path exists
- [ ] Sensitive data is not leaked in logs/responses

## Failure Modes to Avoid
- Assuming client-side validation is sufficient
- Treating auth as implied by route naming
- Returning internal error details to clients

## Output Requirements
- Use `summarize` for final output.
- Include security checks performed and residual risk.
