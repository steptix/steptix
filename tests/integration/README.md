# Integration tests for AI-driven assertions

These `.md` files exercise the AI-driven assertion mechanism against
`fixtures/test-app` (port 8787).

Run with:

```bash
# Start the test-app server in another terminal
npx tsx fixtures/test-app/server.ts

# Run all integration tests
npm run dev -- run tests/integration

# Run one
npm run dev -- run tests/integration/assertion-confirm-is-not-assert.md
```

## What each test verifies

| File | Scenario | Expected |
|---|---|---|
| `assertion-pure-verify.md` | Single verification step | One `assert` action, no clicks |
| `assertion-mixed-action.md` | Click then verify in one step | `[click, ..., assert]` |
| `assertion-confirm-is-not-assert.md` | Instruction starts with "Confirm" but is an action | Zero `assert` actions on the click step; assert on the explicit verify step |
| `assertion-multi-turn.md` | Navigate + verify across turns | Multi-turn step; assertion in turn 2 |
| `assertion-multi-assert.md` | Two assertions in one step | Two `assert` actions, both reported |
| `assertion-failure.md` | Wrong expected value | Assert fails fast, named in error |
