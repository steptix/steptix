# Tab peek — read a tab the user has open, changing nothing

> **Verification rule for this story.** "Done" means: (1) `peek_tab` naming
> a tab by title returns that tab's visible text with its `url`, `title`,
> and the truncation facts — and `list_sessions` is identical before and
> after, no run is ever in flight (a peek is a read, not a run), and
> nothing of the peek survives on the server; (2) `format: "dom"` returns
> the cleaned DOM, `selector` narrows either format to one element, and
> `max_chars` clips with `truncated: true` — including the silent-clip
> trap [page-content](page-content.md) §2 records: a page clipped by the
> project's `domSnapshotCharLimit` before this layer sees it still reports
> `truncated: true`; (3) a `tab` matching nothing refuses listing the
> browser's open tabs, one matching two refuses naming both candidates,
> and the candidate set is only ever the page-type-filtered listing — the
> same matcher `run_errand` uses, and it is SHARED, not copied; (4) a peek
> proceeds while an errand or a session batch is driving that same tab —
> reads coexist with drivers (the two-client evidence
> [errands](errands.md) §The wheel measured on 2026-08-12) — and a peek
> never takes, checks, or blocks the turn lock in either direction;
> (5) a peek changes nothing it can avoid changing: no navigation, no
> click, no tab opened or closed, no `bringToFront` (asserted at the
> mocked Playwright seam — a read that raises a window is a read that
> interrupts the user), pre-existing tabs untouched by the guard that
> already protects them, and the detach severs the socket only; (6)
> `peek_tab` passing a NON-EMPTY `session_id` is refused before any
> browser work naming `get_page_content` as the door for sessions, and an
> empty/whitespace `session_id` is treated as absent (the serializer
> reality [errands](errands.md) item (6) records: some provider layers
> send `""` for every declared optional, and a refusal on presence is a
> livelock); (7) `get_page_content`'s session-404 redirect and its
> description now name `peek_tab` for the read-a-tab case instead of
> teaching the errand workaround, and `peek_tab`'s own description
> carries the three-door rule (read a tab → here; drive a tab →
> `run_errand`; read a session's page → `get_page_content`); (8) a live
> pass reads a real signed-in tab through the real chain and finds a
> string known to be on it. A vitest suite drives (1)-(7) through the
> real harnesses the errands story established — the real in-memory MCP
> client + real API server for the tool surface and refusals, the
> route/api-server harness for what only the mocked Playwright seam can
> see — and (8) runs live.

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

## The concept, precisely

A peek is: **attach → extract → detach**, in one request, touching
nothing.

- **Attach.** Identical to the errand's, and shared with it: resolve the
  browser MCP-side (`resolveCdpTarget`, profile + engine + scope, the
  ambiguity refusals reused as-is), match the `tab` argument against the
  page-type-filtered listing with the same two-stage matcher
  (`matchTabsByName` — exactly-one proceeds, zero refuses listing the
  open tabs, several refuse naming candidates), then hand the winner's
  `targetId:` to the existing attach path. The attach inherits the
  errand's known environmental limit: a wedged privileged page (measured
  live 2026-08-13: `chrome://extensions/` answers no CDP query) stalls
  Playwright's connect for the whole browser; the diagnostics that name
  the wedged tab are a separate story, and until then a peek fails with
  the same honest timeout an errand does.
- **Extract.** The same three reads `get_page_content` performs on a
  session's page, byte-for-byte the same functions: `captureVisibleText`
  for `format: "text"` (default), `captureDomSnapshot` for
  `format: "dom"` (with the project's noise-reduction, iframe-depth and
  char-limit settings), `expandDomSubtree` when a `selector` narrows a
  DOM read. Clipping and `truncated` reporting follow
  [page-content](page-content.md)'s rules unchanged — the silent
  `domSnapshotCharLimit` clip still surfaces as `truncated: true`. The
  extraction runs server-side (the MCP process stays browser-free, the
  same constraint that shaped the errand).
- **Detach.** Disconnect. Nothing was opened, so nothing closes; the
  borrowed tab is not raised (`bringToFront` is a courtesy for a user
  watching their tab being *driven* — a read has nothing to show them,
  and raising a window on a read interrupts whatever they were actually
  doing); the pre-existing-pages guard applies as everywhere. The
  response carries `content`, `format`, `selector`, `truncated`,
  `returnedChars`, `availableChars`, the tab's `url` and `title`, its
  `targetId`, and the `root` + `scope` the peek resolved against
  ([mcp-no-project](mcp-no-project.md): every result says which root it
  used).

### No lock, in either direction

A peek never takes the errand turn lock, never consults it, and never
blocks on it — and nothing blocks on a peek. This is not an oversight to
fix later: the lock exists for *drivers* (interleaved input, dialog
races, page-global emulation), and the coexistence of a second passive
*client* is the measured-safe case errands §The wheel documents. A peek
during a mid-run errand may see a page mid-change; `status` has no
meaning here (there is no run), and the receipt's `url`/`title` are read
at extraction time, which is the honest answer to "what was on it when
you looked".

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
`format: "screenshot"` (a session's screenshot rides session state; a
tab screenshot is an open question below), and any config bundle.

The name `peek_tab` carries no `cdp` prefix for the same measured reason
`run_errand` does not — the name must echo the user's words ("look at my
tab", "what's on it"), and the tool cannot reach a launched browser at
all. This extends the **named amendment** errands.md §Tool surface
already records against the prefix rule
([mcp-cdp-browser](mcp-cdp-browser.md) §5, [cdp-tabs](cdp-tabs.md)
§Locked) to a second tool, on the same falsifiability terms: the naming
probe (errands item (8), held) tests a `cdp`-carrying spelling, and if
the probe contradicts the routing argument the prefix wins for both.

## Routing: three doors, one question each

1. **What are you reading?** A tab you can name → `peek_tab`. The page a
   `run_steps` session is sitting on → `get_page_content`.
2. **Reading or driving?** Only reading → `peek_tab`. Any acting —
   clicking, typing, navigating — → `run_errand`, whose steps can also
   capture (`read the balance, store as balance`) so a drive-then-read
   is ONE errand, not an errand then a peek.
3. **Wrong doors redirect.** `get_page_content`'s session-404 refusal
   and description gain the `peek_tab` pointer (amending the PR #50
   text, which could only teach the errand workaround); `peek_tab`'s
   `session_id` refusal names `get_page_content`; `run_errand` is
   unchanged — its capture pattern remains right whenever driving is
   involved.

## What already exists vs what is new

Reused unchanged, and shared rather than copied: the browser resolution
and ambiguity refusals (`resolveCdpTarget`), the two-stage tab matcher
(`matchTabsByName`) over the filtered listing, the attach path
(`connectOverCDP` + `resolveCdpTab` handed only an exact `targetId:`),
the pre-existing-pages guard and disconnect-not-kill semantics, the
three extraction functions and their clipping/truncation contract, the
empty-optional normalisation, and the wrong-door refusal conventions
(returned `isError`, remedy in the text).

New: the `peek_tab` tool and schema; a peek route on the API server
(request: port, targetId, format, selector, maxChars, root, scope;
response: the §Detach shape — no streaming, a read is one round-trip);
the matching `ApiClient` method; the server-side peek handler that
attaches, extracts via the shared functions, and disconnects — beside
`ErrandRunner`, sharing its attach seam, never touching the sessions map
or the run counter; the redirect text updates on `get_page_content`; and
the tool inventory (every count site [cdp-tab-focus](cdp-tab-focus.md)
§5 names, 14 → 15, the by-name enumeration, `usage.ts`, README, the
seam + dialect manifests, `argumentsFor()`).

## Open questions

- **`format: "screenshot"`.** "Show me the tab" is a real ask, and
  Playwright can screenshot an attached page. Deferred: the return-size
  and privacy questions (`screenshots_return`'s reasoning) deserve their
  own decision rather than a rider on v1.
- **Naming.** `peek_tab` vs `read_tab` vs `read_cdp_tab` — the held
  routing probe should test the spellings alongside the errand names
  before anything freezes.
- **Leave-focus-alone as a promise.** v1 simply never raises. If a
  future case wants "peek and bring it forward", that is `focus_cdp_tab`
  composed after — two tools, not a flag.
