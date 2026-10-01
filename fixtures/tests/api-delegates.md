---
tags: [api, delegates, e2e]
timeout: 300s
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
2. Navigate to the delegates page
3. Capture the value of the hidden __RequestVerificationToken input [store as: csrfToken]
4. Call GET /api/delegates to retrieve the list of delegates
5. Verify the response contains at least one delegate
6. Update the first delegate's mobile number to "{{newMobile}}" using PUT /api/delegates/:id with the header x-csrf-token set to "{{csrfToken}}"
7. Verify the status code of the step 6 PUT response equals 200
8. Verify the mobile field in the step 6 PUT response body equals "{{newMobile}}"
9. Reload the delegates page and verify the mobile number "{{newMobile}}" is shown in the table
