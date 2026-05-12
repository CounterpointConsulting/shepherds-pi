---
name: security-and-hardening
description: Apply baseline frontend security checks when handling untrusted data, auth-sensitive UI, forms, or external content.
---

# Security and Hardening (TypeScript React)

## Overview
Reduce client-side security risk by validating rendering and interaction boundaries for untrusted or sensitive data flows.

## When to Use
- Rendering user/external content
- Auth/session-sensitive UI
- Form input handling and submission flows
- New API response handling paths in UI

## When NOT to Use
- Changes with no user data or security-sensitive behavior impact

## Inputs
- UI diff and data flow context
- Auth/session behavior expectations
- Rendering and form handling pathways

## Process
1. Check untrusted content rendering safety.
2. Verify form validation and error flows.
3. Ensure auth-sensitive UI doesn’t expose restricted data.
4. Confirm no secrets/tokens are hard-coded or logged.

## Verification Checklist
- [ ] Untrusted data is rendered safely
- [ ] Validation/error handling is explicit
- [ ] Restricted UI/data paths respect auth boundaries
- [ ] No sensitive values leak through logs/code

## Failure Modes to Avoid
- Unsafe rendering assumptions
- Treating UI-only checks as full security boundary
- Missing negative-path validation checks

## Output Requirements
- Use `summarize` for final output.
- Include security checks performed and residual risk.
