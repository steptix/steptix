# Working through REPORT.md — progress

The work landed as one commit in
[PR #190](https://github.com/pkent/steptix/pull/190), on the branch
`claude/unit-tests-review-08457c`.

## Wave 1 — confirmed flakes, time bomb, pretest builds (§1.2, §1.4, §1.5.7)

- [x] record-steps-toolbar:446 crop — polls for the outline instead of sleep(300)
- [x] stats-run-stats:347 — asserts the median, not the average
- [x] fixture-server boot (6 files) — `tests/fixture-server.ts`; the server binds port 0 and prints it
- [x] computer-step wait budget — `computer.now`/`computer.sleep` seam, virtual clock in the tests
- [x] selector-role-names "waits until it holds" — no elapsed-time check, generous budget
- [x] api-server-record-steps "quick burst" — 3 s settle window (it restarts on each action)
- [x] stats-classify:425 — probes run one at a time, target attached first
- [x] flick store/controller — atomic writes with a retried rename; background failures kept and reported
- [x] use-ai-step-runner:188 — fixture year is the current year + 5
- [x] runner-core `pretest`; steptix-vscode `pretest` also builds runner-core
- [x] weekly shuffled CI run (`.github/workflows/unit-tests-shuffled.yml`); CLAUDE.md test rules

## Wave 2 — every other finding, one fixer per batch

All 16 batches done. Totals across the fix logs: about 540
DONE lines (a line can cover several tests), 25 NOT DONE with a reason.

Not acted on, by design:
- Items the findings themselves said to keep: zoom-then-click at three levels,
  CLI/session parity tests, the codebehind-writer lock test's cost, the
  record-steps property runs, credential-broker's 5 s cost, the section-index
  overlap between runner-core and the root parity test, repeated rows in the
  failure-tail-parse and REFUSE tables.
- Cost notes with no cheaper form that keeps coverage: the per-worker shared
  browser, the stats seam suites, the section-index fuzz, the record-steps
  Chromium per test.
- Merges that would weaken a check: viewport-config's refusal tests,
  viewport-recycle:112, the three session-manager tests on one fixture.
- STX002/020/026/030/031 stay in the error catalogue (user-visible codes).

Follow-ups done by the coordinator: the nine other code-behind suites moved
to `tests/codebehind-scratch.ts`; `tests/.tmp-*/` gitignored; a direct test
for the history appender; stale `resolveRunLines` comments; the stray
`C:\tests\` folder deleted; steptix-vscode 0.5.169.

## Wave 3 — verification

- [x] builds and typechecks clean (root, runner-core, flick-vscode; the extension bundle builds)
- [x] node suites: 50 rounds each under load, 0 failures (flick-vscode was 2/50 before)
- [x] WSL Linux: runner-core 518/518, flick 66/66, steptix-vscode 1223 + 1 skip; root fails only on Playwright launches (no browser in WSL)
- [x] root suite, 10 runs under load (4 file order, 6 shuffled). Before the
      fixes all 5 comparable runs failed (1–38 tests each). After: 2 single
      failures in 10 runs, both fixed or instrumented — dialog-guard's CDP
      profile cleanup (EBUSY; fixed) and one api-server-record-steps
      "fetch failed" that never recurred (its error now names the socket
      cause). Two further runs failed only build-info / stats-fingerprint's
      "dist/ built at HEAD" check, because a commit landed mid-run.
- [x] steptix-vscode: one server-manager probe read a fresh stub as "down"
      once in 25 rounds; its assertion now prints the probe's detail.
- [x] final `npm test` in all four projects: root 7130 passed + 7 skipped,
      runner-core 518, flick-vscode 66, steptix-vscode 1222 + 2 skipped.

Test counts before → after: root 7371 → 7137, steptix-vscode 1270 → 1224,
runner-core 629 → 518, flick-vscode 68 → 66 (9,338 → 8,945).
