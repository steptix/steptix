---
tags: [live-integration]
---

# A tool step runs in the tab the test switched to

A `[tool: ...]` step is handed `page` / `context` / `browser` from the run's
active pointers at the moment the step starts
(`pageTracker.getActive()` in src/server/session-manager.ts). Nothing else
selects a tab for it: there is no argument for one, and `ToolContext` carries
no tracker. So the switch step before it is the whole mechanism.

Nothing asserted that before this file. `tool-end-to-end.test.ts` drives a
real browser but hands the executor a single `page` and builds no
`PageTracker`; `api-server-tools.test.ts` mocks the tracker as
`getActive: () => mockPage`. Both would stay green if the two call sites
passed the session's *main* page instead of its *active* one — and every
tool step in a test that had switched tabs would then silently read the
wrong page.

The SecureBank sign-in is not scenery: it makes this the same authenticated
session the other live fixtures use, so a tool reached through a switched tab
is exercised where a real test would put one.

## How it fails
Steps 9 and 12 are the assertion, and they need no model. `regex_extract`
fails the step when its pattern matches nothing, and the two titles have no
overlap at the anchor:

- new tab   → `SecureBank — New Tab`
- main tab  → `SecureBank — New Window & Tab Test`

So a tool that read the tab it was NOT switched to goes red on the next line,
with the title it actually saw in the message.

## Config
- baseUrl: http://localhost:8787/
- consoleLogLevel: debug
- serverFileLogLevel: off

## Parameters
- username: demo@securebank.com
- password: password123

## Steps
1. Navigate to the baseUrl
2. Reject non-essential cookies in the cookie banner
3. Enter the username {{username}}
4. Enter the password {{password}}
5. Click the Sign in button
6. Navigate to http://localhost:8787/new-window
7. Click "Open New Tab" and switch to the tab it opened
8. [tool: read_page_title out.page_title="tab_title"]
9. [tool: regex_extract text="{{tab_title}}" pattern="New Tab$" out.match="tab_title_confirmed"]
10. Switch back to the main tab
11. [tool: read_page_title out.page_title="main_title"]
12. [tool: regex_extract text="{{main_title}}" pattern="Window & Tab Test$" out.match="main_title_confirmed"]
