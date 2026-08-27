# Selector ambiguity, and the repair loop

Builds on [compile-as-you-go.md](compile-as-you-go.md), which made recording
and generation ride the author's own run, and on
[codebehind-compile.md](codebehind-compile.md), which shipped the pipeline.
Nothing about the `.steps.ts` format, the binding rules, the secret-leak
guard, or the diff → Apply flow changes.

What changes is the *evidence* generation works from, and how visible it is when
an entry breaks. Today the framework knows, at the instant it acts, exactly how
many elements a selector matched and which one it touched — and throws all of it
away. Then, when the resulting entry fails on a later run, the step heals under
AI, the run reports a clean pass, and the AI turn that healed it is paid again
on every run afterwards with nothing at the run level to say so.

## What we're building

Two things, one idea: stop making the model guess about the DOM, and stop
making the author pay twice for the same evidence.

**Measurement.** At the moment the AI runtime acts on an element, it counts
what the selector matched and identifies what it actually touched — verified
against the live document, not against the cleaned snapshot. Those facts ride
the transcript into generation, so the entry is written from what the runtime
*found* rather than from what the model *proposed*.

**A repair the author can find.** When a compiled entry throws, the step heals
under AI as it does today and is flagged ⚠. Repairing it already works — and
nothing about the ⚠ says so. It gets a named action, and the run that healed it
stops reporting as a clean pass, so the recurring cost of leaving it broken is
visible instead of silent.

The problem both halves solve is the one that sends authors back to the
drawing board:

```
Run checkout.md
  ✓ step on line 12  0.9s  </>
  ✓ step on line 13  0.8s  </>
  ⚠ step on line 14  4.2s  healed under AI
             locator('a[href="/login"]') resolved to 2 elements
```

The test passed under AI. The compiled code did not. Nothing the author wrote
is wrong, and nothing they can read explains it — the second `<a>` is inside a
hidden mobile-nav drawer that never appears in the DOM snapshot the model was
shown.

After this story, that entry is written correctly the first time. And when an
entry does break — because the application changed, which is the honest reason
entries break — the ⚠ carries the fix, and the run that hid the cost stops
hiding it.

## Context — why the AI passes and the code fails

The AI runtime puts every selector through the same tolerant pipe
([actions.ts](../src/browser/actions.ts)):

```ts
await root.locator(selector).locator('visible=true').first().click({ timeout: 10_000 });
```

Two tolerances: hidden matches are filtered out, and of what remains the first
is taken. Generated code-behind has neither — Playwright's default is strict,
and it throws on the second match, visible or not.

So a recording proves "one visible match was clickable". It has never been
evidence that one match *exists*. That gap is the whole class of failure.

[compile-as-you-go.md](compile-as-you-go.md) already attacked it twice, under
"What the first real use changed", and both fixes were advisory. Rule 8 in the
generate prompt tells the model a transcript selector is not proof of
uniqueness and to "use a handle the DOM above shows to be unique". Repair
parity routes a stale entry through `buildRepairPrompt` so it sees its own
failure instead of regenerating blind. Both were right. Neither measures
anything, and the first asks the model to answer a question its evidence
cannot answer.

**The snapshot is a lossy projection, and every loss biases toward
under-counting.** It is truncated at 100k characters
([dom-cleaner.ts](../src/browser/dom-cleaner.ts)); attributes are allowlisted,
so classes and most `data-*` never appear; runs of same-tag siblings collapse
to `<!-- 12 similar <li> elements omitted -->`; and hidden elements are emitted
as tag-only placeholders with their attributes **stripped**, because "the
element isn't a target, so id/class/aria etc. are pure noise"
([capture-dom.js](../src/browser/scripts/capture-dom.js)). True for the AI.
Fatal for uniqueness checking, because the hidden `<a>` that strict mode counts
is precisely the one whose `href` was removed.

The model reads the snapshot honestly, concludes "unique", and is wrong.

**And the framework's own selector builder asserts uniqueness it never
checks.** `strongSelector` in
[find-in-dom.js](../src/browser/scripts/find-in-dom.js) is documented as
*"Strong" = uniquely addressable from document root*. Its last rule is:

```js
if (tag === 'a') {
  var href = el.getAttribute('href');
  if (href) return 'a[href="' + escAttr(href) + '"]';
}
```

No `querySelectorAll`. No count. It returns the first stable-*looking*
attribute and stops. `buildSelector` in capture-dom.js has the identical flaw.
So the framework hands the model a selector it has claimed is unique, the model
believes it, and strict mode disagrees one run later.

The browser can answer this question in about two milliseconds. We have never
asked it.

## Design

### Measurement 1 — what the runtime found

`executeAction` already sanitizes the selector, promotes iframe segments and
resolves the frame root into an effective action `eff`. After that, and before
acting, it hoists the wait the action was going to do anyway and measures at
the instant Playwright would have acted:

```ts
const target = root.locator(eff.selector).locator('visible=true').first();
await target.waitFor({ state: 'visible', timeout });   // the wait the click would have done
// the page has settled to the state the action acts on — measure here
await target.click({ timeout: remaining });
```

Hoisting is what makes the numbers mean anything. Measuring cold at T0 would
record `matchCount: 0` for the very common case where the element renders 400ms
later and the click then succeeds — a confident lie, worse than no data at all.
After `waitFor` resolves, at least one visible element exists by construction,
so `matchCount >= visibleMatchCount >= 1` always.

**The hoisted wait must not add a second timeout budget.** Today's budgets are
per-action and already tight — click 10s, type 5s + 10s, select 5s + 10s,
upload and hover 10s. Giving `waitFor` its own 10s would double the worst-case
time for a *failing* selector to report, which is a real regression in feedback
latency even though no passing test slows down. So the wait is timed and the
remainder is passed to the action, preserving total wall-clock. This is not a
detail to leave to the implementation: getting it backwards silently halves
every action's patience.

The measurement produces three facts:

- **`matchCount`** — every match, hidden included. This is strict mode's
  number: the one that predicts whether generated code will throw.
- **`visibleMatchCount`** — what the runtime was actually choosing between. A
  different question: whether the AI may have silently acted on the wrong
  element.
- **`resolvedSelector`** — a selector for the element about to be acted on,
  *verified in page context* with `qsa(sel).length === 1 && qsa[0] === el`,
  falling through on failure instead of returning the first plausible one.
- **`resolvedBy`** — `'attribute' | 'scoped' | 'positional'`, which of the
  three ways below produced it.

The candidate order, and the build corrected the spec here. An earlier draft
said the element's own attribute handle (`data-testid`, `id`, `name`,
`aria-label`, anchor `href`) with **null when none is unique** — which is
exactly wrong for the case this whole story exists for. In the headline
failure the visible `a[href="transactions.html"]` has no unique attribute
handle *precisely because* the hidden duplicate exists, so that rule returns
null for the one case it most needs to answer. Measured on the fixture:

```
a[href="transactions.html"]                         -> 2
#statements a[href="transactions.html"]             -> 1  (the target)
#statements > div:nth-of-type(1) > a:nth-of-type(1) -> 1  (the target)
```

So: **own attribute handle** → **that same handle scoped to the nearest
verified ancestor** → **positional chain** → null. The middle one is the form
the story's own example always showed (`nav#main-nav a[href="/login"]`), and
skipping straight to the positional chain would have been a real loss of
quality rather than a technicality — insert a sibling above that panel and the
positional chain silently retargets while the scoped form does not. This is a
committed file that runs for years; that difference is the point. `null` now
means "not even a positional path verified", which is rare.

`resolvedBy` exists because generation has to tell those apart. A `'positional'`
answer on a step whose text names what distinguishes the element is the
data-driven carve-out below, and deciding that by sniffing the selector string
for `nth-of-type` would be exactly the kind of guess this story is trying to
delete.

The same verification predicate is added to `strongSelector` and
`buildSelector`, which fixes the upstream half: the AI stops being handed
selectors that were only ever *claimed* to be unique.

Two things about that second change, and the review round got the first one
wrong — the build corrected it.

**It WAS on the per-element path.** The review read `buildSelector`'s two call
sites in [capture-dom.js](../src/browser/scripts/capture-dom.js) as "once per
iframe, once per collapsed run" and concluded the check was cheap. Wrong:
`processChildNodes` and `processElement` are mutually recursive, and the second
call sat at the *top* of `processChildNodes`, so it ran for every element with
children. Adding verification there as written would have been precisely the
O(n²) the review had talked itself out of worrying about. The fix is to build
`parentSel` lazily — inside the `omittedCount > 0` branch, only when a marker is
actually emitted — which makes it once per collapsed run for real. Two tests pin
it by counting `querySelectorAll` calls: zero when capturing a 200-element page
with no collapsed run, under ten when one collapses.

**And it is a larger change than "add a check"**, because `buildSelector` has no
fallback to fall through *to*: its last resort is a bare `tag`. Verifying it
means giving it a positional path of the kind `stableSelector` already builds in
find-in-dom.js. Worth doing anyway, because that call site feeds the omission
marker's hint text — "target directly with `#list > li:nth-of-type(N)`" — so an
unverified parent selector there hands the AI a *misleading instruction*, not
merely a weak one. It also retires a real strict-mode hazard: an attribute-less
iframe used to be labelled bare `iframe`, which is a violation on any page with
two of them.

**One constraint the positional path inherits.** `buildSelector`'s output is
also the AI's *frame* path — the selector in the `<iframe> <!-- ... -->` comment
— and `resolveLocatorRoot` in [actions.ts](../src/browser/actions.ts) splits a
frame selector on whitespace when it carries no `>>`. So capture-dom's chain
joins with `>` and no spaces (`body>iframe:nth-of-type(2)`); find-in-dom's
`stableSelector` keeps its spaced `' > '` join, because its output is only ever
an element selector. The whitespace split is a latent hazard for any
multi-segment frame selector, not just this one.

Two numbers rather than one, because they answer different questions and only
one of them is the reported bug. `matchCount > 1, visibleMatchCount === 1` is
the hidden-duplicate case — the AI was right, the code would throw.
`visibleMatchCount > 1` means the AI took the first of several candidates and
nobody can tell whether it was the right one. That second signal has never been
visible before and is worth surfacing on its own terms.

### Where the measurement goes

One field, threaded down a pipe that already exists.

`ActionExecutionResult` gains `targeting`. The sub-action record in
[step-executor.ts](../src/runner/step-executor.ts) — which today stores the raw
`action` and nothing about what the runtime did with it — carries it onto
`SubActionResult`. `actionsOf` in [candidate.ts](../src/codebehind/candidate.ts)
merges it into the transcript it hands generation, and `recording.ts` writes it
to disk with the rest of the step. The generation prompt's transcript block then
reads:

```json
{
  "action": "click",
  "selector": "a[href=\"/login\"]",
  "targeting": {
    "matchCount": 2,
    "visibleMatchCount": 1,
    "resolvedSelector": "nav#main-nav a[href=\"/login\"]"
  }
}
```

This also closes a latent divergence worth naming: `sanitizeCssSelector` and
`promoteIframeFromSelector` both rewrite the selector into `eff`, and `eff`
never escapes `executeAction` on success. Generation sees the raw proposal, not
what ran. A React Aria id like `#react-aria-:rb4:` is recorded unescaped and
compiled into code Playwright parses as a pseudo-class. `targeting` records what
the runtime resolved, so the principle generalizes: **record what executed, not
what was proposed.**

**Ordering constraint, from the review round.** `recording.ts` writes actions as
`actionsOf(result).map((a) => redactDeep(a, secrets))`. A `targeting` field that
lives on `SubActionResult` and is merged in *after* that map would skip
redaction entirely, and `resolvedSelector` can carry a secret — a selector built
from an `aria-label` or `href` that contains a token. So the merge happens
inside `actionsOf`, before redaction, which means `actionsOf`'s return type
widens from `AIAction[]` to the action plus its measurement. That is the seam;
merging anywhere later is a leak.

**Measurement is compile-only.** It runs when the request is in a compile mode —
the same gate `captureStepContext` already uses, since generation is the only
consumer — and not on ordinary runs. Two CDP round-trips per element-targeting
action is nothing per step, but an ordinary run would pay it forever for data
nobody reads.

The consequence, stated plainly because it costs something real: the
`visibleMatchCount` signal — the AI silently acting on the wrong one of several
visible candidates — is then only visible *during a compile*. That is when
someone is watching, which is the argument for the gate. It also means an
ordinary regression run cannot surface a wrong-element click, and never could;
this story does not change that either way. Revisit if the signal proves
valuable in the compiles where it does appear.

Nothing new is measured on a cache replay — `cachedTurnForCapture` already skips
DOM capture there because nothing consumes it, and the same rule applies: a
cache hit generates nothing.

### What generation does with it

Rule 8 stops being advice and starts keying off a measured number. `matchCount >
1` means the entry must use `resolvedSelector`, or explicitly reproduce the
runtime's tolerance. There is no third option and no judgement call about what
"looks unique".

With one carve-out, which matters more than it looks. When the only unique
handle is **positional** — a `nth-of-type` path — and the step text or a
parameter names what distinguishes the element ("click the row for
{{customer}}"), the entry must build a data-driven locator off
`step.getVar(...)` instead of pinning this run's row number. Pinning it compiles
this run's *data* into a file that gets committed and runs for years, which is
exactly the defect
[issue 024](../issues/024-cache-value-driven-element-targeting-rides-cache.md)
documents for the step cache: "the frozen selector is often perfectly
well-formed — it just points at the wrong thing." Code-behind is more exposed
than the cache, because the file outlives the cache entry.

The net effect is that the model is moved off the question it is bad at — *is
this unique in a DOM I can only partly see?* — and onto the one it is good at:
*what does this step mean?*

Absence stays first-class. A transcript with no `targeting` generates exactly as
it does today; that is the fallback whenever measurement was impossible, and it
must never read as an error.

### The static backstop

Before the candidate is written, `validateCodeBehindSource` already
esbuild-checks that it compiles. Alongside it: if the transcript recorded
`matchCount > 1` for a singular action and the generated entry uses that
selector bare, refuse and re-ask once.

Deterministic, costs nothing, and it covers the case where the model reads the
measurement and ignores it anyway. It fires only when a count is present;
absence means the check does not run, not that it fails.

### `browser.ambiguousTarget` — the author's switch

`'first' | 'fail'`, default `'first'` (today's behaviour).

Under `'fail'`, a **singular** action whose selector resolves to more than one
candidate does not act. It returns a failure carrying the count, which flows
into `collectedFailures` and reaches the AI next turn as "3 elements matched —
use a more specific selector". The AI re-plans, usually by scoping to a
container or using `find`.

**"More than one candidate" means each action's own tolerance**, which the
build surfaced as a distinction the first draft missed. The rule is: did this
action's own `.first()` pick from more than one? Click, type, select, hover and
upload filter to visible before taking the first, so they gate on
`visibleMatchCount > 1`. Singular `read` takes `.first()` over *all* matches —
reading a hidden element is legitimate, so it waits for attachment rather than
visibility — so it gates on `matchCount > 1`. Gating read on the visible count
would let it capture from a hidden first match while reporting one visible
candidate, which is the worse of the two failures: a wrong click fails loudly,
a wrong read silently poisons a variable that later steps trust.

A read is also why `visibleMatchCount` can honestly be absent rather than zero.

For the visible-filtered actions this deliberately is NOT `matchCount`. Gating
those on the total would give literal parity with strict mode, but it would fail
the hidden-duplicate case — where the AI is demonstrably right and only the code
generation needed fixing. The measurement already hands generation a verified
handle there, so failing the run would be pure cost. That is also why there is
no third `'strict'` mode; see Non-goals.

Read gating on the total is not an exception to that reasoning but an
application of it: read has no visible filter to be right about.

What the switch buys is the case measurement *cannot* resolve. When three
visible elements match, we know the AI took the first; we do not know whether
that is the one the step meant. No amount of counting settles it, because the
ambiguity is about intent rather than about the DOM. Only the AI can settle it,
and only by being told its selector was ambiguous. **The rule is: don't let the
AI resolve ambiguity by accident.**

Off by default because it changes the behaviour of a path that currently works,
costs a turn each time it fires, and can turn a green test red — which is the
point, and is therefore the author's call about a suite, not a guess the
framework makes on their behalf. It is unrelated to
`execution.promptOnAmbiguity`, which asks the *human* when the AI cannot
determine the next action.

Plural actions are exempt by construction: `read` with `multiple: true` runs
`evaluateAll` across every match, and `count` returns `.count()` as its result.
Many matches is their purpose. This is also why `targeting` records a plain
count rather than a judgement like `ambiguous: true` — put the interpretation in
the rule that reads it, and the plural actions need no special case.

### Repair, which already works and cannot be found

When an entry throws on an ordinary run, `runCodeBehindStep` discards it, hands
the step to the AI, and the step passes. The run goes green with ⚠ and the
last-run sidecar records what broke.

**The review round found that repairing it already works.** "Compile This Step"
sends `mode: 'steps'`, which is exactly the mode where `priorFailure` reads the
sidecar, finds what the entry threw, and routes generation through
`buildRepairPrompt` carrying the failing code and the error. Run & Compile over
the whole test does the same, since the default `CompileSelect` is "no entry, or
flagged stale". Both paths re-run the step live and repair from what they see.

So this story builds no repair pipeline. An earlier draft proposed repairing
from the on-disk recording instead — `readRecording` has no production consumer,
so it would have been a new pipeline — and it was rejected for a better reason
than its cost: a repair should be generated from a live page, not from a
snapshot of one. Dropping it also removes a security hazard the review had
caught, since a recording redacts secret-named values and the leak guard fed
those placeholders would have passed an entry inlining the real secret. A live
re-run has live parameters by construction.

What is actually missing is that the author cannot *find* the repair. They see
⚠ and have no reason to think a command called "Compile This Step" is the fix.
So: **Repair this step**, a named action on the ⚠, routing to the path that
already exists.

**No page-precondition gate.** It runs the step from wherever the session is
parked, exactly as `runStepHere` and `compileStepOnActive` already do — their
only refusals are about inert lines, numbering and scope, never page state. The
framework cannot check this by inspection anyway: whether a page satisfies
"click the login link" is answerable only by looking for a login link, which is
the step itself. The only sound signal would be provenance — did we arrive here
by running steps 1..k — and the session does not track it. Rather than invent
that and break the convention two sibling commands already set, the action runs
and lets a wrong page fail the step, which is the feedback model authors already
understand here. The ⚠ hover says what it will do — "re-runs this step in the
current session" — so the precondition is visible without pretending it is
verified.

The two paths then cover the two moments. Repairing right after watching a step
heal means the session is paused or mid-run and therefore parked correctly, so
the per-step action is the fast path. After a completed run the browser is at
the end state, and the answer is Run & Compile, which picks up stale steps by
default. Each is right for when an author would actually reach for it.

The repaired entry is unproven, and the next run proves it. That is the bargain
[compile-as-you-go.md](compile-as-you-go.md) already made deliberately, not a
new compromise.

### A healed run stops reporting as a clean pass

Today an entry can throw, heal, and leave `TestReport.status` at `'passed'` with
exit code 0. The ⚠ is on the step and the report generator counts
`{ code, ai, stale }` for display, but nothing at the run level distinguishes
"passed" from "passed after healing four broken entries". Three costs: CI cannot
gate on it, the AI turns are paid invisibly on every subsequent run, and the
signal that the application changed — often the thing the test exists to catch —
is buried.

**Not a new status value.** `TestReport.status` is typed `StepStatus`
(`'passed' | 'failed' | 'skipped'`) and shared with steps, and `leadingPassed` in
compile.ts breaks its loop on `step?.status !== 'passed'` to decide how much of a
recording is usable — so a healed step that stopped being `'passed'` would make
compile silently truncate the prefix. The codebase has answered this exact
question twice already, for `interrupted` on a step and `aborted` on a run: a
separate field drives a distinct display state, and `status` stays a valid
`StepStatus` "for back-compat with older report readers". This follows that
precedent.

So: `healedSteps` on `TestReport`, an amber "PASSED — 4 steps healed" banner in
the shape `aborted` already established, and **the token cost attributed to it**
— the report already carries `inputTokens`/`outputTokens`, so the banner reads
"4 steps healed, 18.2k tokens" and the recurring price of leaving them broken is
impossible to miss. Plus `--fail-on-healed`, so CI can make it a build failure.

**In TestBench**, the same fact lands on the run's closing summary line, in the
house shape compile already uses:

```
◐ Run checkout.md: 8 passed, 1 healed under AI (4.1k tokens).
  Repair it, or it costs that again every run.
```

Per-step ⚠ marks stay as they are; this is the run-level line that was missing.

**The ⚠ carries its own history rather than a threshold.** A step that has healed
on every run for two months is not a warning any more, it is an AI test wearing a
code-behind badge — but picking the N at which a marker "escalates" is a config
knob and a judgement call nobody wants to tune. Instead the sidecar keeps a
consecutive-stale count and the marker simply shows it: *healed under AI (3 runs
in a row)*. Twelve reads worse than two without anyone choosing a cutoff.

One thing the framework still will **not** do: rewrite the file during an
ordinary run. A test runner that silently edits committed source every time it
executes is a bad neighbour, and it runs in CI, in worktrees, on machines
belonging to people who did not ask for it.

## Scenarios

The spine is one loop: **Run & Compile → Apply → Run → green.** Every scenario
below is either that loop working or a named deviation that returns to it.

### While recording

**One match, unique handle.** `matchCount: 1`, `resolvedSelector` is a semantic
handle. Generation uses it. Entry passes on the next run. The common case, and
it gets faster rather than slower.

**Many matches, one visible** — the hidden mobile-nav duplicate, the failure
this story opens with. The action proceeds untouched; the AI was right. Recorded
as `matchCount: 2, visibleMatchCount: 1, resolvedSelector: "nav#main-nav
a[href=\"/login\"]"`. Generation is told rather than left to infer, and writes
the scoped selector. **The entry works on its first replay** — the outcome that
does not happen today.

**Many visible matches.** The AI took the first of several candidates. Under the
default the action proceeds, both counts are recorded, and a warning is logged
naming the count. Under `ambiguousTarget: 'fail'` the action fails with the
count and the AI re-plans. Either way the transcript is honest about it — but
only during a compile, since that is where measurement runs.

`ambiguousTarget: 'fail'` is the exception to the compile-only gate, and has to
be: it decides by reading `visibleMatchCount`, so it cannot work without it.
Setting it turns on the visible count for that run whatever the mode. An author
who opts into `'fail'` has accepted the cost by definition, and it is one of the
two calls rather than both — `resolvedSelector` stays compile-only, since only
generation consumes it.

**No semantic handle, unique structural path.** `resolvedSelector` is a
`nth-of-type` chain, flagged positional. Generation may use it, and the diff
shows the author a positional selector they can improve by hand.

**Positional path, but the step is data-driven.** "Click the row for
{{customer}}" resolved to row 42 because this run's data said Smith. Generation
must not pin `nth-of-type(42)`; it builds the locator from
`step.getVar('customer')`. The measurement supplies the evidence; the step text
supplies the intent.

**Wait times out — zero elements.** Not a measurement outcome at all. The
hoisted `waitFor` throws exactly as the action's own wait would have, the
existing catch computes `matchCount: 0`, and the sub-action is recorded **with
an error** — so `actionsOf` filters it out and it never reaches generation.
Correct: there is nothing to compile from an action that did not happen. The
retry loop tells the AI "0 elements matched", it re-plans against a fresh
snapshot, and if a later turn succeeds *that* action carries the measurement.
The code-behind is written from what worked, never from the false start.

**Element detaches between the wait and the measure.** A re-render in the gap.
Record nothing, let the click do its own wait, carry on. Never record a zero.

**Measurement throws** — mangled selector, cross-origin frame, CSP blocking
`evaluate`, the page closing. Swallowed. `targeting` is absent, the action
behaves exactly as it does today, and generation falls back to today's
inference. **Measurement is strictly additive telemetry and can never fail an
action.** The worst case is that we are back to current behaviour; no new
failure mode enters the runtime. Note an invalid selector will fail the action
moments later regardless, and the existing failure path reports it properly —
nothing is lost.

**Plural actions.** `read multiple` and `count` record `matchCount` as useful
context for generating the loop, no `resolvedSelector` (there is no single
element), and are never gated by `ambiguousTarget`.

### After Apply, on the next run

**Entry passes.** `</>`, about a second, no model call. Proven. The sidecar
clears.

**Entry throws.** Heals under AI, run goes green, step marked ⚠ stale, sidecar
and recording written. The run's own outcome says a step healed, so CI can fail
the build on it if that is the policy. The author has everything needed to
repair without touching the browser.

**Entry throws under `codeBehindStrict`** — compile's own replay rounds. Red
step, no AI fallback, by design: the point of a replay is to find out whether
the code works on its own, so a broken entry must read as a red step rather than
a slow one.

**A `step.expect` fails.** Unchanged, and deliberately not healed: broken code
heals, a failed assertion fails. That is the assertion-code-cache rule and this
story does not touch it.

### When an entry breaks

**Repair it while parked there.** The session is paused or mid-run at the step
that just healed. Click ⚠ → **Repair this step**. The step re-runs in the live
session, `priorFailure` supplies what the entry threw, and generation goes
through the repair prompt rather than a plain one. One-entry diff, Apply. The
repaired entry is unproven; the next run proves it.

**Repair after the run finished.** The browser is at the end state rather than
the step's starting page, so a per-step re-run executes against the wrong page
and the step fails — plainly, the way any step run from the wrong page fails.
The framework does not detect this and does not steer: it has no way to know
where the session is parked, and guessing would be worse than the honest
failure. The author's move is Run & Compile, whose default selection already
includes stale steps, so the whole test replays and every ⚠ regenerates through
the repair prompt in one pass.

**Repair still fails.** The next run flags it stale again with a new error. A
second repair sees the new failure and the entry it replaced. After the
configured number of attempts the step is written off as `ai: true` with the
last error as its comment — the existing write-off path, unchanged.

**The application genuinely changed.** The login link was removed, not moved. No
repair can invent it: generation declines with a reason, the step stays AI, and
the author is told plainly. This is the case where healing was hiding a real
signal, and the run-level healed outcome is what surfaces it.

**A step heals on every run, indefinitely.** The ⚠ carries its run count —
"healed under AI (12 runs in a row)" — so the history does the escalating with
no threshold to tune. The cost
is real and currently invisible: every run re-executes the broken entry,
re-throws, re-heals, and pays a full AI turn — the zero-token replay the author
compiled for, silently lost.

**Author never repairs.** Nothing breaks. The test keeps passing under AI at AI
speed and cost. Correctness is never traded for the loop; only latency and
tokens are.

## Non-goals

- **Making the DOM snapshot faithful.** It is lossy on purpose — it is a token
  budget paid every turn. Feeding the model more DOM so it can count better is
  strictly worse than counting.
- **Auto-rewriting `.steps.ts` during an ordinary run.** Offered, never
  performed. An explicit `--auto-repair` is a later question, not this story.
- **Gating actions on the measurement.** Never. Playwright's auto-wait is
  load-bearing and the measurement is advisory.
- **Full strict-mode parity in the AI runtime.** `ambiguousTarget: 'fail'` gates
  on visible matches, not all matches, and the reasoning is in Design. A third
  `'strict'` mode gating on `matchCount` was considered and declined: it would
  fail the hidden-duplicate case, which is the one the measurement already
  fixes without failing anything.
- **Repairing from the on-disk recording.** Declined on principle, not cost — a
  repair should be generated from a live page, not a snapshot of one.
  `readRecording` stays without a production consumer.
- **A page-precondition gate on Repair.** The framework cannot check it by
  inspection, and the provenance that would answer it is not tracked. Repair
  follows `runStepHere`: run, and let a wrong page fail the step.
- **CLI `aiui compile --repair`.** Deferred; the gutter action and Run & Compile
  cover both moments.
- **Retiring rule 8 or the repair prompt.** Both stay; they now key off facts.
- **Changing the boxed compile's replay rounds.** They already prove entries
  empirically and are untouched.

## Acceptance

- A click whose selector matches 2 elements, 1 visible, records `matchCount: 2,
  visibleMatchCount: 1` and a verified `resolvedSelector`; the generated entry
  uses the resolved handle and passes on first replay.
- The verified handle is genuinely unique: `strongSelector` and `buildSelector`
  fall through a candidate that `querySelectorAll` shows is not, rather than
  returning it.
- A selector matching only a hidden duplicate off the end of a truncated
  snapshot still records `matchCount: 2` — the measurement does not read the
  snapshot.
- A step whose element renders 400ms after the turn begins records
  `matchCount: 1`, not 0, and its entry is generated normally.
- A wait that times out records the sub-action with an error, contributes no
  `targeting`, and never reaches generation.
- Measurement throwing leaves the action's behaviour byte-identical to today,
  and generation falls back to inference with no error surfaced.
- `read` with `multiple: true` records a count, no `resolvedSelector`, and is
  not gated by `ambiguousTarget: 'fail'`.
- A target whose own attribute handle is not unique but becomes unique when
  scoped to an addressable ancestor resolves to the SCOPED form
  (`#statements a[href="transactions.html"]`), reported as
  `resolvedBy: 'scoped'` — not to a positional chain, which would also verify
  and is the worse answer.
- A target with no unique handle at any scope resolves positionally and is
  reported as `resolvedBy: 'positional'`, so generation can apply the
  data-driven rule without sniffing the selector string.
- With `ambiguousTarget: 'fail'`, a click matching 3 visible elements fails the
  action and the AI re-plans; with `'first'` it proceeds and warns.
- With `'fail'`, a singular `read` matching 1 visible and 2 hidden elements IS
  gated — it gates on the total, because its `.first()` has no visible filter.
  A rule keyed on the visible count would wave this through.
- Generation refuses to emit a bare selector the transcript recorded as
  `matchCount > 1`; the backstop re-asks once and the second entry differs.
- A data-driven step resolving to a positional path generates a
  `step.getVar(...)` locator, not a pinned `nth-of-type`.
- **Repair this step** appears on a ⚠ step, is absent on a `</>` or plain step,
  and reaches the same server path "Compile This Step" already uses.
- Repairing a ⚠ step generates through the repair prompt, not the plain one:
  the model is shown the entry that failed and its error.
- Repair does not gate on page state — invoked with the session on the wrong
  page, the step fails the way `runStepHere` would, with no special refusal.
- A run that healed any step sets `healedSteps` on `TestReport`, renders the
  amber banner with the count and the tokens those steps cost, and leaves
  `status` as `'passed'`.
- `leadingPassed` still counts a healed step as passed, so a compile's prefix is
  unaffected by healing.
- `--fail-on-healed` turns a healed run into a non-zero exit; without it the
  exit code is unchanged from today.
- TestBench's run summary names the healed count and its token cost; a run with
  no healed steps says nothing new.
- A step stale on three consecutive runs shows "3 runs in a row" on its ⚠, and
  the count resets when the step passes as code.
- A repaired entry that fails again is repaired a second time from the new
  failure, and written off as `ai: true` after the configured attempts.
- An entry for an element the application has removed declines with a reason
  rather than inventing a selector.
- `browser.ambiguousTarget` is honoured on the server and TestBench paths, not
  only the CLI.
- Secrets: `resolvedSelector` goes through the same recording redaction as every
  other recorded string — asserted by a recording whose `aria-label` carries a
  secret value, which must not survive into the written JSON.
- A hoisted wait plus its action never exceeds the action's own timeout budget:
  a selector that never appears fails in about 10s, not 20s.

## Review round

Read against the code before any implementation, because the area is
load-bearing and two of the changes touch the AI runtime, which currently works.

### Settled

- **Timeout accounting.** Time the hoisted wait, pass the remainder to the
  action. Folded into Design; the reasoning is that a second budget doubles
  failure latency without helping any passing test.
- **`buildSelector` needs a positional fallback** it does not currently have,
  since its last resort is a bare `tag` and there is nothing to fall through to.
  Folded into Design.
- ~~`buildSelector` is not a hot path.~~ **This review finding was wrong** and
  the build caught it: `processChildNodes` is mutually recursive with
  `processElement`, so its `buildSelector` call ran per element, not per
  collapsed run. Kept here rather than deleted because the reasoning that
  produced it — counting call *sites* instead of tracing call *paths* — is the
  mistake worth not repeating. Corrected in Design.
- **Repair already works; it just cannot be found.** "Compile This Step" sends
  `mode: 'steps'`, which is the mode where `priorFailure` reads the sidecar and
  routes through `buildRepairPrompt`. This removed the largest piece of build
  from the story — see Design.
- **Repair-from-recording would have been a new pipeline**, since
  `readRecording` has no production consumer. Moot: the author declined it on
  principle, which also retired the finding below.
- **The leak guard would have been defeated** by sourcing parameters from the
  redacted recording — a guard fed redaction placeholders passes an entry that
  inlines the real secret. Retired with the recording path; a live re-run has
  live parameters by construction. Kept here because it is the reason not to
  revive that design later without solving this first.
- **`targeting` must be merged before `redactDeep`**, which widens `actionsOf`'s
  return type. Corrected in Design.

### Settled by the author

- **The observed failures match the shape designed for** — a selector matching
  twice with the second copy hidden. The design is aimed at real data, not at
  the one case in the commit log.
- **Measurement is compile-only**, with `ambiguousTarget: 'fail'` as the stated
  exception. Folded into Design, along with what the gate costs.
- **No third `'strict'` mode** for `ambiguousTarget`. In Non-goals with the
  reasoning.
- **No repairing from recordings**, and no CLI `--repair` yet. Both in Non-goals;
  the repair section is rewritten around the live path that already exists.
- **A healed run must be visible in the report**, cost included. Designed
  against the `aborted` precedent rather than a new status value.
- **Recording staleness is out of scope** — and moot now that repairs generate
  from a live page.
- **One PR, not two.** Measurement and the repair/reporting half are
  independent and could have shipped separately; they land together.

Nothing is open. Ready to build.

### Implementation note, not a decision

A new key under `browser` consumed at session-creation time must go through
`resolveProjectBundle` ([project-bundle.ts](../src/server/project-bundle.ts))
rather than startup config, or it is silently ignored on exactly the paths that
matter.

**That is necessary and not sufficient — the build found a second drop point.**
`resolveRunSettings` ([run-settings.ts](../src/config/run-settings.ts)) builds
the `Config` the executor is handed by spreading the *server's* startup config
and re-sourcing only a named handful of values from the project. Anything not
named there keeps the server's answer no matter what the project's
`aiui.config.json` says — so a key can be correct on `ProjectBundle`, correct
under the CLI, and silently server-global on the server and TestBench paths,
which are the ones anybody actually uses. `browser.ambiguousTarget` is named in
both places, and the list in run-settings has a comment saying why it has to
grow by hand.

### Found nearby, out of scope

`executeWait`'s selector case does not share the tolerance the other actions
have. Where click and type do `root.locator(sel).locator('visible=true')
.first()`, the frame branch of `executeWait` does
`root.locator(sel).first().waitFor({ state: 'visible' })` — `.first()` on the
*raw* locator. A hidden first match therefore pins the wait to an element that
will never become visible, and it times out even though a visible second match
is sitting right there. Same family as this story, pre-existing, and it deserves
its own issue rather than widening this one.

## What was built

Everything above. Where the build deviated from the spec, and why:

**The spec's `resolvedSelector` rule was wrong for its own headline case.** It
said the element's own attribute handle, null when none is unique — and in the
hidden-duplicate failure the visible link has no unique handle *precisely
because* the duplicate exists, so the rule returned null for the one case the
story is about. Fixed by adding the scoped tier and `resolvedBy`; the measured
comparison is in Design. This is the deviation that mattered most, and it was
found by building the thing rather than by reading it.

**`buildSelector` was on the per-element path after all.** The review round
counted call *sites* and concluded the uniqueness check was cheap. It should
have traced call *paths*: `processChildNodes` is mutually recursive with
`processElement`. Building `parentSel` lazily makes it once per collapsed run
for real, and two tests count `querySelectorAll` calls to keep it that way.

**Per-project config had a second drop point.** Reaching `ProjectBundle` is not
enough — `resolveRunSettings` rebuilds the executor's `Config` from the server's
startup config. Detail in the implementation note.

**Per-step token attribution did not exist.** `AiInteraction` carries no token
counts and the tracker keeps only run-wide totals, so the healed-run cost is a
snapshot/delta around each step's dispatch. Steps run one at a time, so the
window is clean — except on a Run & Compile, where the background generation
queue can call the model inside a step's window and inflate that step's share.
Noted in the code. `healedTokens` is a second field beside `healedSteps`;
absent means *not attributed*, never zero.

**Plural actions carry `matchCount` too**, which makes the singular filter
load-bearing rather than defensive. Without it a `read multiple` matching three
elements would be told its selector was "NOT usable as written" and then refused
by the backstop — on the one action where many matches is the entire point. One
shared `isSingularTarget` feeds both the rule builder and the backstop. The
Design section did not anticipate this.

**The backstop lives in `generate.ts`, not `writer.ts`.** `validateCodeBehindSource`
is the right precedent and the wrong home: the writer is transcript-unaware, and
the re-ask has to happen where the model call and the guarded values are. Two
judgement calls inside it, both about not letting a textual heuristic do more
damage than the bug it catches — a second failure keeps the second entry and
warns rather than erroring, because `compile.ts` turns a generation error into a
failed compile that discards every *other* step's work; and a re-ask that
errors or declines falls back to the first answer, which had already passed the
leak guard, so a flaky second call cannot lose a good entry.

**The backstop covers generation only.** Repairs call `askForEntry` with
`buildRepairPrompt`, which carries the failing code and its error but not the
transcript — so there is no measurement there to check against. Arguably fine:
a repair is already looking at "resolved to 2 elements" in the error text, which
is more direct than a count. `ambiguousSelectorComplaint` is exported if that
changes.

**Singular `read` waits for attachment, not visibility**, so `visibleMatchCount`
can be legitimately absent rather than zero. This is preserved behaviour, not
new: the original `executeRead` was already `.first()` on the raw locator with
Playwright's implicit 30s default, and `READ_TIMEOUT_MS` matches it exactly.

**One Playwright trap worth recording.** `locator.evaluate` reads a lone options
object as the page function's *argument*, so the measurement call has to pass
`undefined` explicitly to get its 2s cap. Without that it inherits the 30s
default — and an element that detached in the gap would spend all thirty of
them inside a call that exists only to gather telemetry.
