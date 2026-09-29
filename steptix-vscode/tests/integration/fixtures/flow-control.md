---
type: test
---

# Flow control fixture

Fixture for `flow-control.test.cjs`. Shaped for the two lines a `step:skip`
addresses (stories/step-flow-control.md, decision 9): ordinary body lines, and
the CALL line of a section invoked from inside the returned body — which has no
step of its own in the expansion and would otherwise keep whatever glyph the
gutter last painted on it.

Never actually executed: the fast suite scripts every event through
`FakeApiClient`, so the instructions only have to be plausible steps on lines
this test can name.

## Steps

1. Open the shop
2. Sign in
3. Check out
4. Say goodbye

### Sign in

1. Look at the page
2. Type the username
3. Press submit
4. Accept cookies

### Accept cookies

1. Click the accept button
