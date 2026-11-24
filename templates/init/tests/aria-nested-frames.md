---
tags: [live-integration, aria]
---

# Aria snapshot — nested frames

Fixture for `aria-edge-cases.test.cjs`. The wealth dashboard hosts an Advisor
Portal frame, which hosts the Advisor chat frame. The chat field is two
frames down, so the run's ref is frame-scoped and the compiled step has to
come back as a frame locator.

## Config
- baseUrl: http://localhost:8787

## Steps
1. Navigate to nested-iframes.html
2. In the Advisor chat frame, type "Hello from the nested frame" into the chat message field and click Send
3. Verify the Advisor chat shows "Hello from the nested frame"
