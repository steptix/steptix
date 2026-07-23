---
type: test
---

# Duplicate section names

A file the CLI refuses at parse time. The wire format cannot represent two
sections with the same name — a JSON object collapses them, last one wins —
so TestBench must refuse it too rather than run a different definition than
`aiui run` would.

## Steps

1. Open the shop
2. Sign in

### Sign in

1. Type the username

### SIGN IN

1. Something else entirely
