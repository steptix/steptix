# Section C runs, side by side

Every run used `openai/gpt-6-luna`, `capture: every-step`, a fresh browser
session per file, and the test files exactly as committed in `01f52c2e`.
Reports are in `survey/web/reports/` (gitignored), named by run time and test.

Run columns:

- **A: main**: the server built from `main` at `2e929624`, before PR #19.
  Run on 2026-10-07 (server clock), report times 14:41 to 15:57.

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
