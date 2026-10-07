---
tags: [survey, section-c, login, mfa, totp, tabs]
timeout: 300s
---

# 64 SeleniumBase RealWorld: login with an MFA code

A login page that needs a user name, a password and a time-based one-time code
(TOTP). Its companion signup page shows the demo credentials and the current
code, which changes every 30 seconds. So the test reads the code from a second
tab and has to type it before it expires.

Every navigation names its URL and says which tab. In the first version, "Navigate
to signup" made the model click a link that opened a new tab, so "the main
tab" was a different tab from the one with the half-filled login form.

This is the survey's only MFA site. When it fails, write down how Steptix
should get a TOTP code: read it off a page, as here, generate it from a secret
in `.env` with a tool, or ask a person with `[input:]`.

**Probes:** reading credentials off another page, working across two tabs,
a value that expires, a three-factor login form.

## Config
- baseUrl: https://seleniumbase.io/realworld/

## Steps
1. Go to https://seleniumbase.io/realworld/signup in this tab
2. Read the demo user name and password shown on the page [as: demo_login]
3. Go to https://seleniumbase.io/realworld/login in this tab
4. Enter the user name and password from {{demo_login}}
5. Open https://seleniumbase.io/realworld/signup in a new tab and switch to it
6. Read the current TOTP code shown on the page [as: totp_code]
7. Close this tab and switch back to the login tab
8. Enter {{totp_code}} as the multi-factor auth code and click Sign in
9. Verify the page shows you are signed in
10. Sign out
