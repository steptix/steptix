---
tags: [api, delegates, e2e]
timeout: 120s
---

# Delegate Mobile Update Test

## Config
- baseUrl: http://localhost:8787

## Parameters
- username: demo@securebank.com
- password: password123
- newMobile: 0499999999

## Steps
1. Navigate to the login page and login with "{{username}}" and "{{password}}"
2. Call GET /api/delegates to retrieve the list of delegates
3. Verify the response contains at least one delegate
4. Update the first delegate's mobile number to "{{newMobile}}" using PUT /api/delegates/:id (include the CSRF token)
5. Verify the PUT response status is 200 and the mobile field is "{{newMobile}}"
6. Navigate to the delegates page and verify the mobile number "{{newMobile}}" is shown in the table
