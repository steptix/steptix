---
type: test
---

# Guard marks fixture

Fixture for `guard-marks.test.cjs` (stories/codebehind-loops-and-conditions.md,
decision 15): guard lines whose tail is a section, so the section's frame is
pushed and popped on the guard's own line.

Never actually executed: the fast suite scripts every event through
`FakeApiClient`, so the instructions only have to be plausible steps on lines
the test can name.

## Steps

1. Open the payments page
2. If the Cash checkbox is ticked, then Pay with cash
3. Otherwise, Pay by card
4. While the Next button is enabled, Go to the next page
5. Say goodbye

### Pay with cash

1. Click Pay now

### Pay by card

1. Click Pay by card

### Go to the next page

1. Click the Next button
