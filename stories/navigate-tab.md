# Sending a tab somewhere, without a model in the loop

## In plain terms

*"Open openrouter and take a screenshot"* works today. It takes four calls and
about eleven seconds, and eight of those seconds are a language model deciding
how to type a URL into a browser.

Measured on 2026-08-18, end to end through the shipped tools:

| Call | Time | What it did |
| --- | --- | --- |
| `start_cdp_browser` | 2.5s | launched Chrome — nothing was running |
| `list_cdp_browsers` | 0.1s | found one tab, `chrome://newtab/` |
| `run_errand` — *"go to https://openrouter.ai"* | **8.0s** | an AI turn, on a real model, to navigate |
| `peek_tab` `format: "screenshot"` | 0.6s | the picture |

The errand is doing a language model's job on a task that has no language in
it. Worse, it cannot open anything: its own argument says *"There is no `new`:
an errand borrows a tab that is already open."* So *"open openrouter"* is really
*"repurpose one of your tabs"* — which was free in that measurement, because the
only tab was a blank new-tab page, and would not be free against the browser you
actually work in.

This story adds one verb: **`navigate_tab`**, which points a tab at a URL with no
model, no session and no run. Its default opens a *new* tab, because that is what
"open openrouter" almost always means, and because it is the only version of
this verb that destroys nothing.

### What it looks like in practice

**You say:** *"Open openrouter"*
**You get:** a new tab at openrouter.ai, in under a second, and every tab you
already had is exactly as you left it.

**You say:** *"Open openrouter and show me"*
**You get:** the same, then a `peek_tab` screenshot. Two deterministic calls,
no AI turn.

**You say:** *"Send the docs tab to the pricing page"*
**You get:** that specific tab navigated — after you named it by `targetId`,
because this is the half that overwrites something.

**You say:** *"Navigate to openrouter in the current tab"*
**You get:** a refusal listing your open tabs, asking which one. "Current" is
not a thing this framework can resolve, and §Locked explains why it must not
pretend otherwise.

> **Verification rule for this story.** "Done" means: (1) `navigate_tab` with a
> URL and no target opens a **new** tab and leaves every existing tab's url
> untouched, proven by comparing the full tab listing before and after; (2)
> `navigate_tab` with an exact `target_id` navigates **that** tab and no other;
> (3) a `target_id` that names a tab a session or an errand is driving is
> **refused**, naming the holder — asserted against a live errand hold, not a
> mocked lock; (4) no name-matching reaches the replace path: a `title~`,
> `url~`, bare substring, `active` or `current` value is refused with the open
> tabs listed, and the refusal is the tool's own builder; (5) a non-`http(s)`
> scheme is refused before the browser is touched, `javascript:` and `file:`
> among them; (6) a foreign browser is unreachable, by the same no-`port`
> construction the peek uses; (7) the result names the url, title and
> `targetId` the tab actually landed on **alongside the `requestedUrl` that was
> asked for**, so a redirect — a login bounce above all — is a fact in the
> result rather than an inference; a navigation whose `domcontentloaded` wait
> times out still **succeeds**, carrying a warning that says the page had not
> finished loading and what that means for reading it, in the `warnings` array
> **and** in the summary line; and (8)
> the whole thing costs **no AI turn and no session**: `list_sessions` is
> identical before and after, and no report file is written.

## What was measured, so nobody re-derives it

Everything below is read out of the current tree or observed in the run above.

- **`run_errand` cannot open a tab.** Its `tab` argument is required and its
  description says so outright. `keep_open` refers to tabs an errand's *steps*
  opened, not to the borrowed one.
- **`parseCdpTabSpec` already accepts `active`** — and resolves it as *"best
  effort: pick the first non-DevTools page"*, with a comment in
  `src/browser/manager.ts` conceding that real most-recently-focused detection
  "requires CDP `Target.getTargets`, which we can wire later". **The name
  already promises more than the code delivers.** That is tolerable for a
  `cdpTab: active` a human typed into a test config; it is not tolerable behind
  a write verb an agent reaches for after hearing "the current tab".
- **Nothing in the CDP listing marks the frontmost tab.** `document.visibility
  State` is the honest signal, and it needs an attach per tab to read, reports
  `hidden` for every tab of a minimized window, and reports `visible` for one
  tab in *each* open window. There is no single answer to return.
- **`close_cdp_tab` and `focus_cdp_tab` both take an exact `targetId`**, in
  those words, while `peek_tab` and `run_errand` take names. The line the
  codebase already draws is destructive-versus-not, and it is the line this
  verb inherits.
- **The lock and the join already exist.** `ErrandLocks.holder(port, targetId)`
  answers "who is driving this tab" synchronously, and `GET /cdp/browsers`
  already joins a `sessionId` onto every owned tab. The refusal in item (3)
  needs no new bookkeeping.
- **`CdpLaunchOptions.activate` gates the existing-tab arm only.** Its own
  comment: *"The `new`-tab arm opens a window that has to appear somewhere, and
  no caller has asked not to see it."* A new tab being visible is correct here —
  you asked for something to be opened — and is the one respect in which this
  verb is louder than the peek.

## The tool

```
navigate_tab {
  url: "https://openrouter.ai",   // http/https only
  target_id: "A9C5209971833..."   // OMIT to open a new tab; exact id to replace one
  profile: "default",             // plus engine/scope, exactly as peek_tab
  scope: "user"
}
```

Addressing the *browser* is `peek_tab`'s, unchanged — `resolveCdpTarget` for
profile/engine/scope, no `port`, so only a registry-owned browser is reachable.
Addressing the *tab* is `close_cdp_tab`'s: an exact `targetId` or nothing at all.

The result is the `requestedUrl`, the `url` and `title` the tab ended on, its
`targetId`, and the `warnings` array its CDP siblings already carry. No picture:
composing with `peek_tab` is the point, and a verb that both writes and
photographs is two decisions welded together.

## Routing: the fourth door

[tab-peek](tab-peek.md) §Routing sells three doors, one question each. This adds
a fourth, and it splits the door that was already the least comfortable:

1. **Reading a tab** — text or picture — `peek_tab`.
2. **Reading a session's page** — `get_page_content`.
3. **Pointing a tab at a URL** — `navigate_tab`. No language, no model.
4. **Acting in a tab** — clicking, typing, filling, anything that needs
   judgement about what is on the page — `run_errand`.

The test between 3 and 4 is whether the instruction contains a *decision*.
"Go to openrouter.ai" contains none. "Find the pricing page and open it" does,
and stays an errand. **Named amendment to [errands](errands.md) §Routing 2**,
whose read/act split becomes read / navigate / act; `run_errand`'s description
gains the pointer, and its "steps can also capture" sentence is untouched.

## Locked decisions

- **A new tab is the default; replacing one is the explicit case.** This inverts
  the risk of every other shape considered. The dangerous mode — overwriting a
  page that may hold unsaved work — cannot be reached by omitting an argument,
  only by naming a tab exactly. It is also what users mean: "open openrouter" is
  an instruction to *open*, and the measurement above only looked harmless
  because the borrowed tab happened to be blank.

- **Exact `targetId` on the replace path. No name matching, no `active`, no
  `current`.** [tab-peek](tab-peek.md) §Tool surface amended cdp-tabs §Locked to
  let a *non-destructive* verb take names, on the grounds that its zero-or-
  several refusals name candidates instead of guessing. That reasoning does not
  reach here: a peek that reads the wrong tab wastes a call, and a navigate that
  overwrites the wrong tab destroys something with no undo. This verb sits with
  `close_cdp_tab`, and the amendment is explicitly **not** extended to it.

- **"The current tab" is refused, not approximated.** It is the most dangerous
  possible instruction for this verb precisely because it sounds precise: the
  tab you are looking at is the one most likely to hold something worth keeping.
  There is no signal that resolves it (see §Measured), and the `active` spec that
  looks like one is a first-non-DevTools guess wearing a better name. The
  refusal lists the open tabs, turning a guess into one clarification.

- **Refused while a session or an errand holds the tab.** The exact opposite of
  the peek, and deliberately so: [tab-peek](tab-peek.md) item (4) lets reads
  coexist with drivers because watching a run is a good reason to look. A
  navigation mid-run yanks the page out from under the driver and corrupts it.
  Same guard `close_cdp_tab` already applies, same holder message.

- **`http` and `https` only — and plain `http` is allowed, not warned.**
  `javascript:` is code execution in a signed-in browser, `file:` is local disk,
  `chrome:` is settings; none of them are what anyone means by "open". Cleartext
  `http` stays permitted and silent: plenty of internal tools are only reachable
  that way, and a warning nobody can act on is noise on every single call.

- **A tab this verb opens is permanent.** There is no `keep_open`, and nothing
  is cleaned up when the call returns, the conversation ends, or the server
  stops. You asked for a tab; a tab that disappears on its own is worse than one
  you close deliberately. Closing is `close_cdp_tab`, when a person asks for it.

- **Settled means `domcontentloaded`, and a timeout is a warning rather than a
  failure or a flag.** Every navigation in this codebase already waits on
  `domcontentloaded` with a 30s bound — `browser/actions.ts`,
  `runner/step-executor.ts`, `runner/test-runner.ts`, `server/session-manager.ts`
  and `api/csrf-handler.ts`, unanimously — so this verb settling anywhere else
  would mean `navigate_tab` and a `go to X` step disagree about when a page has
  arrived. `networkidle` is excluded outright: Playwright discourages it, and on
  any page with polling, websockets or analytics it either never fires or fires
  arbitrarily. No `wait_until` knob: exposing one mostly invites `networkidle`.

  **When the wait times out the call still succeeds** — the navigation happened
  and the tab moved, so refusing would misreport it and leave a tab somewhere
  the caller does not know about. It comes back with a **warning**, in the
  `warnings` array every CDP verb here already carries (`close_cdp_tab`,
  `focus_cdp_tab` and the browser listing all declare one) and in the summary
  line, because hosts render one half or the other.

  A warning rather than a `settled: false` field, and the difference is what it
  can say. The boolean states a fact and leaves the reader to infer the
  consequence; the prose names it — *the page had not finished loading after
  30s, so reading it now may show a partial page or miss elements that have not
  arrived yet.* That is the sentence an agent needs, and no schema field
  delivers it. It also only exists when it matters: a `settled: true` on every
  ordinary call is a field that is always the same value and therefore never
  read. Bear in mind that at `domcontentloaded` this is a strong signal, not a
  slow image — DCL does not wait for images, so thirty seconds means the
  document itself never finished parsing.

- **The result reports where you asked to go AND where you landed.** Both
  `requestedUrl` and `url`, always, so a redirect is a visible fact rather than
  something inferred by comparing against the argument. This is the cheapest way
  to surface the case that matters most in a signed-in browser: asking for a
  page and arriving at a login screen. A client-side redirect can still move the
  page after the call returns — `peek_tab` carries the same caveat, and neither
  verb pretends otherwise.

- **A page that moves while we read it gets a retry, then a warning — and the
  warning is about the URL, not the title.** `readPageIdentity` assigns `url`
  first and then awaits `page.title()`, so a title that throws leaves a url read
  a moment EARLIER: on a client-side redirect you get the pre-redirect url
  paired with an empty title. The empty title is only the tripwire; the fact
  worth reporting is that the identity as a whole may describe where the tab
  **was**.

  So the helper retries the read once after `NAVIGATION_RETRY_DELAY_MS` — the
  same 500ms `capturePageContent` already spends on a content read that lost to
  a navigation. Most of the time that ends it: the second read lands on the new
  page and there is nothing to warn about. Only if it fails twice does
  `navigate_tab` warn that the reported url and title may be the previous page's.
  Never an error: the navigation happened, and refusing would misreport it.

  `readPageIdentity` stays **shared and best-effort**, with no mode and no
  second copy. It returns one more fact — whether the read failed — and each
  caller decides what to make of it; the peek ignores it and its contract is
  unchanged. That is deliberately not the choice this story first framed
  ("duplicate it or give it a mode"), because both of those were worse than
  simply returning what is known. The retry improves the peek too, in the same
  failure case, which is an argument for the sharing rather than against it.

- **Ownership by construction, not by a gate.** No `port` argument, so only a
  profile-resolved browser is addressable and mcp-cdp-browser §6's
  `allowUnowned` is unreachable — the peek's posture, for a verb that does more
  than read.

- **Provenance is a behavioural guard, and this story says so plainly.** A URL
  that came out of a page the agent just read is not automatically safe to open
  in a browser holding real logins, and the server cannot tell where a URL came
  from — it sees a string. This lives in the tool description and in the agent
  pausing to confirm; pretending it is enforced would be worse than admitting it
  is not.

## What already exists vs what is new

Reused unchanged: `resolveCdpTarget` and its ambiguity refusals; the
`activate: false` attach and the disconnect-not-kill detach the peek route uses;
`ErrandLocks.holder`; the tab→session join on the browser listing; the
JSON-envelope-versus-bare 404 split; the `warnings` array its CDP siblings
already declare.

Changed, once, and shared: `readPageIdentity` gains a single retry on a failed
read (`NAVIGATION_RETRY_DELAY_MS`, the constant `capturePageContent` already
uses) and reports whether the read ultimately failed. Both callers keep their
existing behaviour — the peek ignores the new fact — so `tests/mcp-peek-*` should
need no changes beyond the ones that assert the retry itself.

New: the tool and its schema; a route that navigates rather than captures; the
new-tab arm (`parseCdpTabSpec`'s `new` already exists and `launchBrowser`
already honours it); the scheme check; and one refusal builder per locked
decision above.

## Not in this story

- **Clicking, typing, filling.** That is `run_errand`, and the line is whether
  the instruction contains a decision.
- **Back, forward, reload.** Same class of verb, and each wants its own thought
  about what "the same page again" means for a form.
- **Waiting for a condition.** The result settles the navigation and reports
  where it landed; anything more specific is a step, and steps are errands.
- **Closing tabs.** `close_cdp_tab` already does that, exactly as strictly.

## What the live proof showed

Run 2026-08-18 against real headed Chrome under a throwaway `navproof` profile
in the user root, driving the built MCP server over stdio with no project.

| Rule | Result |
| --- | --- |
| (1) new tab by default | opened in **0.7s**; the pre-existing tab still at `chrome://newtab/`, untouched |
| (2) exact `target_id` | that tab moved to `example.org` in 0.5s; the other did not |
| (4) names refused | `current`, `example`, `title~Example` all refused in **0.0s**, before any browser work — and `current` got its own reason |
| (5) schemes | `javascript:` and `file:` refused; a bare `openrouter.ai` refused naming the missing scheme; plain `http://` allowed with no warning |
| (7) redirect visible | asked for `http://github.com/`, `url` came back `https://github.com/` with the title — the upgrade reported as a fact |
| (8) no session, no model | `list_sessions` still 0 after seven navigations |
| compose | `peek_tab` on the tab this opened read it back, 129 chars, still no AI turn |

**One defect, and only the live run could have found it.** The first pass opened
a tab, navigated it, reported success — and the tab was *gone* by the next
listing. `closeBrowser` closes a tab the attach itself opened, which is correct
for a run (a test should take its coat when it leaves) and exactly wrong here,
where opening the tab **is** the deliverable. The route now disowns it before
detaching.

The suite could not have caught that as written, because its `closeBrowser` mock
only recorded the call. The mock now models the one clause that matters — it
closes the page when `cdpTabOpenedByUs` — and the test was checked by reverting
the fix and watching it fail. A mock that is faithful only where nothing depends
on it is how a live-only defect stays live-only.

## Open questions

None outstanding. The last one — what an unreadable title should mean — is
settled in §Locked above, and the reasoning is worth keeping because the
question was mis-framed twice before it was answered.
