tags: [smoke]
---

# GitHub Login Test

## Config
- baseUrl: https://github.com/
- consoleLogLevel: debug
- serverFileLogLevel: off



## Parameters
- username: $GITHUB_USERNAME
- password: $GITHUB_PASSWORD

## Steps
1. Navigate to the baseUrl
2. Click Sign in
3. Enter the username {{username}}
4. Enter the password {{password}}
5. Click the Sign in button
6. Get a list of the names of the top repositories on the left panel [as: repos]
7. [tool: print_all repos]
8. Click logout
9. Click "Sign out" button

<!-- latest-runs:start -->
## Latest runs

- [2026-05-04 07:36:03Z — passed](file:///C:/Projects/vibe/ai-ui-automation/reports/2026-05-04_07-36-03-github-login-test.html)
<!-- latest-runs:end -->
