tags: [smoke]
---

# GitHub Login Test

## Config
- baseUrl: https://github.com/

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
