---
tags: [smoke]
---

# SecureBank Login Test

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
6. Click "Transaction History"
7. Get a list of the transaction descriptions [as: transactions]
8. [tool: print_all items="{{transactions}}"]
9. Click "Sign out"
