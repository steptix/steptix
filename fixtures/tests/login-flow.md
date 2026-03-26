---
tags: [smoke, login, e2e]
timeout: 60s
---

# Login Flow Test

## Config
- baseUrl: http://localhost:8787

## Parameters
- username: demo@securebank.com
- password: password123

## Steps
1. Navigate to the login page and dismiss the cookie banner if visible
2. Login with "{{username}}" and "{{password}}"
3. Verify the dashboard shows a balance greater than $0
4. Click on "Transaction History" and verify at least 3 transactions are listed
5. Logout and verify the login page is displayed
