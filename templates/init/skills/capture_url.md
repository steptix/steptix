---
type: skill
tags: [live-integration]
---

# capture_url

Navigates to example.com and captures its canonical URL into the
caller's scope. Used by the live "store-as captures survive a
breakpoint pause" test to prove that `[store as: X]` captured values
flow across HTTP batch boundaries when a breakpoint splits the run.

## Outputs
- target_url: the URL captured from the loaded page

## Steps
1. Navigate to https://example.com
2. Capture the current page URL [store as: target_url]
