# Hybrid Vision + DOM Architecture

## Problem

The current architecture sends the entire DOM snapshot as the AI's only source of information about the page. This causes three serious problems we observed during the DuckDuckGo search test:

### 1. DOM snapshots are enormous and slow

The DuckDuckGo homepage produces a **164,922 character** DOM snapshot. Timing instrumentation revealed that AI call latency correlates directly with DOM size:

| DOM size (chars) | AI response time |
|------------------|-----------------|
| 164,922          | 10,053ms        |
| 120,414          | 8,176ms         |
| 100,538          | 3,699ms         |
| 49,470           | 2,081ms         |
| 110              | 1,351ms         |

A simple "navigate and verify the search box is visible" step took **39.4 seconds** — nearly all of it waiting for the AI to process a massive DOM it mostly didn't need.

### 2. Token costs are excessive

A 5-step test consumed **115,783 input tokens** in a single run. Most of that is DOM content the AI never acts on — marketing sections, privacy comparison tables, footer links, deeply nested wrapper divs. With `verifyStepCompletion` enabled (which forces an extra AI turn per step), these costs double.

### 3. Batched actions fail silently

The framework asks the AI to plan multiple actions in a single response and executes them all before checking the result. During testing, the AI planned "type search query + press Enter" as a batch. The Enter key action used an unimplemented `key` action type, which was silently skipped. The step was marked as passed despite the search never being submitted. The assertion step (step 3) eventually caught it, but only by accident.

This is a fundamental brittleness: the AI cannot observe the result of action A before planning action B. A human tester looks at the screen after every action — the AI should too.

### 4. The AI is blind

`sendScreenshots` is set to `false`. The AI works entirely from the text DOM snapshot — it cannot see the page. It has no visual context for layout, colours, error states, loading indicators, or whether an action visually succeeded. The DOM is asked to serve as both the page description and the selector source, which is why it needs to be so large.

## Research: How Claude Computer Use Works

Claude's computer use API takes a fundamentally different approach:

- **Pure vision** — works entirely from screenshots, no DOM access at all
- **Pixel coordinates** — identifies elements visually, returns x,y coordinates for mouse actions
- **One action per turn** — screenshot, analyse, act, screenshot, repeat. Never batches
- **Native tool use** — actions are structured tool calls, not "return a JSON blob" prompts
- **Verification built in** — Anthropic's own docs recommend instructing Claude to "take screenshots and verify each step" because it sometimes assumes outcomes without checking

This architecture is inherently more reliable because the AI observes after every action. But pure vision has a weakness for browser automation: pixel coordinates are less precise than CSS selectors and break with responsive layouts, different viewports, and dynamic content shifts.

## Proposed Architecture: Hybrid Vision + Compact DOM

The hybrid approach takes the best of both worlds:

- **Screenshots** provide visual understanding — the AI sees the page like a human does
- **Compact DOM** provides precise selectors — Playwright's selector-based APIs are far more reliable than coordinate-based clicking

With vision enabled, the DOM's role fundamentally changes. It no longer needs to *describe* the page (the screenshot does that). It only needs to provide *selectors for targeting elements*. This allows aggressive size reduction without information loss.

## Implementation Path

### Phase 1: Enable Screenshots

Turn on `sendScreenshots: true` in the default config. The AI immediately gains visual understanding of the page. This is a one-line config change but a fundamental capability shift — the AI can now see loading states, error messages, layout issues, and verify action outcomes visually.

**Trade-off:** Vision tokens have cost. A screenshot typically adds ~1,000-2,000 tokens per turn. But this is far less than the 30,000-40,000 tokens saved by compacting the DOM.

### Phase 2: Compact the DOM

With vision providing page understanding, redesign the DOM snapshot as a **selector-focused skeleton**:

- **Always include:** Interactive elements (buttons, inputs, links, selects) with their attributes and position annotations. Landmark structure (nav, main, header, footer, form, section). Headings for orientation.
- **Collapse repeated siblings:** `<table data-testid="orders"> <!-- 30 <tr> rows, cols: ID, Name, Status, Date, Actions -->` — include counts and column/item summaries so the AI knows what's there without seeing every row.
- **Target size:** ~10-20K chars instead of 100-165K. An 80-90% reduction in input tokens per turn.

No information is lost — it's deferred to Phase 4's exploration actions.

### Phase 3: One Action Per Turn

Move from "plan all actions, execute blind" to "plan one action, execute, observe, repeat":

1. AI sees screenshot + compact DOM
2. AI returns a single action (JSON response, same format as today)
3. Framework executes the action (Playwright's built-in actionability waits ensure the target element is visible, enabled, and stable before acting)
4. Framework captures fresh screenshot + DOM immediately — no artificial settle delay
5. AI observes the result and decides the next action
6. Repeat until the step's goal is achieved

**No framework-level settle waits.** The framework does not pause between action and observation. Playwright's action methods already wait for element actionability, which is sufficient. After the action completes, the framework captures the screenshot + DOM immediately. If the page is mid-transition (spinner visible, content loading, blank page), the AI sees this in the screenshot and can return a `wait` action on the next turn — just as a human would look at the screen and wait when they see a loading indicator. This keeps the loop fast when no wait is needed (the common case) and lets the AI make contextual wait decisions when it is needed.

This naturally solves the problems that `verifyStepCompletion` was designed for:
- The AI sees the result of every action
- Silent failures (like the Enter key not registering) are caught immediately
- No need for a separate "verification turn" — every turn is a verification

**Why this becomes viable:** With compact DOM (~15K) instead of full DOM (~165K), each turn is fast and cheap. Even if a step takes 3 turns instead of 1, total tokens and latency are lower: 3 x 15K = 45K vs 1 x 165K.

**Transition approach:** This doesn't require a hard cutover. Start by reducing the default batch size — instead of unlimited actions per response, encourage the AI to return 1-2 actions at a time. The existing multi-turn loop already supports this via `needs_reeval`.

### Phase 4: AI-Driven DOM Exploration

Add new action types that let the AI request more detail when the compact DOM isn't enough:

| Action   | Purpose | Human analogy |
|----------|---------|---------------|
| `find`   | Search the full DOM for specific text. Returns matching elements with their selectors and surrounding context | Ctrl+F in browser |
| `expand` | Return the full DOM subtree for a given selector. E.g., expand a collapsed table to see all rows | Expanding a node in DevTools |

These actions set `needs_reeval: true`. The next turn includes the requested detail injected into the DOM snapshot.

**Typical flows:**

- **"Click the login button"** — Button is in compact DOM. One action, done.
- **"Find order ORD-789 and click Delete"** — AI sees collapsed table in compact DOM. Uses `find` with "ORD-789". Gets back the matching row with its selector. Clicks Delete. Three turns, each with small payloads.
- **"Verify 30 results are displayed"** — AI sees `<!-- 30 <article> elements -->` in compact DOM. Count is right there. One turn.
- **"Scroll down and check the footer"** — AI scrolls, gets fresh viewport screenshot + DOM. Checks footer. Two turns.

## Expected Impact

| Metric | Current | After |
|--------|---------|-------|
| DOM size per turn | 100-165K chars | 10-20K chars |
| Input tokens per step | ~30-40K | ~5-10K |
| AI call latency per turn | 3-10s | 1-3s |
| Silent action failures | Common (batched) | Caught immediately (observed) |
| Visual understanding | None | Full |

## Dependencies and Considerations

- **AI gateway must support vision:** The gateway at `llm.corp.example` needs to accept image content in messages. Currently `sendScreenshots: false` suggests this may already be supported but disabled.
- **Prompt changes:** The system prompt needs updating to reflect one-action-per-turn expectations and the new exploration actions.
- **Cache invalidation:** The step cache stores full action plans. Moving to one-action-per-turn changes what gets cached — may need to cache at the turn level rather than step level.
- **`verifyStepCompletion` becomes redundant:** Once every turn naturally observes the result, the separate verification mechanism can be removed.

## Future Optimisations

- **Native tool use:** The AI currently returns actions as JSON text, which the framework parses (handling markdown fences, action type aliases, etc.). Both OpenAI and Anthropic support native tool use where actions become structured API-level tool calls instead of parsed text. This would eliminate the JSON extraction layer and give schema-enforced responses, but the current parser is reliable and the gateway doesn't support tool definitions yet. Consider when the gateway is upgraded or if JSON parsing becomes a pain point.
