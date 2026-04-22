---
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
3. Click Sign in
4. Enter the username {{username}}
5. Enter the password {{password}}
6. Click the Sign in button
2. [interactive]
7. Click logout