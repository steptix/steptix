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
| 39 | The Internet | removed | Test removed 2026-10-13. Chromium's HTTP/2 connection to this host stalls from this network, while curl and Firefox load it; cause not found, and nothing in Steptix to fix. Turning HTTP/2 off made it pass but was not a fix. The rows above are kept as the record |
| 40 | Expand Testing | pass | |
| 41 | DemoQA | pass | Needs a Book Store account as `DEMOQA_USERNAME` and `DEMOQA_PASSWORD` in `survey/web/.env` (register at demoqa.com/register; its reCAPTCHA is the invisible v3 kind, with nothing to solve). Without one, an unattended run fails before the browser starts, naming both missing values (exit 1, since steptix/steptix#74; before that it exited 0 without running, steptix/steptix#46) |
| 42 | UI Testing Playground | pass | Timing-sensitive: under a ten-test load the bar once stopped at 97% |
| 43–45 | | pass | |
| 46 | Selenium web form | pass | Its date picker reads typed text on keyup only. With End gone, a plain type lost the date and the test still passed, so step 10 asks for one character at a time and a new step 12 checks the date (steptix/steptix#90, see Reruns) |
| 47–51 | | pass | |
| 52 | GlobalSQA | pass | The portlet step was vacuous until rewritten (see the C and D table) |
| 53–57 | | pass | 53 asks for its filter text one character at a time since steptix/steptix#90, though its filter reacts to a filled value too and never needed End (see Reruns) |
| 58 | LambdaTest playground | pass | Asks for its table search one character at a time since #90. Step 25's drag moved nothing in two of the three runs on 2026-10-14 and in both batches on 2026-10-19, so the last step failed: the page moves its demo off screen while the drag runs. Since the fix for #92 the drag sees that and drags again (see Reruns) |
| 59 | H Y R Tutorials | pass | |
| 60 | Try Testing This | pass | The early submit goes unnoticed (finding 2) |
| 61 | automationtesting.co.uk | pass | |
| 62 | Leafground | pass | Its table filter reacts to keyup only, so step 14 asks for one character at a time since steptix/steptix#90 (see Reruns) |
| 63–72 | | pass | |

### Reruns

Single files run again after a later change, one row per run. They are not
part of the A–D comparison: each runs one file through the CLI runner
(`node dist/index.js run`) on `openai/gpt-6-luna`, at the commit named.

| # | Test | Change | Commit | Result | Notes |
|---|------|--------|--------|--------|-------|
| 62 | Leafground | steptix/steptix#30: role names match visible text (issue #26) | `a869e2bc` | **pass** 23/23, 229 s, 0.95 M tokens | Run 2026-10-08 12:29 (log clock), with the change on #27's tip before #27 was rebased and merged; on `main` it is `3a42fd43`, which also has the two commits #27 gained before merging (`489cd19c`, `277f7420`). The visible-text fallback resolved three role names that had no exact match. Two were `role=button[name="Show"]` in steps 18 and 19, and one was `[role="dialog"] >> role=button[name="Dismiss"]` in step 19, the PrimeFaces button that prompted §2.34. All three buttons' names start with an icon glyph. Steps 7 (a CSS `select[value=…]` that timed out) and 12 (a check that read a missing element) passed on retry; neither involved a role name |
| 62 | Leafground | steptix/steptix#30, rebased onto `main` after #27 merged | `e1315757` | **pass** 23/23, 268 s, 0.95 M tokens | Run 2026-10-08 13:57 (log clock), with #27's two late commits included (`browser.blockAds` as the project's own list). The fallback resolved two role names in step 19: the sweet alert's "Show" and the dialog's "Dismiss", both resolved by visible text. Step 18's selector matched exactly this time, so the fallback did not run there. Steps 7 (the same CSS `select[value=…]` timeout) and 12 (a check that read a missing `[role="alert"]`) passed on retry, as in the previous rerun |
| 44 | LetCode | None: the first run since §2.47 removed the framework's ad hiding and §2.51 made `blockAds` the project's list | `e01d7553` | pass\* 46/46, 258 s, 1.30 M tokens | Run 2026-10-11 01:24 (log clock). No ad appeared: the run log has no ad markup, so the 13 blocked domains kept them out and the `## Context` ad instructions were never used. \*The WebTable check proved nothing. "Add up the prices in the shopping list table [as: price_total]" read the table's own Total cell (`#shopping tfoot tr td:last-child`, 858) instead of adding anything, the next step read the same cell as `shown_total`, and "858 equals 858" compared it with itself. That check also hit "Assertion code response missing code" once and passed on retry (steptix/steptix#40). The report has no screenshots: the project did not set `browser.captureScreenshotsPerAction`, whose default is `false` (steptix/steptix#65) |
| 44 | LetCode | WebTable rewritten to add the row prices with a `sum` tool (`survey/web/tools/src/sum.ts`); `captureScreenshotsPerAction: true` | `e01d7553` plus the change | **pass** 47/47, 281 s, 1.32 M tokens | Run 2026-10-11 04:27 (log clock). The original step 3, `Add up the prices in the shopping list table [as: price_total]`, became `Read the price of every item in the shopping list table, not the total row [store as: prices]` and `[tool: sum values="{{prices}}" out.sum="price_total"]`. The read took `#shopping tbody tr td:nth-child(2)`, four values (150, 180, 48, 480), the tool summed them to 858, and the check compared that with the Total cell. Again no ad appeared and no step retried |
| 62 | Leafground | steptix/steptix#44: a checkbox hidden with its container is not clicked through a neighbour (issue #32) | `2b6266cc` | **pass** 23/23, 181 s, 0.97 M tokens | Run 2026-10-11 05:32 (log clock). A check that #44 kept what §2.10 and §2.32 built for this page; the bug #32 fixed never occurred here. Step 11 clicked `[aria-label="Basic"]` through the stand-in, the visible box around the hidden input, and #44's new check that an ancestor's click changes the toggle passed. For Ajax the model clicked the visible `span:text-is("Ajax")` itself, so no stand-in ran. Steps 7 (the `select` timeout) and 12 (the missing `[role="alert"]`) passed on retry, as in both earlier reruns |
| 41 | DemoQA | A Book Store account in `survey/web/.env` (`DEMOQA_USERNAME`, `DEMOQA_PASSWORD`) | `fe322d43` | pass\* 34/34, 440 s, 1.42 M tokens | Run 2026-10-12 12:45 (log clock). The login passed and the page showed the account name. \*The search check proved nothing. After login the page was the profile, whose table lists only the account's own (empty) collection, so `Search the books for "Git"` typed into that page's box and `Verify the book list shows "Git Pocket Guide"` found nothing. Its retry opened the Book Store on its own and found the title in the unfiltered list of eight. The search box filters as you type (checked by hand), so no button press was missing. Step 23 (a `selectOption` timeout) passed on retry |
| 41 | DemoQA | Book Store section rewritten so the search is on the Book Store and the check fails if it filtered nothing | `fe322d43` plus the change | **pass** 38/38, 413 s, 1.53 M tokens | Run 2026-10-12 13:13 (log clock). The original steps 4–6, `Search the books for "Git"`, `Verify the book list shows "Git Pocket Guide"` and `Click "Log out"`, became `Navigate to /books`, `Verify the book list shows more than one book` (8), `Type "Git" in the book search box`, `Verify the book list shows "Git Pocket Guide" and no other book`, `Navigate to /profile`, `Click "Log out"` and `Verify the page shows the Login button`. The check collected every visible title and passed on exactly one, Git Pocket Guide. No step retried |
| 53 | Automation Bookstore | steptix/steptix#90: typing no longer presses End after a fill; steps 3 and 11 ask for "one character at a time" | `3c4bbb51` | **pass** 12/12, 106 s, 0.35 M tokens | Run 2026-10-14 00:03 (log clock), on the fix before review; rule 10's first sentence was reworded afterwards. Steps 3 and 11 were the only types the report marks "typed key by key", and the filter left 5 of 8 books after "test" and none after "zzzz". Step 8's "Clear the filter box" is a plain type of nothing and still emptied the filter: the clear's Delete has a keyup. Step 10 hit "Assertion code response missing code" once and passed on retry (steptix/steptix#40) |
| 58 | LambdaTest playground | steptix/steptix#90: step 19 asks for "one character at a time" | `3c4bbb51` | **pass** 26/26, 239 s, 1.21 M tokens | Run 2026-10-14 00:05, on the fix before review. Step 19 was the only type marked "typed key by key", and step 20 found exactly one row. Steps 14 (a wait the model chose for the AJAX submit) and 17 (it read "Downloading..." before "Complete!") passed on retry |
| 53 | Automation Bookstore | The same, after review | `ccb75a42` | fail 4/12, 53 s, 0.18 M tokens | Run 2026-10-14 00:17. Steps 3 and 4 typed and filtered as before (5 of 8). Step 5, `Verify that 5 is less than 8`, failed: four times the model answered the request for check code with an `assert` action (steptix/steptix#40) |
| 58 | LambdaTest playground | The same, after review | `ccb75a42` | fail 25/26, 247 s, 1.22 M tokens | Run 2026-10-14 00:18. Steps 19 and 20 passed, step 19 typed key by key. Step 26 failed: step 25's drag of "Draggable 1" onto `#mydropzone` reported success and the item stayed in `#todrag`. It is the same drag the passing run made, and #90 changes no drag code (steptix/steptix#92). Step 16 (the download button's wait) passed on retry |
| 53 | Automation Bookstore | The same, again | `ccb75a42` | **pass** 12/12, 74 s, 0.29 M tokens | Run 2026-10-14 00:24. Steps 3 and 11 were typed key by key, and no other type was |
| 58 | LambdaTest playground | The same, again | `ccb75a42` | fail 25/26, 208 s, 1.15 M tokens | Run 2026-10-14 00:25. Steps 19 and 20 passed as before; step 26 failed the same way, the drag having moved nothing |
| 62 | Leafground | Step 14 asks for "one character at a time". Its PrimeFaces table filter listens for keyup only (an inline `onkeyup`), and had passed on End's keyup: with a plain fill the table stays unfiltered | `ccb75a42` plus the change | **pass** 23/23, 169 s, 0.96 M tokens | Run 2026-10-14 00:29. Step 14 was the only type marked "typed key by key", and step 15 found every row shown from India. Step 12 (the missing `[role="alert"]`) passed on retry, as in every earlier rerun |
| 46 | Selenium web form | Step 10 asks for "one character at a time", and a new step 12 checks the date. A probe of every section C typing step for #90 found its date picker reads typed text on keyup only and writes its own date back when it closes: after a plain fill the form submitted `my-date=` empty, and the test passed | `967a709c` plus the change | **pass** 15/15, 146 s, 0.46 M tokens | Run 2026-10-14 10:13 (log clock). Step 10 was the only type marked "typed key by key", step 12 read 01/15/2026, and every submit after the file upload carried `my-date=01%2F15%2F2026`; the empty date is step 5's early datalist submit, before the date was set. Step 11 (the slider) passed on retry after a click timeout |
| 40–72 | All of section C, ten at a time, `--headless` | None: the first batch since steptix/steptix#99 (a retried check runs the same check again) | `44ac5672` | 24 of 33 passed | Run 2026-10-19 04:38 (log clock). Failed: 41 (no `DEMOQA_USERNAME`), 45 step 5, 48 step 8, 51 step 3, 54 step 9, 57 step 16, 58 step 17, 61 step 6, 70 step 13. Each is a row below |
| 51 | Ultimate QA | Step 3, `Verify the left-hand form says thanks for contacting`, became `Verify the left-hand form shows a message starting with "Thanks for contacting"` | `44ac5672` plus the change | **pass** 16/16, 126 s, 0.51 M tokens | Run 2026-10-19 05:03 (log clock). In the batch the check expected "Thanks for contacting us.", with a full stop the page does not have, and failed both attempts |
| 54 | omayo | Step 9, `Tick the checkbox next to "Check this"`, became `Tick the "Mr Option" checkbox`. "Check this" is the button that enables it | `44ac5672` plus the change | **pass** 16/16, 236 s, 1.87 M tokens | Run 2026-10-19 05:03 (log clock). In the batch the model asked which checkbox was meant, and an unattended run has no one to answer |
| 70 | DummyTicket | Step 13, `Verify the order summary shows a total price`, became `Verify the order summary shows a total price starting with "AUD"` | `44ac5672` plus the change | **pass** 14/14, 149 s, 0.84 M tokens | Run 2026-10-19 05:03 (log clock). In the batch the check chose its own exact value, "AUD $ 54.72" with a space, and the page shows "AUD $54.72" |
| 58 | LambdaTest playground | Step 17, `Verify the page says the download is complete`, became `Verify the File Download dialog says "Complete!"` | `44ac5672` plus the change | fail 25/26, 245 s, 1.16 M tokens | Run 2026-10-19 05:03 (log clock). Step 17 passed; in the batch it had read the download button, which says "Downloading...". Step 26 failed: step 25's drag `span:text-is("Draggable 1")` → `#mydropzone` reported success and moved nothing (steptix/steptix#92). That selector passed on 2026-10-14, and this run was headless where those were headed |
| 48 | Rahul Shetty practice | Steps 7–8, `Type "Steptix" into the name field under "Switch To Alert Example" and click Alert` and `Verify the alert text contains "Steptix", then accept it`, became `Type "Steptix" into the name field under "Switch To Alert Example", then click Alert and accept the alert` and `Verify the alert said "Steptix"` | `44ac5672` plus the change | **pass** 22/22 ×3, 196–230 s, 0.84–0.87 M tokens | Runs 2026-10-19 07:53 (log clock), three at once. Step 7 armed the answer before the click each time, and step 8 read "Hello Steptix, …" from the dialog record. In the batch, step 8 tried to accept an alert step 7's click had already dismissed; the `dialog` action was refused, and the retry opened the alert again without the name, which the page had cleared. Earlier passes skipped "then accept it" |
| 61 | automationtesting.co.uk | Step 5, `Press 1, 2, +, 3, 0, = on the calculator`, became `Press 1, then 2, then +, then 3, then 0, then = on the calculator` | `44ac5672` plus the change | **pass** 19/19 ×3, 147–160 s, 0.57–0.62 M tokens | Runs 2026-10-19 09:07 (log clock), three at once. In the batch the model pressed 1, 2, 3, +, 0, = (one key a turn, told the keys pressed so far each turn), and the display showed 123. The old wording had pressed the keys in order in 6 earlier runs, so three passes do not show the new wording is needed |
| 45 | Test Pages | The check code AI's snapshot is cut at `browser.domSnapshotCharLimit`, and over it leaves hidden elements out (branch `fix/check-code-snapshot`). The test is unchanged | `e164574c` | **pass** 26/26 ×2, fail 25/26 ×1, 341–346 s, 1.64–1.76 M tokens | Runs 2026-10-19 10:15 (log clock), three at once. Step 5 passed at the first check in all three. In the batch it read the empty form's comment textarea, because the code AI was sent the first 100,000 characters of a 295,691-character page, all side menu. The failure was step 25, `Draw a line across the middle of the canvas`: the model asked how, as the page offers Circle and Square |
| 45 | Test Pages | The same, with `browser.domSnapshotCharLimit` at 150,000 so the page is over it | `e164574c` | **pass** 26/26 ×3, 265–290 s, 1.45–1.49 M tokens | Runs 2026-10-19 10:21 (log clock), three at once. Every check's code was written from the snapshot with hidden elements left out, and step 5 passed at the first check in all three |
| 57 | Practice Automation | Steps 16–17, `Hover over the "Mouse over me" text` and `Verify the text changes to say you hovered`, became `Hover over the "Hover" page title`, `Verify the grey heading below the introduction says "Mouse over me"`, `Hover over the "Mouse over me" heading` and `Verify that heading now says "You did it!"` | `44ac5672` plus the change | **pass** 25/25 ×3, 152–159 s, 0.69–0.70 M tokens | Runs 2026-10-19 10:33 (log clock), three at once. Step 7's click on `#prompt` leaves the pointer at about (1060, 316), where the hover page's heading lies, so the heading is hovered as the page loads and already says "You did it!" before the step. Reproduced headless and headed. In the batch the model looked for "Mouse over me", found none and asked; earlier passes hovered `#mouse_over` by its id, and step 17 then found the text the stale pointer had produced, so it proved nothing. Now step 17 reads "Mouse over me" after the pointer moves off, and step 19 reads "You did it!" after the hover |
| 49 | QA Practice | Steps 19–20, `Go to the last page of results` and `Verify the last page is shown as the current page`, became `Click page 3 in the pagination` and `Verify the message below the pagination says "You clicked page no. 3"` | `e164574c` and `f1995a6c` merged, plus the change | **pass** 29/29 ×3, 262–275 s, 1.00–1.03 M tokens | Runs 2026-10-19 11:06 (log clock), three at once. The page has links 1, 2, 3 and Next and no results; a click only shows "You clicked page no. N" (`js/pagination.js`), and no link is ever marked current. So "shown as the current page" asked for something the page never shows: on 2026-10-19 the check read the message in the 04:38 batch and passed, and looked for an `.active` or `aria-current` link in the 10:36 batch and failed |
| 58 | LambdaTest playground | steptix/steptix#92: an HTML5 drag that could not drop fails, and drags once more if the page moved the pair (SPEC-web-survey-fixes.md §2.52). The test is unchanged | `b77a24b4` plus the fix | **pass** 26/26 ×3, 266–279 s, 1.47–1.49 M tokens | Runs 2026-10-19 12:42 (log clock), one after another, `--headless`. Step 25 dragged by the stepped route each time, and each time the first drag could not drop: the page moved its demo 1280px to the right while the drag ran. In runs 1 and 2 the press reached the item and no drag started; in run 3 the drag started and the drop zone got no `dragover`. The page had moved both ends, so the drag ran again from where they were, and dropped (`dragover on the target yes, … drop yes`). Step 26 then read "Draggable 1" in the dropped list. An earlier run on the fix before review showed the third shape too: the press landed on a `section` beside the item. Steps 14 and 16 (waits for the AJAX submit and the download button) passed on retry |

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
   the timeout message would name, is steptix/steptix#20. The c39 test was
   removed on 2026-10-13, since its failure said nothing about Steptix.
6. **Conditional steps leave no per-step record.** 71's If step and the step
   after it report `unknown` in the run result, so whether the cookie dialog
   was there, and what was done about it, is not visible outside the HTML
   report.
7. **Cost.** A section C file costs 0.2–1.8 M input tokens on gpt-6-luna,
   mostly DOM snapshots resent every turn; 54 (omayo, one long page) is the
   worst. Compiling the passing files would replay them at no AI cost, which
   none of these runs tried.
