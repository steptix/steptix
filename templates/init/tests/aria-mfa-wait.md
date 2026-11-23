---
tags: [live-integration, aria]
---

# Aria snapshot — MFA countdown wait

Fixture for `aria-mfa-wait.test.cjs` (docs/specs/SPEC-aria-ref-snapshots.md
§9.2). The verification field appears 15 seconds after load, while the status
line ticks the remaining seconds. A local snapshot diff should wait that out
in one action, and Run & Compile should keep a timeout of at least 30 seconds
with no snapshot ref left in the code.

## Config
- baseUrl: http://localhost:8787

## Steps
1. Navigate to mfa.html?delay=15000&countdown=1
2. Wait until the verification code field is visible, up to 60 seconds
3. Type 123456 into the verification code field
4. Click Verify Code
