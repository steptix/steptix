# aiapi cache hints for ai-ui-automation

## Summary

`ai-ui-automation` now emits provider-neutral cache hints to `aiapi` v2 by marking stable system prompt text blocks with `cache: true`.

This lets `aiapi`:
- map cacheable Anthropic text blocks to Anthropic `cache_control`
- accept the same hint for OpenAI while preserving a stable prompt prefix

## What changed

### System prompts are now block-based

Instead of sending the step-planning system prompt as one large string, the runner now sends it as multiple text blocks.

Stable blocks are marked cacheable:
- core UI automation instructions
- application context loaded from `context/`
- API action instructions (only emitted when `apiContext.hasApiContext` is true; the text itself is stable across a run, so it's still cache-marked when present)
- response-format instructions

Volatile state was relocated out of the system prompt:
- `## Test Information` (Test, Base URL, Current Step, Viewport) is now built via `formatTestInfo()` and prepended to the user message by each user-message builder. This keeps the entire system prompt prefix cacheable; previously the volatile block sat between cacheable ones and broke the cache prefix for everything after it.
- `## API Response History` stays at the tail of the system blocks (uncached). Because it sits last, it does not invalidate the cacheable prefix above it.

### Failure diagnosis also uses cacheable system blocks

The post-failure diagnosis prompt now sends:
- a stable diagnosis instruction block with `cache: true`
- application context with `cache: true`

## Why this split

OpenAI and Anthropic handle caching differently, so the runner uses a provider-neutral intent:
- stable prompt prefix => cacheable
- volatile runtime state => not cacheable

That keeps `/v2` requests backward compatible while giving `aiapi` enough information to optimize requests per provider.

## Files touched

- `src/ai/types.ts`
- `src/ai/prompts.ts`
- `src/ai/diagnose.ts`
- `tests/ai-client.test.ts`
- `tests/prompts-cache.test.ts`

## Notes

- User messages, DOM snapshots, screenshots, retry hints, current URL, and API response history are intentionally not cache-marked.
- `AiClient` already passes message blocks straight through to `aiapi` v2, so the main work was prompt construction rather than transport changes.
