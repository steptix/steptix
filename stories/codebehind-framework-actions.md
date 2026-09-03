# Code-behind for tabs and browsers — the last six steps that always needed AI

Builds on [step-codebehind.md](step-codebehind.md) (the `.steps.ts` file and
the `run(ctx)` contract) and [codebehind-compile.md](codebehind-compile.md)
(the compile that writes it). One gap, closed: a step that opens a tab,
switches to it, closes it, or does the same for a whole browser can now be
compiled to code, and the code drives the same trackers the AI actions drive.

## What we're building

Write a test that uses a second tab:

```markdown
1. Navigate to /new-window
2. Click "Open New Tab" and switch to the new tab
3. Confirm the new tab shows "Opened in a new tab"
4. Close the new tab and return to the first one
```

Run it and it works — the AI issues `click`, then `switchPage`, then
`closePage`, and the framework's `PageTracker` moves the active page under
it. Compile it and steps 2 and 4 come back refused, on every compile,
forever:

```ts
{
  // Kept as AI by `aiui compile`: the step used "switchPage", which changes runner state rather than the page
  source: 'Click "Open New Tab" and switch to the new tab',
  ai: true,
},
```

Six actions are on that list — `openPage`, `switchPage`, `closePage`,
`openBrowser`, `switchBrowser`, `closeBrowser` — and the reason given is
true as far as it goes. A `run(ctx)` body receives `page`, `context` and
`browser`: the live instances for whichever page is active *right now*. It
can call `context.newPage()` happily enough, but nothing it does can tell the
runner "the active page is that one now", so step 3 would still be pointed at
the first tab. Rather than write code that silently breaks the steps after
it, the compiler declines.

The cost is not one step. It is that *any* test touching a second tab or a
second browser has a permanent AI floor: a popup-based OAuth flow, a
"print preview opens in a new window" check, a two-browser test of one user
seeing another's edit. The most valuable tests to make deterministic are
exactly the ones that cannot be.

After this story, the same compile writes real code:

```ts
{
  source: 'Click "Open New Tab" and switch to the new tab',
  async run({ page, tabs, log }) {
    const opened = await tabs.openedBy(() =>
      page.getByRole('button', { name: 'Open New Tab' }).click(),
    );
    await opened.getByRole('heading', { name: 'Opened in a new tab' }).waitFor();
    log.info(`switched to ${opened.url()}`);
  },
},
```

```ts
{
  source: 'Close the new tab and return to the first one',
  async run({ tabs }) {
    const main = await tabs.close('/new-window/tab');
    await main.getByRole('heading', { name: 'Window & Tab Test' }).waitFor();
  },
},
```

and the run after that serves both steps from the file, with no model call.

### What it looks like in practice

**You write:** *"Open https://docs.example.com in a new tab"*
**You get:** `await tabs.open(step.getVar('data.docsUrl'))` — a real new tab,
promoted to active, on screen if the run is headed, and step 3 targets it
without anything further.

**You write:** *"Click Open New Window and switch to the popup"*
**You get:** `tabs.openedBy(trigger)` — the click and the wait for the popup
in one call, so there is no window where the tab does not exist yet. This is
the shape that a poll-and-hope `switchTo` gets wrong.

**You write:** *"Switch back to the main tab"*
**You get:** `await tabs.switchTo('main')`.

**You write:** *"Open a second browser as worker and sign in as the reviewer"*
**You get:** `await browsers.open('worker')`, which launches under the run's
own browser config, registers on the `BrowserTracker`, and returns the new
browser's active page — the same auto-promote the `openBrowser` action does.

**You run the test again.**
**You get:** every one of those steps `</>` in the gutter. Nothing on that
list needs a model any more.

> **Verification rule.** "Done" means: (1) each of the six actions has a
> `ctx` call that drives the *same* tracker method the AI action drives, so
> there is one implementation of "switch the active page" and not two;
> (2) a step compiled from a `switchPage` transcript, replayed, leaves the
> following AI step on the tab the code switched to — proven by a step after
> it asserting on the new tab's content; (3) `refuseReason` no longer names
> any of the six, and `prompt` still is refused; (4) an entry that switches
> and then uses the stale `page` handle is caught before it is written;
> (5) a run with no page tracking makes `ctx.tabs` throw a named error, and
> the step heals to AI rather than passing wrongly; (6) a live test compiles
> a real tab-opening test against `fixtures/test-app` and the proving run
> shows `</>`.

## Design

### One tracker, two views of it

Every one of the six actions is a call on a tracker the runner already owns —
`PageTracker` for the three page-level ones, `BrowserTracker` for the three
browser-level ones. The step executor holds both. Code-behind gets a narrow
view of each, not a new mechanism:

| Step says | AI action | `ctx` call | Tracker method |
| --- | --- | --- | --- |
| open a tab at a URL | `openPage` | `tabs.open(url, { as })` | `newPage` + `markExpected` + `relabelPage` + `switchToAsync` |
| the app opened a tab | `switchPage` | `tabs.openedBy(trigger)` | `waitForEvent('page')` + `markExpected` + `switchToAsync` |
| switch to a known tab | `switchPage` | `tabs.switchTo(id)` | `switchToAsync` |
| close a tab | `closePage` | `tabs.close(id)` | `closePage` |
| open a browser | `openBrowser` | `browsers.open(label, opts)` | `launchBrowser` + `add` |
| switch browser | `switchBrowser` | `browsers.switchTo(label)` | `switchTo` |
| close browser | `closeBrowser` | `browsers.close(label)` | `close` |

The identifiers are the AI's identifiers: a label (`main`, `docs`,
`page:2`), a URL substring, or a title substring, resolved by the tracker's
own matching. A transcript's `switchPage` carries the string the model used,
so the generated code can carry it through unchanged.

### Every mutating call returns the new active page

This is the load-bearing decision. `run({ page, ... })` destructures, and
destructuring reads once — so after a switch, `page` is a handle on the tab
the step just left. A getter on `ctx` would not help; the binding is already
made.

So `tabs.open`, `tabs.openedBy`, `tabs.switchTo`, `tabs.close`,
`browsers.open` and `browsers.switchTo` all return the `Page` that is active
afterwards. Generated code names it and uses it:

```ts
const popup = await tabs.openedBy(() => page.getByText('Terms').click());
await popup.getByRole('heading', { name: 'Terms of Service' }).waitFor();
```

`browsers.close` returns `void` — closing a browser can leave zero browsers
tracked, and there is no honest page to hand back. A step that closes the
only browser is the one step whose post-condition is that nothing is left.

### Two static backstops

The prompt says use the returned handle, and destructure what you use. The
backstops are for when it does not. Both share
`ambiguousSelectorComplaint`'s one re-ask and its "never worse than the first
answer" fallback.

`staleHandleComplaint` finds the first call to a switcher and complains if a
bare `page.` or `context.` use follows it on a later line. It is deliberately
one-directional in what it misses: a `page` used *before* the switch is
correct and left alone (that is where `openedBy`'s trigger lives), and a
handle passed through a helper is not tracked. Catching the common case for
free beats catching every case with a parser.

`undeclaredContextComplaint` catches a context property used without being
destructured. The prompt's example shape is `async run({ page, step, log })`,
and a model adding `browsers.open(...)` sometimes leaves that list alone —
which is a `ReferenceError` on the first replay. This is not hypothetical: it
is what the first live run of `compile-browsers.md` did, on all three of its
browser entries at once. A `ReferenceError` heals to AI, so the step passes
and the author is left chasing a ⚠ whose cause is one missing word.

### Focus follows the switch

The AI path calls `showTab` after `openPage` and `switchPage`, so a watching
human sees the tab being driven. The `ctx` API takes the same callback from
the step executor and calls it at the same points. Without this a compiled
test drives an invisible tab while the wrong one sits on screen — the change
that makes a headed run stop being watchable.

### No tracker, no silent pass

Not every path that runs code-behind has a `PageTracker` (a tools-only
context, a caller constructed for one entry). There, `ctx.tabs` exists but
every method throws `CodeBehindTabsUnavailableError` with the same wording
the AI action uses — *"page tracking is not enabled"*. The step then fails as
broken code, heals to AI, and is flagged stale. It must not be an API that
silently no-ops: a `switchTo` that quietly did nothing would leave the
following steps on the wrong tab with everything green.

### Refusal shrinks to one action

`FRAMEWORK_ACTIONS` loses all six and keeps `prompt`, which genuinely needs a
human at a terminal. The prompt's own decline sentence — which today names
"opening or switching a browser or tab" as a reason to decline — is rewritten
to name the `ctx` calls instead, or the model will keep declining out of
politeness.

### The post-condition rule needs two carve-outs

Rule 9 says every entry must end by checking the page shows the step
succeeded. Two of these steps have no page that can answer.

A step that **closed** something has none left — checking the tab it just
closed is the obvious wrong move — so the post-condition is that the thing is
gone: `tabs.list()` no longer naming it, or `browsers.list()` no longer
naming the label.

A step that **opened a browser** has one, but it is `about:blank`: nothing has
navigated it yet. Its post-condition is that the browser exists and is active
(`browsers.list()` / `browsers.activeLabel()`), and an entry that waits for
content there flakes or hangs. `switchBrowser` deliberately gets no carve-out
— the browser you switched *to* has real content, so the ordinary rule applies
to the page it returned.

## Implementation outline

1. **`src/codebehind/tabs.ts`** (new) — `makeTabApi(tracker, hooks)` and
   `makeBrowserApi(tracker, launch, hooks)`, plus the unavailable-stubs. Type-
   only imports of `PageTracker`/`BrowserTracker`, so no cycle with
   `browser/manager.ts`.
2. **`src/codebehind/types.ts`** — `CodeBehindTabApi`, `CodeBehindBrowserApi`,
   `CodeBehindTabInfo`, `CodeBehindBrowserInfo`; `tabs` and `browsers` on
   `CodeBehindContext`.
3. **`src/codebehind/execute.ts`** — `RunCodeBehindOptions` gains `tabs` and
   `browsers`; absent means the throwing stub, never an omitted field, so an
   entry destructuring `{ tabs }` never gets `undefined`.
4. **`src/runner/step-executor.ts`** — `runCodeBehindStep` builds both APIs
   from `opts.pageTracker` / `opts.browserTracker`, passing `showTab` as the
   focus hook and a closure over `config.browser` as the launcher.
5. **`src/codebehind/generate.ts`** — `FRAMEWORK_ACTIONS` down to `prompt`;
   add `staleHandleComplaint` and `undeclaredContextComplaint`, chained into
   the same single re-ask as the selector backstop.
6. **`src/ai/prompts.ts`** — document `tabs` and `browsers` in the ctx list,
   rewrite the decline sentence, extend rule 6 to demand destructuring, add
   rule 7a and the two post-condition carve-outs.
7. **Fixtures + live tests** — `templates/init/tests/compile-tabs.md` against
   `fixtures/test-app/new-window` and `compile-browsers.md` opening a real
   second browser, each with a live suite that compiles it and proves the
   entries as code.

## Tests

- `refuseReason` allows all six and still refuses `prompt`.
- `staleHandleComplaint` fires on `await tabs.switchTo(...)` followed by
  `page.locator(...)`, and stays quiet when the returned handle is used, when
  `page` is used only before the switch, and when there is no switch at all.
- The tab API drives the tracker: `open` marks the page expected, relabels it
  when `as` is given, and leaves the tracker's active page as the new one.
- `openedBy` returns the page the trigger opened, not a pre-existing one.
- `close` returns the tracker's post-close active page.
- The unavailable stub throws (and the async members *reject*, so it fails the
  same way however the entry calls it), and the message names page tracking.
- `undeclaredContextComplaint` fires on a used-but-undestructured name, is
  quiet when it is destructured, exempts a local of the same name, and says
  nothing about an entry that took the whole context as `run(ctx)`.
- Live: `compile-tabs.md` and `compile-browsers.md` compile to entries with no
  `ai: true`, and their proving runs paint `</>`.

## What was built

All of the outline, plus three things the build turned up.

**A `ReferenceError` nobody would have predicted from the prompt.** The first
live run of `compile-browsers.md` generated all three browser entries
correctly and all three threw `browsers is not defined` — the model wrote
`browsers.open('worker')` while leaving `run`'s parameter list at the
`{ page, step, log }` the prompt's example shows. Every one healed under AI,
so the run was green and 62k tokens poorer. Fixed twice over: rule 6 now says
destructure what you use, and `undeclaredContextComplaint` re-asks when it
does not. The tab entries never hit this, which is why only a second live
fixture found it.

**`promote` switches by tracked label, not by URL.** The AI `openPage`
handler does `switchToAsync(newPage.url())` — a URL *substring* match. With
two tabs on one URL that can promote the wrong one, and the caller cannot
tell, because a `Page` still comes back. `makeTabApi` looks the page up in
`tracker.tabs()` by object identity, takes its label, and switches on that.
Registration is event-driven, so it polls briefly for the entry rather than
assuming `context.on('page')` has already fired.
`tests/codebehind-tabs.test.ts` covers it directly ("promotes the tab it
opened, not a same-URL sibling").

**The step result had to be re-read from the tracker.** `runCodeBehindStep`
captured `page` before running the entry and then took the screenshot and
`pageUrl` from it — so a step that switched tabs reported the tab it left.
Worse than no screenshot, because it looks right. It now refreshes from the
browser tracker, then the page tracker, in the same order the AI loop's own
turn-zero refresh uses.

### Measured

`aiui compile templates/init/tests/compile-tabs.md`, 2026-09-03: 5 of 5 steps
written as code in one round, replay `5/5 passed as code` in 0.8s with
`Tokens used: Input: 0, Output: 0`. The generated entries read:

```ts
async run({ page, tabs }) {
  const opened = await tabs.openedBy(() => page.click('#open-tab-btn'));
  await opened.getByRole('heading', { name: 'Account Summary' }).waitFor({ state: 'visible' });
},
```

and, for the close step, the post-condition carve-out doing its job — the
assertion is over `tabs.list()`, not over the page that was closed.

The live suite's proving run ends `✓ 5 passed (5 code-behind)`, all five
steps in 350ms against the same fixture that takes ~3 minutes under AI.

`compile-browsers.md` — which launches, drives and closes a real second
browser — proves the same: `✓ 5 passed (5 code-behind)` in 1.2s. Its step 4
is the one that cannot pass by accident, asserting the *default* browser's
own heading after a compiled switch back; an entry that launched a second
Playwright browser without moving the run's `BrowserTracker` leaves the run
in the worker, where that heading does not exist.

One flake seen and left in place deliberately: a compile whose proposal was
missing only the `close` entry, on a run that produced all five twice
afterwards. Whether a given generation lands is model variance, so the live
suite asserts *most* of the tab entries plus the exact, deterministic guard —
no `ai: true` anywhere in the file, which is what a regressed `refuseReason`
would produce.

## Non-goals (this story)

- **Skipping AI on the first run.** These steps still cost one AI turn to
  discover, exactly like every other step: the compile learns from a
  transcript. Parsing *"open a new tab to X"* deterministically from the step
  text, with no model at all, is the `navigate_tab` idea one level up and is
  a separate story.
- **`prompt`.** It waits on a human; there is no code for that.
- **Cross-browser handles in one entry.** `browsers.switchTo` returns the new
  active page, but an entry holding pages from two browsers at once is not
  something the prompt will be taught to write.
