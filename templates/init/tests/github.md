tags: [smoke]
---

# GitHub Login Test

## Config
- baseUrl: https://github.com/
- consoleLogLevel: debug
- serverFileLogLevel: full

## Parameters
- username: $GITHUB_USERNAME
- password: $GITHUB_PASSWORD

## Steps
1. Navigate to the baseUrl
2. Click Sign in
3. Enter the username {{username}}
4. Enter the password {{password}}
5. Click the Sign in button
6. [interactive]
7. Click logout
8. Click "Sign out" button

<!-- latest-runs:start -->
## Latest runs

- [2026-04-29 02:57:48Z — passed](file:///C:/Projects/vibe/ai-ui-automation/reports/2026-04-29_02-57-48-github-login-test.html)
<!-- latest-runs:end -->
