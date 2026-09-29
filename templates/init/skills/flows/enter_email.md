---
type: skill
---

# enter_email

A subfolder skill (`skills/flows/`) for the live compile test
(stories/skills-in-subfolders.md): proves a path-qualified invocation
compiles to code, with the `.steps.ts` and its `.steptix-codebehind-cache`
landing beside THIS file in the subfolder. The single step is a pure page action against
`fixtures/test-app`, so the whole body is compilable.

## Parameters
- email: the address to enter

## Steps
1. Enter "{{email}}" in the email field
