---
tags: [live-integration]
---

# Compile code-behind live test

Fixture for the live compile test (stories/codebehind-compile.md). Two steps,
both pure page actions against `fixtures/test-app`, so neither is declined for
"performed no page actions" and the whole test can compile to code. Local and
deterministic — no external account, no network.

## Config
- baseUrl: http://localhost:8787

## Steps
1. Navigate to the baseUrl
2. Enter "demo@example.com" in the email field
