---
tags: [cdp, example]
---

# CDP Example — Drive an already-running Chrome

This test attaches to a Chrome instance you started yourself. It uses your
real profile (cookies, extensions, saved logins) instead of a fresh
Playwright Chromium, so any sites you're already signed in to stay
signed in.

## Prerequisites

Start Chrome with the remote-debugging port flag *before* running this test:

**Windows**

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%USERPROFILE%\chrome-cdp-profile"
```

**macOS**

```
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/chrome-cdp-profile"
```

**Linux**

```
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/chrome-cdp-profile"
```

> Tip: keep this Chrome window running across many test runs. Sign in to the
> sites you test against once, and CDP-mode tests pick up the session
> automatically. You can run multiple Chromes on different ports
> (`--remote-debugging-port=9223`, `9224`, ...) and target each from
> different tests.

## Config

- baseUrl: https://example.com
- cdp: 9222
- cdpTab: new

## `cdpTab` options (uncomment one — only one `cdpTab` line should be active)

- cdpTab: new              — open a fresh tab (default; this is what's used above)
- cdpTab: 0                — attach to the 1st existing tab (zero-indexed)
- cdpTab: 1                — attach to the 2nd existing tab
- cdpTab: url~example.com  — first tab whose URL contains the substring (case-insensitive)
- cdpTab: title~Inbox      — first tab whose title contains the substring (case-insensitive)
- cdpTab: active           — the currently focused tab

If `cdpTab` selects an existing tab, the test leaves it open at the end.
Only `cdpTab: new` opens a tab the harness will close on teardown.

## Steps

1. Verify the Example Domain heading is visible
2. Click the "More information..." link
3. Verify the page navigated to iana.org
