---
tags: [smoke, rows]
---

# SecureBank sign-in validation

Drives the fixture app's login page once per row. The table under `## Steps`
is what makes it loop (stories/data-driven-rows.md, part A): each column is a
variable the steps read as `{{name}}`, and each row is one run in its own
browser.

The `outcome` column is the interesting one. It changes what step 6
*verifies*, not what a step types, which is why a compile leaves that step
under AI while steps 3–5 compile to code that reads the row.

Two things about the page the rows depend on. The form is `novalidate` with
`required` inputs, so an empty field does not block submission — the request
goes to `/api/login`, is rejected, and the banner appears; that is why the two
empty-field rows expect the banner rather than a disabled button. And the
cookie banner is remembered in `localStorage`, so step 2 only has something to
click on every row because every row gets a fresh browser.

The populated success row is first on purpose: a compile records row 1, and an
empty value in the recorded row cannot vouch for the parameter it came from.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Steps
| email                 | password    | outcome                                         |
|-----------------------|-------------|-------------------------------------------------|
| demo@securebank.com   | password123 | the Dashboard page is shown                     |
| demo@securebank.com   | wrongpass   | the "Invalid email or password" banner is shown |
| nobody@securebank.com | password123 | the "Invalid email or password" banner is shown |
| demo@securebank.com   |             | the "Invalid email or password" banner is shown |
|                       | password123 | the "Invalid email or password" banner is shown |

1. Navigate to the baseUrl
2. Reject non-essential cookies in the cookie banner
3. Enter the email {{email}}
4. Enter the password {{password}}
5. Click the Sign In button
6. Verify {{outcome}}
