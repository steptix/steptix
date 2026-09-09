---
tags: [smoke, rows]
---

# SecureBank sign-in, with the credentials in a section

The same login the other SecureBank tests do, with the two typing steps moved
into a `### Log In` section and the credentials in a table under its heading.
That makes it a section-level loop (stories/data-driven-rows.md, part B): the
section's body runs once per row, inside one run, and steps 1–3 are the whole
main flow.

It exists to be *narrowed*. A section has two axes a selection can cut down
independently (stories/data-row-progress-and-selection.md, decision 3) — its
rows and its body steps — and this is the smallest file with both. Select the
three main-flow steps, the body's second step and the table's second row, press
Run, and the section should run once, for row 2, entering only the password.

Row 1 signs in successfully, but only if both body steps run; row 2's
credentials are rejected. Neither matters to the narrowing scenario, which
never gets as far as clicking Sign In — the section types and stops, and what
is being checked is which steps ran, not whether the sign-in worked.

The cookie banner is remembered in `localStorage`, so step 2 has something to
click on the first run of a fresh browser and nothing to click on a re-run in
the same one.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
1. Navigate to the baseUrl
2. Reject non-essential cookies in the cookie banner
3. Log In

### Log In
| email                 | password    |
|-----------------------|-------------|
| demo@securebank.com   | password123 |
| nobody@securebank.com | wrongpass   |
1. Enter the email {{email}}
2. Enter the password {{password}}
