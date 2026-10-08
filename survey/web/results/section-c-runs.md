# Section C runs, side by side

Every run used `openai/gpt-6-luna`, `capture: every-step` and a fresh browser
session per file. Runs A and B used the test files exactly as committed in
`01f52c2e`; runs C and D used them as fixed in the spec's §3
(docs/specs/SPEC-web-survey-fixes.md). Reports are in `survey/web/reports/`
(gitignored), named by run time and test.

Run columns:

- **A: main**: the server built from `main` at `2e929624`, before PR #19.
  Run on 2026-10-07 (server clock), report times 14:41 to 15:57.
- **B: PR #19**: this branch rebased onto PR #19's head (`cc339da5`), served
  from this worktree at `244b8279`. The same files, unchanged. Report times
  16:01 to 17:12.
- **C: survey fixes**: §2.1–§2.36 of the spec, at `e1eb947` (`0f492cb1`
  after the second rebase), run in batches of ten on 2026-10-07/08. A test that
  failed in a batch was run again on its own before being counted.
- **D: PR #19 again**: rebased onto PR #19's new head (`ba8e07e7`, three
  commits more than B had) with §2.37–§2.42 added: `c0e64324` for 39–48,
  `4e93b6b8` for the rest. Batches of ten, failures rerun alone. Report times
  2026-10-08 00:38 to 02:16.

The detailed table below describes run A. The comparison of A and B is in
[A against B](#a-against-b), and runs C and D, with the final table and the
findings, are in [C and D](#c-and-d) at the end.

Failure categories follow the rubric in
[docs/web-survey-sites.md](../../../docs/web-survey-sites.md). In the cause
column, **script** means the test file was wrong about the site, **site** means
the site itself was broken, and **framework** means Steptix could not do
something it should.

| # | Test | A: main | Failed at | What went wrong | Cause |
|---|------|---------|-----------|-----------------|-------|
| 39 | The Internet | blocked | 1/39 | The page never finishes loading in any browser, ours or the in-app one. `curl` gets the HTML in 0.7 s, but `readyState` stays `loading`, so `page.goto` times out waiting for `domcontentloaded`. | site |
| 40 | Expand Testing | fail | 10/27 | "Show 25 entries per page": the dropdown offers only 3, 5, 10 and All. The model asked what to do, and an unattended run fails on a question. Step 8, a three-value verify, also took 368 s: it hit the 15-turn limit, then passed on retry. | script, plus framework (slow verify) |
| 41 | DemoQA | fail | 2/29 | "Expand the whole tree": every click on the tree's expand toggles timed out (`[role=treeitem][aria-expanded=false] > span`). DemoQA's checkbox tree has a new markup. | framework (locator) |
| 42 | UI Testing Playground | fail | 18/31 | "Click Stop as soon as the bar reaches 75%": the bar was at 100% by the time Stop was clicked. One AI turn takes seconds, so Steptix cannot act when a value changes. Steps 1 to 17 passed: dynamic ids, hidden layers, AJAX and client-side waits, and the ARIA div table. | framework (no "wait for a condition, then act") |
| 43 | WebdriverUniversity | fail | 9/28 | "Accept the alert that appears": the model sent `accept_alert`, then `accept_dialog`. Neither action exists. The new tab, the validation error and the contact form all passed. | framework (no dialog action) |
| 44 | LetCode | fail | 2/8 | "Play Sandbox" was clicked, but a Google full-screen ad (`#goog_fullscreen_ad`) covered the page, so the click never landed. The step stalled after 3 quiet turns. | framework (ads that block clicks) |
| 45 | Test Pages (EvilTester) | fail | 5/26 | After the form posted, the check for the user name read the label "Password:" instead of the value "survey". | framework (assertion read the wrong element) |
| 46 | Selenium web form | fail | 9/14 | "Set the colour picker to #00ff00" failed: `locator.clear: Malformed value`. Steptix types into `<input type=color>` as if it were a text box. In step 5, pressing Enter in the datalist also submitted the form early. | framework (colour input; Enter submits) |
| 47 | Formy | fail | 10/24 | After picking a Google Places suggestion, the city field was still empty. The page's Places widget does not fill the other fields. | script (wrong assumption about the site) |
| 48 | Rahul Shetty practice | fail | 8/22 | "Verify the alert text contains Steptix": the alert is a native dialog, and the assertion looked for `[role=alert]` in the DOM. Steptix cannot read a dialog's text. | framework (dialog text) |
| 49 | QA Practice | fail | 13/29 | "Double-click the button": the model sent `doubleClick`, then declared the step impossible, because the action list has no double-click. The shop flow (login, cart, order, logout) passed. | framework (no double-click action) |
| 50 | Test Automation Practice blog | fail | 4/23 | "Select Red and Green in the Colors list": `selectOption` reported "did not find some options" on the multi-select. | framework (multi-select) |
| 51 | Ultimate QA | **pass** | | Solved the arithmetic challenge. Two verify steps recovered after "assertion response missing code". | |
| 52 | GlobalSQA | fail | 3/16 | The High Tatras photo was dragged to the trash and the trash showed it, but the gallery also still showed it, so the drop never completed. | framework (drag in an iframe) |
| 53 | Automation Bookstore | fail | 5/12 | "Count the books shown" counted 8 both before and after filtering. The filter hides books rather than removing them, and the count includes hidden ones. | framework (counts hidden elements) |
| 54 | omayo | fail | 7/16 | The prompt step failed. The model tried `accept_dialog`, `dialog` and `handleDialog`, and none of them exist. The alert in step 6 only passed because the model pressed Enter, after 92 s. | framework (no dialog action) |
| 55 | Tutorialspoint | fail | 11/19 | After "add a record", the table had no row for Survey Tester. The form was filled in, but the record never appeared. | to investigate |
| 56 | QAVBox | **pass** | | Covered sign-up, a delay, drag and drop, shadow DOM and an autosuggest. | |
| 57 | Practice Automation | fail | 7/23 | The prompt popup failed on an unknown `dialog` action. The confirm in step 5 passed, because the page's default handling chose Cancel. | framework (no dialog action) |
| 58 | LambdaTest playground | fail | 20/26 | After searching the tasks table for "jQuery", none of the 7 rows shown mention jQuery. | to investigate |
| 59 | H Y R Tutorials | fail | 3/19 | Clicking Register failed: a Google anchor ad iframe intercepted the pointer for the full 10 s. | framework (ads that block clicks) |
| 60 | Try Testing This | fail | 2/14 | "Accept the alert": unknown `acceptAlert` and `accept_dialog` actions. | framework (no dialog action) |
| 61 | automationtesting.co.uk | fail | 10/19 | "Accept the alert": unknown `accept_dialog`. The accordion, the button calculator (12+30=42) and the loader all passed. | framework (no dialog action) |
| 62 | Leafground | fail | 11/23 | "Tick Basic and Ajax": clicks on `[aria-label=Ajax]` timed out on PrimeFaces checkboxes. Earlier, `keyboard.press: Unknown key "END"`. | framework (styled checkbox; key names) |
| 63 | SeleniumBase demo page | fail | 4/14 | "Select Set to 75%" passed, but the progress label still said 50%. | to investigate |
| 64 | SeleniumBase MFA | fail | 9/10 | The credentials and the TOTP code were read correctly (`385832`), but the form was filled in one tab, and "switch back to the main tab" went to another tab with an empty form. Sign-in then failed with "The Username is Required!". | framework (which tab is "main") |
| 65 | Techlistic form | **pass** | | One verify step took 92 s. | |
| 66 | Basic Calculator | fail (expected) | row 3, step 4/10 | Build 2 answered 23 for 2 + 3, and the failure names that wrong answer. The Prototype and build 1 rows passed. This is the result the test is for, but the file has no way to say a row is expected to fail. | script (needs an expected-failure form) |
| 67 | Quotes to Scrape | **pass** | | Covered JS-rendered and delayed content, infinite scroll, and the any-credentials login. | |
| 68 | Scrape This Site | **pass** | | One navigation got `ERR_CONNECTION_CLOSED` and passed on retry. | |
| 69 | httpbin form | **pass** | | | |
| 70 | DummyTicket | fail | 6/14 | "Choose to add 1 more passenger" ticked the checkbox but did not pick the count, and the step still passed. The next verify failed. | script (ambiguous step), plus framework (step passed half done) |
| 71 | W3Schools Tryit | fail | 3/7 | Replacing the CodeMirror text: the click on its hidden textarea timed out, then `keyboard.press: Unknown key "CTRL"`. | framework (key names; code editor) |
| 72 | jQuery UI | fail | 7/19 | The droppable demo passed. "Drag Item 1 below Item 3" did not reorder the sortable list, because a single jump does not trigger jQuery UI's sortable. | framework (drag needs intermediate moves) |

**A: main**: 6 passed, 1 failed as designed (66), 1 blocked by the site (39),
and 26 failed.

## Seen in every run

- **A false warning on every captured variable.** The run result warns
  "These placeholders have no value and will reach the AI literally" for
  `{{name}}` values that an earlier `[as: name]` step captures, and those
  values do get filled in.
- **"Assertion code response missing code field".** It appeared in 51, 54 and
  68, and the retry always recovered, at the cost of an extra model call each
  time.

## A against B

PR #19 changes compiled code-behind: how a compiled step waits and which
selector a compiled read uses. None of these runs compile. Every step ran under
AI, so the PR had nothing to act on, and any difference between A and B comes
from the model choosing a different route on a second attempt.

| # | Test | A: main | B: PR #19 | Difference |
|---|------|---------|-----------|------------|
| 39 | The Internet | blocked 1/39 | blocked 1/39 | none: the site does not load |
| 40 | Expand Testing | fail 10/27 | fail 10/27 | none; the slow verify took 135 s in B and 368 s in A |
| 41 | DemoQA | fail 2/29 | fail 2/29 | none |
| 42 | UI Testing Playground | fail 18/31 | fail 18/31 | none. In B the model tried a `wait` for `aria-valuenow=75` first, which timed out because the bar never sits on exactly 75 |
| 43 | WebdriverUniversity | fail 9/28 | fail 9/28 | none |
| 44 | LetCode | fail 2/8 | fail 2/8 | none |
| 45 | Test Pages | fail 5/26 | fail 5/26 | none |
| 46 | Selenium web form | fail 9/14 | fail 9/14 | none |
| 47 | Formy | fail 10/24 | fail 10/24 | none |
| 48 | Rahul Shetty practice | fail 8/22 | fail 8/22 | none; in B the assertion said outright "browser alert dialog text is not accessible from the page DOM" |
| 49 | QA Practice | fail 13/29 | fail 13/29 | none |
| 50 | Test Automation Practice blog | fail 4/23 | fail 11/23 | B got further: the multi-select passed when the model picked the colours one at a time, then B failed on the next missing dialog action |
| 51 | Ultimate QA | **pass** | **pass** | none |
| 52 | GlobalSQA | fail 3/16 | fail 3/16 | none |
| 53 | Automation Bookstore | fail 5/12 | fail 5/12 | none |
| 54 | omayo | fail 7/16 | fail 7/16 | none |
| 55 | Tutorialspoint | fail 11/19 | fail 10/19 | B failed one step earlier: "add a record" hit the 15-turn limit instead of passing half done. Same modal |
| 56 | QAVBox | **pass** | **pass** | none; B's multi-select hit "did not find some options" first, then recovered |
| 57 | Practice Automation | fail 7/23 | fail 7/23 | none |
| 58 | LambdaTest playground | fail 20/26 | fail 20/26 | none |
| 59 | H Y R Tutorials | fail 3/19 | fail 3/19 | none |
| 60 | Try Testing This | fail 2/14 | fail 3/14 | B got further: the alert step passed, then B failed on the missing double-click action |
| 61 | automationtesting.co.uk | fail 10/19 | fail 10/19 | none |
| 62 | Leafground | fail 11/23 | fail 11/23 | none |
| 63 | SeleniumBase demo page | fail 4/14 | fail 4/14 | none |
| 64 | SeleniumBase MFA | fail 9/10 | fail 9/10 | none. In B the captured credentials included the page's whole `<script>` source |
| 65 | Techlistic form | **pass** | **pass** | none |
| 66 | Basic Calculator | fail (expected) | fail (expected) | none |
| 67 | Quotes to Scrape | **pass** | **pass** | none |
| 68 | Scrape This Site | **pass** | **pass** | none |
| 69 | httpbin form | **pass** | **pass** | none |
| 70 | DummyTicket | fail 6/14 | fail 6/14 | none |
| 71 | W3Schools Tryit | fail 3/7 | **pass** | B passed: the model replaced the editor text without sending the `CTRL` key name that broke A. The If step and the step after it are reported as `unknown`, though the run passed |
| 72 | jQuery UI | fail 7/19 | fail 7/19 | none |

**Totals.** A: 6 passed. B: 7 passed. Of the four rows that differ, none
comes from PR #19, and the extra pass (71) is the model choosing a different
key on a second attempt.

## C and D

C and D are the runs after the framework fixes. "Alone" means the test failed
in a batch of ten and passed when run again by itself; the batch failure is
named in the notes so a flaky test is not hidden.

| # | Test | A | B | C | D | D notes |
|---|------|---|---|---|---|---------|
| 39 | The Internet | blocked | blocked | pass* | pass* | *Both passes used `--disable-http2`, since withdrawn: Chromium's HTTP/2 to this host stalls from this network (§2.37) and turning it off routes around one site rather than fixing anything. Without it the test fails at step 1, now with a message saying the site answers outside the browser. Basic auth passed by putting the credentials in the URL |
| 40 | Expand Testing | fail | fail | **pass** | **pass** | |
| 41 | DemoQA | fail | fail | pass\* | fail 31/34 | \*C's pass was false: it typed `$DEMOQA_USERNAME` into the Book Store login and a check then found that text (§2.40). D refuses that and fails the section by name. Steps 1–28 pass; the section needs a real account |
| 42 | UI Testing Playground | fail | fail | **pass** alone | **pass** | Batch C stopped the bar at 97%, alone at 75%. D stopped at 75% in the batch |
| 43 | WebdriverUniversity | fail | fail | **pass** | **pass** | A `dialog` sent after its click was refused with the fix in the message, and the retry armed it first |
| 44 | LetCode | fail | fail | **pass** | **pass** | The model sent `clear`, now an alias (§2.41) |
| 45 | Test Pages | fail | fail | **pass** alone | **pass** | The results check read the empty form's textarea on attempt 1; §2.25's hint named where "Steptix survey" was and attempt 2 passed |
| 46 | Selenium web form | fail | fail | **pass** | **pass** | Enter in the datalist submitted the form early, as in A; the later Submit carried the values again |
| 47 | Formy | fail | fail | **pass** | **pass** | |
| 48 | Rahul Shetty practice | fail | fail | **pass** | **pass** | |
| 49 | QA Practice | fail | fail | **pass** | **pass** | |
| 50 | Test Automation Practice blog | fail | fail | **pass** | **pass** | |
| 51 | Ultimate QA | **pass** | **pass** | **pass** | **pass** | |
| 52 | GlobalSQA | fail | fail | pass* | **pass** (script fixed) | *C and D's first passes were false: Shopping is the only portlet in the middle column, so "drag it to the top of its column" was true before anything moved, and the screenshot shows the drag had selected text instead. The step now drags Shopping above Feeds; the screenshot after the check shows it there and the middle column empty |
| 53 | Automation Bookstore | fail | fail | **pass** | **pass** | |
| 54 | omayo | fail | fail | **pass** | **pass** | The most expensive file: 1.8 M input tokens |
| 55 | Tutorialspoint | fail | fail | **pass** | **pass** | |
| 56 | QAVBox | **pass** | **pass** | **pass** alone | **pass** (script fixed) | The form shows no confirmation. D's model asked rather than accept the address as evidence, which is right; the step now checks the address |
| 57 | Practice Automation | fail | fail | **pass** | **pass** | "Set the slider to 75" hit the 15-turn limit, then passed on retry (89 s) |
| 58 | LambdaTest playground | fail | fail | **pass** | **pass** | |
| 59 | H Y R Tutorials | fail | fail | **pass** | **pass** | |
| 60 | Try Testing This | fail | fail | **pass** | pass\* | \*Enter in the autocomplete submits the form; the final Submit then sends empty names, and no step checks what was submitted. A pass that proves less than it reads |
| 61 | automationtesting.co.uk | fail | fail | **pass** | **pass** | |
| 62 | Leafground | fail | fail | **pass** | **pass** | |
| 63 | SeleniumBase demo page | fail | fail | **pass** | **pass** | |
| 64 | SeleniumBase MFA | fail | fail | **pass** | **pass** | |
| 65 | Techlistic form | **pass** | **pass** | **pass** | **pass** | |
| 66 | Basic Calculator | fail (expected) | fail (expected) | **pass** | **pass** | The file now states each build's expected answer |
| 67 | Quotes to Scrape | **pass** | **pass** | **pass** | **pass** | |
| 68 | Scrape This Site | **pass** | **pass** | **pass** | **pass** | Two "assertion response missing code" retries (§2.14 recovers them) |
| 69 | httpbin form | **pass** | **pass** | **pass** | **pass** | |
| 70 | DummyTicket | fail | fail | **pass** | **pass** | §2.34's rewrite of "I'm the only traveler" was unparsable once the click added its filters; fixed in §2.42, and the rerun on `28d49b00` passed that step first time. The same rerun's "Return date *" check led to §2.43 |
| 71 | W3Schools Tryit | fail | **pass** | **pass** | **pass** | The If step and the step after it still report `unknown` |
| 72 | jQuery UI | fail | fail | **pass** | **pass** | |

**Totals.** A: 6 of 34. B: 7. C: 33 reported, of which two were false (41
typed an unset variable, 52 checked something already true). D: 33 once 52 and
56 were rewritten (60 proves less than it reads, finding 2), with 41 failing
for want of an account. Both C and D counted 39 as a pass with HTTP/2 turned
off; with that workaround withdrawn, the standing result is 32 of 34.

Every C and D pass ran under AI with no compiled steps, so PR #19's changes,
which are about compiled code-behind, had nothing to act on in either run.

### Final table

| # | Test | Result | Issue |
|---|------|--------|-------|
| 39 | The Internet | fail | Chromium's HTTP/2 connection to this host stalls from this network, while curl and Firefox load it; cause not found. Turning HTTP/2 off makes it pass but is not a fix |
| 40 | Expand Testing | pass | |
| 41 | DemoQA | fail | Book Store login needs `DEMOQA_USERNAME` and `DEMOQA_PASSWORD` in `survey/web/.env` (register at demoqa.com; it has a reCAPTCHA) |
| 42 | UI Testing Playground | pass | Timing-sensitive: under a ten-test load the bar once stopped at 97% |
| 43–51 | | pass | |
| 52 | GlobalSQA | pass | The portlet step was vacuous until rewritten (see the C and D table) |
| 53–59 | | pass | |
| 60 | Try Testing This | pass | The early submit goes unnoticed (finding 2) |
| 61–72 | | pass | |

### Findings: what the framework does not support, or gets wrong

Fixed during the survey, with a spec section each: §2.1–§2.50. Raised as issues: steptix/steptix#20, #21, #24, #25 and #26. Still open:

1. **Acting faster than a model turn.** "Click Stop as soon as the bar reaches
   75%" only works because one turn can now chain a threshold `wait` and a
   click (§2.13, §2.17, §2.21). Anything that needs a reaction within a few
   hundred milliseconds of a change the model has not seen yet is out of
   reach, and under load it slips (42 at 97%).
2. **An unintended form submit is invisible.** Enter in an autocomplete or a
   datalist submits the surrounding form (46, 60). The step that pressed it
   passes, the page reloads with half-filled values, and nothing in the run
   says a submit happened. A navigation caused by Enter in a field could be
   reported on that step.
3. **Lenient checks where the page has no evidence.** Asked to verify
   something the page does not show — a confirmation on 56 — the model has
   accepted indirect evidence (the address). And a step already true before
   it acts passes without proving the action worked: 52's "drag Shopping to
   the top of its column" passed twice while the drag only selected text.
   §2.39 makes the model ask in the clear case, but neither the step nor the
   check notices that nothing changed.
4. **Unset environment values used to reach the page.** §2.40 closes it in
   the step loop, but the MCP client's pre-flight still only warns, and its
   "placeholders have no value" warning also fires for every captured variable
   (the false warning under "Seen in every run"), so the one real warning is
   lost among false ones.
5. **A Chromium-only network stall, cause unknown.** Chromium (and Edge) get
   no page from the-internet.herokuapp.com over HTTP/2 from this network, while
   curl over HTTP/2 and Firefox do. §2.37 now says so instead of a bare
   timeout, but why it happens, and what the framework should do about it, is
   still open. A documented per-test and per-project HTTP/2 setting, which
   the timeout message would name, is steptix/steptix#20.
6. **Conditional steps leave no per-step record.** 71's If step and the step
   after it report `unknown` in the run result, so whether the cookie dialog
   was there, and what was done about it, is not visible outside the HTML
   report.
7. **Cost.** A section C file costs 0.2–1.8 M input tokens on gpt-6-luna,
   mostly DOM snapshots resent every turn; 54 (omayo, one long page) is the
   worst. Compiling the passing files would replay them at no AI cost, which
   none of these runs tried.
