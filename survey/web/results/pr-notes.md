# Notes for this branch's pull request

Items the pull request description must carry, each as the problem and the
solution. The full detail is in `docs/specs/SPEC-web-survey-fixes.md`.

## Notifications are recognised by web standards, not class names (§2.50)

**Problem.** Steptix remembers notifications that close by themselves, so a
check made a few seconds later can still see them (§2.33). It decided what
counts as a notification partly by class name: anything whose class contained
`toast`, `growl`, `snackbar` or `notification`. Those are libraries' own
words. `growl` is PrimeFaces' name, taken from the one survey site (Leafground)
where the problem showed up. That is a site-shaped guess in the framework,
which `CLAUDE.md` forbids. It also missed any library using another word
(`flash-message`) and could catch unrelated elements that share one (a
"notification settings" panel).

**Solution.** Only what the page itself declares in WAI-ARIA counts, the web
standard for "announce this to the user": a live region. That means `role`
`alert`, `status` or `log`, an `aria-live` other than `off`, or an `<output>`
element. A message added inside an element that is already a live region
counts too. No class name is read. Leafground was checked live: PrimeFaces
marks its notifications with `aria-live="polite"` and `role="alert"`, so its
"Checked" message is still recorded. The AI's assertion prompt now says the
list holds live-region messages.

Pages that show messages, or draw controls, without any standard marking are
the subject of steptix/steptix#24, which proposes ways for a test author to
declare what the page leaves out.
