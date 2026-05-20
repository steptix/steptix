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
7. [tool: print_all items="{{repos}}"]
8. Click logout
9. Click "Sign out" button
