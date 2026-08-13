# Tab peek — read a tab the user has open, changing nothing

> **Verification rule for this story.** "Done" means: (1) `peek_tab` naming
> a tab by title returns that tab's visible text with its `url`, `title`,
> `targetId`, and the truncation facts — `list_sessions` is identical
> before and after, the project's report directory gains no file, and the
> peek adds nothing to `runsInFlight`: read from `/health` at the
> api-server harness while the peek's extraction is held open, and equal
> to the count taken immediately before (a peek is a read, not a run);
> (2) `format: "dom"` returns the cleaned DOM under the PROJECT's
> noise-reduction, iframe-depth and char-limit settings — not the library
> defaults, which differ (100k vs 300k clip) — `selector` narrows either
> format to one element, and `max_chars` clips with `truncated: true`,
> including the silent-clip trap [page-content](page-content.md) §3
> records: a page clipped by the project's `domSnapshotCharLimit` before
> this layer sees it still reports `truncated: true`; (3) a `tab`
> matching nothing refuses listing the browser's open tabs, one matching
> two refuses naming both candidates, the candidate set is only ever the
> page-type-filtered listing, and the matcher is the shared
> `matchTabsByName` — pinned the way errands pins it: each tool's
> refusals are asserted against its own exported builder, and the two
> tools' builders are asserted to be fed the same candidate list — and
> the zero/gone refusal is scoped to a JSON-envelope 404: a bare
> non-JSON 404 means the server predates the route and says "rebuild",
> never "your tab is gone" ([cdp-tab-focus](cdp-tab-focus.md) §6's
> locked split, via `ApiRouteNotFoundError` and a peek route-missing
> builder beside `cdpFocusRouteMissing`); (4) a
> peek proceeds while an errand or a session batch is driving that same
> tab — reads coexist with drivers (the two-client evidence
> [errands](errands.md) §The wheel measured on 2026-08-12, reconciled
> with the dialog-guard overlap in §Detach) — INCLUDING when the driver
> is a FOREIGN session (a non-`mcp:` id bound to that tab at the
> real-app harness): the peek succeeds, which is §Disclosure posture's
> amendment asserted rather than argued — and a peek never takes,
> checks, or blocks the turn lock in either direction;
> (5) a peek never raises the tab: the shared attach's raise is
> parameterised off, asserted in `tests/browser-manager-focus.test.ts` —
> the ONLY suite that mocks `playwright` itself and can see the
> attach-path call; a mocked-manager harness cannot fail on this and
> must not claim it — and no navigation, no click, no tab opened or
> closed, and a detach that severs the socket only; (6) `peek_tab`
> passing a NON-EMPTY `session_id` is refused before any browser work
> naming `get_page_content` as the door for sessions, and an
> empty/whitespace `session_id` is treated as absent (the serializer
> reality [errands](errands.md) item (6) records); (7)
> `get_page_content`'s session-404 redirect and its description now name
> `peek_tab` for the read-a-tab case — the errand-capture sentence is
> demoted to the drive-then-read case, not deleted — with
> `tests/mcp-seam.test.ts`'s redirect pins updated alongside; and
> `peek_tab`'s own description carries the three-door rule (read a tab →
> here; drive a tab → `run_errand`; read a session's page →
> `get_page_content`); and the §Routing 3 amendment is pinned too:
> `run_errand`'s description gains the read/act split — the existing
> pin on the unsplit rule in `tests/mcp-errands-seam.test.ts` (~:304)
> moves WITH it — and the `CDP_NOTE` clause is phrased to be true of
> both run tools that ship it, neither of which can peek; (8) a live
> pass reads a real signed-in tab
> through the real chain and finds a string known to be on it. A vitest
> suite drives (1)-(7) through the harnesses the errands story
> established — the real in-memory MCP client + real API server for the
> tool surface and refusals; the raw-HTTP api-server harness for item
> (1)'s in-flight clause and the route's error contract; the
> playwright-mocked browser-manager suite for item (5)'s no-raise — and
> (8) runs live.

## Context

The first live day of [errands](errands.md) produced this story. A user
whose agent had just driven their tab asked the obvious next question —
*"what's the contents of this tab?"* — and there was no door for it. The
agent reached for `get_page_content`, which reads a **session's** page;
an errand leaves no session, so the server answered 404, and the fix that
shipped (PR #50) could only redirect to a workaround: run another errand
whose steps capture what you need.

The workaround is real but wrong-shaped for the question. An errand's
`read …, store as …` steps are element-level reads chosen by the AI
resolver — good for "read the balance", lossy for "what does this page
say". And an errand brings machinery a read does not need: the per-tab
turn lock exists because two *drivers* interleave inputs and race
dialogs, the receipt exists because *actions* need accounting, steps
exist because *driving* is a sequence. A read mutates nothing, races
nothing (concurrent CDP *clients* on one tab are measured-safe — errands
§The wheel), and wants exactly one thing: the faithful extraction
`get_page_content` already performs, pointed at a tab instead of a
session.

So the peek is the third door, completing the set:

|                    | `get_page_content`      | `run_errand`           | `peek_tab`             |
| ------------------ | ----------------------- | ---------------------- | ---------------------- |
| Addresses          | a session               | a user's tab           | a user's tab           |
| Does               | reads                   | drives                 | reads                  |
| Leaves behind      | the session (unchanged) | nothing                | nothing                |
| Takes the lock     | no                      | yes                    | no                     |
| Raises the tab     | no                      | yes, on hand-back      | no                     |

## The concept, precisely

A peek is: **attach → extract → detach**, in one request.

- **Attach.** The same two stages as the errand, MCP-side: resolve the
  browser (`resolveCdpTarget`, profile + engine + scope, the ambiguity
  refusals reused as-is; the peek takes no `port`, so the ownership gate
  is settled by construction — a profile-resolved browser is
  registry-owned, and a foreign browser is unreachable), then match the
  `tab` argument against the page-type-filtered listing with the shared
  `matchTabsByName` — exactly-one proceeds, zero refuses listing the
  open tabs, several refuse naming candidates. The server-side attach is
  the same call `ErrandRunner.drive` makes — `launchBrowser` with a
  `cdp` block and an exact `targetId:` spec — **with one parameterised
  difference**: the attach path's existing-tab arm raises the tab today
  (`page.bringToFront()`, the courtesy [cdp-tab-focus](cdp-tab-focus.md)
  §3 shipped on purpose), and a read must not. `CdpLaunchOptions` gains
  an `activate?: boolean` (default true — `run_errand` and `run_steps`
  are untouched), and the peek passes `activate: false`. **This is a
  named, bounded amendment to [cdp-tab-focus](cdp-tab-focus.md) §3**:
  its rationale is a run about to drive behind the tab you are looking
  at; a peek drives nothing and shows nothing, so raising would only
  interrupt whatever the user was actually doing.
- **Extract.** The same reads `get_page_content` performs, through a
  seam this story creates so the sharing is real: a page-level
  `capturePageContent(page, browserConfig, opts)` extracted from
  `SessionManager.getPageContent`/`capturePage` — carrying the
  navigation-retry arm, the whole-code-point slice, and the
  `truncated = captureClipped || available > maxChars` derivation —
  with `getPageContent` re-pointed at it, so session reads and peeks
  cannot drift. `captureVisibleText` for `format: "text"` (default),
  `captureDomSnapshot` for `format: "dom"`, `expandDomSubtree` under a
  `selector`. The settings come from the project, by the same device
  the errand uses and for the same reason: the request carries a
  synthetic `testFilePath` (`<root>/.aiui-peek.md`) — the only thing
  the server resolves a project root from — and the handler feeds
  `bundle.config.browser` to both `launchBrowser` and the capture.
  Without it the capture would silently run under library defaults
  that differ from the project's (a 100k clip against the configured
  300k, different noise reduction), and item (2)'s agreement with
  `get_page_content` would be false.
- **Detach.** Disconnect; nothing was opened, so nothing closes, and
  the socket-severing semantics are the shipped `closeBrowser` ones.
  Two attach side effects are named rather than hidden. First, the tab
  is NOT raised (the `activate: false` arm above). Second, the dialog
  guard: the shared attach installs it on the user's context before any
  tab is touched, and for the life of the connection it answers
  `alert`/`confirm`/`prompt`/`beforeunload` on ANY tab in that browser
  — inherited from the errand, unavoidable (the guard is load-bearing),
  and the reason a peek's connection is held for as short a time as the
  extraction takes. This is also where item (4)'s coexistence evidence
  needs its reconciliation, because "both clients handling the same
  dialog" is a hazard errands §The wheel names: when a peek's guard and
  a concurrent driver's guard race, both carry the identical
  disposition (accept `beforeunload`, dismiss the rest) and each
  swallows the loser's already-handled rejection — so a stolen dialog
  is answered exactly as it would have been, and the race has no
  observable outcome. The `dialogGuarded` WeakSet cannot dedupe across
  two connections (it keys on each process's own context object), and
  does not need to. The response carries `content`, `format`,
  `selector`, `truncated`, `returnedChars`, `availableChars`, the tab's
  `url`, `title` and `targetId`, and the `root` + `scope` the peek's
  settings resolved against (the errand-receipt precedent —
  [mcp-no-project](mcp-no-project.md): every result says which root it
  used); when a project-scope call reads a user-root browser, the
  summary line says so, the way `close_cdp_tab`'s does. The response
  carries NO `status` and NO `sessionId` — its output schema is
  `get_page_content`'s minus those two, plus `targetId`, `root` and
  `scope`; whether another driver was on the tab is that driver's
  receipt to tell.

### No lock, in either direction

A peek never takes the errand turn lock, never consults it, and never
blocks on it — and nothing blocks on a peek. This is not an oversight to
fix later: the lock exists for *drivers* (interleaved input, dialog
races, page-global emulation), and the coexistence of a second passive
*client* is the measured-safe case errands §The wheel documents. A peek
during a mid-run errand may see a page mid-change; the honest answer to
"what was on it when you looked" is the extraction plus the `url`/`title`
read at extraction time, and the response shape carries no run `status`
to lie with.

### Disclosure posture

Page content is the most sensitive thing this server hands out —
[page-content](page-content.md) §Locked gates foreign SESSIONS for
exactly that reason. A peek addresses no session, so that gate has
nothing to hold; what bounds a peek is browser ownership: profile +
engine + scope addressing can only resolve a registry-owned browser
(the peek takes no `port`, so [mcp-cdp-browser](mcp-cdp-browser.md) §6's
foreign-port gate is unreachable by construction), and an owned browser
is the user's own. A tab that a foreign session happens to be driving
inside an owned browser IS readable by a peek — recorded here as a
**named, bounded amendment to [page-content](page-content.md) §Locked's
side-door reasoning**: the session gate protects the session address
from becoming a disclosure channel; the browser was always the user's
to read, and `list_cdp_browsers` already shows them every tab of it.

## Tool surface

```
peek_tab {
  tab:          string          # required. Same selector language as run_errand:
                                # targetId:<id> (exact), title~<substring>, url~<substring>,
                                # or a bare string matched case-insensitively against
                                # title and url. Zero or several matches refuse.
  format?:      'text'|'dom'    # default 'text' — same semantics as get_page_content
  selector?:    string          # read one element instead of the whole page
  max_chars?:   number          # same default and clipping rules as get_page_content
  profile?:     string          # default "default"; "" normalises to the default
  engine?:      'chrome'|'edge'
  scope?:       'project'|'user'
  project_root?: string
  session_id?:  string          # DECLARED ONLY TO BE REFUSED — non-empty values are
                                # refused naming get_page_content; "" is treated as
                                # absent (errands item (6): serializers auto-fill "")
}
```

Deliberately absent: `steps` (a peek cannot act — wanting both means
`run_errand`, whose steps can capture), `keep_open` (nothing opens),
`format: "screenshot"` (an open question below), and any config bundle.

The `tab` slot is the story's second name-taking tab argument, and that
is its own **named amendment to [cdp-tabs](cdp-tabs.md) §Locked and
[cdp-tab-focus](cdp-tab-focus.md) §Locked** ("the agent matches; the
tool takes an exact `targetId`"), on the class-shaped grounds the errand
amendment supplies: a non-destructive verb whose zero-or-several
refusals name candidates instead of first-match-guessing — the
destructive verb, `close_cdp_tab`, keeps exact-only. The companion edit
lands in errands.md §Routing 3, whose "the errand has the only
first-class tab-name slot" becomes "the errand and the peek are the
only first-class tab-name slots".

The name `peek_tab` carries no `cdp` prefix for the same measured reason
`run_errand` does not, extending that story's named amendment to the
prefix rule ([mcp-cdp-browser](mcp-cdp-browser.md) §5,
[cdp-tabs](cdp-tabs.md) §Locked) on the same falsifiability terms — and
to keep those terms real, **errands verification item (8) is amended by
this story**: the held routing probe offers all THREE tools, scores
read-vs-drive routing alongside tool choice and argument-following, and
tests the peek spellings (`peek_tab` / `read_tab` / `read_cdp_tab`)
next to the errand ones. errands.md §Open questions "Naming" gains the
same widening.

## Routing: three doors, one question each

1. **What are you reading?** A tab you can name → `peek_tab`. The page a
   `run_steps` session is sitting on → `get_page_content`.
2. **Reading or driving?** Only reading → `peek_tab`. Any acting —
   clicking, typing, navigating — → `run_errand`, whose steps can also
   capture (`read the balance, store as balance`) so a drive-then-read
   is ONE errand, not an errand then a peek.
3. **Wrong doors redirect, and the shipped rule gains a clause.**
   [errands](errands.md) §Routing 1's one-question rule sends ownership
   words ("my tab", "the one I have open") to `run_errand` — which
   today routes this story's headline case ("what's on my tab?") to the
   workaround. **Named amendment to errands §Routing 1**: the ownership
   answer splits — theirs to borrow: *reading* → `peek_tab`, *acting* →
   `run_errand` — applied where the rule ships, `run_errand`'s
   description and the shared `CDP_NOTE` (behaviour unchanged, text
   changed). `get_page_content`'s session-404 refusal and description
   gain the `peek_tab` pointer, demoting (not deleting) the
   errand-capture sentence to the drive-then-read case, with the
   `tests/mcp-seam.test.ts` redirect pins updated alongside; and
   `peek_tab`'s `session_id` refusal names `get_page_content`.

## What already exists vs what is new

Reused unchanged: the browser resolution and ambiguity refusals
(`resolveCdpTarget` — pure of tool-specific text via its caller-supplied
refusals); the shared matcher `matchTabsByName` (exported, pure, already
built for a second caller) over the page-type-filtered listing; the
three extraction functions; `closeBrowser`'s disconnect-not-kill; the
empty-optional normalisation; the pre-existing-pages guard and the
dialog guard (disclosed above).

New, each named because round 1 caught them being assumed:

- The `peek_tab` tool and schema. The output schema is a FRESH
  `toolSchema({...})` declaration — the same eleven fields §Detach
  enumerates — NOT an `.omit()/.extend()` of `getPageContentOutput`:
  derivation loses the `.meta({$schema: undefined})` suppression the
  dialect gate requires (`mcp-schema-dialect.test.ts` would fail and
  opencode would reject the output), and would drag in the
  screenshot-only `format` value and field descriptions of a tool that
  refuses screenshots. `format` is declared `text|dom` only.
- `activate?: boolean` on `CdpLaunchOptions` (default true) gating the
  attach path's existing-tab raise; asserted where it can actually fail,
  `tests/browser-manager-focus.test.ts`.
- `capturePageContent(page, browserConfig, opts)` extracted from
  `SessionManager.getPageContent`/`capturePage` (navigation retry,
  whole-code-point slice, `truncated` derivation), with the session path
  re-pointed at it.
- The peek route: **`GET /cdp/browsers/:port/tabs/:targetId/content`**,
  mirroring the close and focus routes' addressing —
  [page-content](page-content.md) §Locked's GET-not-POST reasoning
  applies verbatim (a read, no body, scalar params). Query: `format`,
  `selector`, `max_chars` (the sibling content route's spelling),
  `testFilePath` (the synthetic `<root>/.aiui-peek.md`), `envName?`.
  Error contract: reuses `GET /sessions/:id/content`'s
  `PageCaptureError` mapping (409 `navigated`, 400 for the selector
  family). The gone-tab 404 has a NAMED device: the route pre-checks the
  target with `listPageTabs` the way `focusCdpTab` produces
  `kind: 'not_found'`, mapped by `statusForCdpFailure` to a
  JSON-envelope 404 the MCP side turns into the open-tabs refusal — the
  tab closed while we reached for it. A bare non-JSON 404 is the ROUTE
  missing (`ApiRouteNotFoundError`): a server built before this story,
  answered by a peek route-missing builder beside `cdpFocusRouteMissing`
  saying "rebuild dist/", never "your tab is gone" — the split
  cdp-tab-focus §6 locked and the PR #50 redirect already honours twice.
- The matching `ApiClient` method (one round-trip, no streaming).
- Peek-specific refusal builders in `src/mcp/errors.ts` —
  `peekTabNotFound`, `peekTabAmbiguous`, `peekSessionsAreForGetPageContent`
  — because the errand builders' prose names driving and borrowing
  ("nothing to borrow", "an errand DRIVES the tab") and would lecture a
  read about acting; the sharing that matters (one candidate list, one
  matcher) is pinned per item (3).
- The `get_page_content` description + redirect edits and the
  `run_errand` description + `CDP_NOTE` clause (§Routing 3, pinned per
  item 7). The three errands.md edits this story names — §Routing 3
  exclusivity, §Open questions naming, and the item (8) probe widening
  — are ALREADY APPLIED alongside this draft; nothing in errands.md
  rides with the build.
- The tool inventory, increment-never-assert
  ([cdp-tab-focus](cdp-tab-focus.md) §5's standing rule, as errands
  complied with it): increment every tool-count sentence in
  `mcp-server.md` — §2's "Fourteen tools" (word) and "all 14 schemas"
  (numeral), §Tests' "**14** tools" (numeral), and the by-name
  enumeration's "the seven added since" → eight, gaining `peek_tab` —
  leaving §Tests' "all 14 logger stdout sites" alone (a numeral-grep
  near-miss that is not a tool count); then `usage.ts`, the README
  table, the seam + dialect manifests, and `argumentsFor()`.

The `chrome://extensions` stall (measured 2026-08-13: a wedged
privileged page answers no CDP query, and Playwright's connect
initializes every page target, so the whole browser times out) is
inherited by the peek's attach exactly as by the errand's — this
paragraph is that measurement's record in stories/, and the
probe-and-name diagnostics are separate follow-up work.

## Open questions

- **`format: "screenshot"`.** "Show me the tab" is a real ask, and
  Playwright can screenshot an attached page. Deferred: the return-size
  and privacy questions (`screenshots_return`'s reasoning) deserve their
  own decision rather than a rider on v1.
- **Naming.** `peek_tab` vs `read_tab` vs `read_cdp_tab` — settled by
  the widened probe (errands item (8) as amended above) before anything
  freezes.
- **Leave-focus-alone as a promise.** v1 simply never raises. If a
  future case wants "peek and bring it forward", that is `focus_cdp_tab`
  composed after — two tools, not a flag.
