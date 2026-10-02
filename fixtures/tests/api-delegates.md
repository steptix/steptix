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
6. Capture the data-id attribute of the first row in the delegates table [store as: delegateId]
7. Update the mobile number to "{{newMobile}}" using PUT /api/delegates/{{delegateId}} with the header x-csrf-token set to "{{csrfToken}}"
8. Verify the status code of the step 7 PUT response equals "200"
9. Verify the mobile field in the step 7 PUT response body equals "{{newMobile}}"
10. Reload the delegates page and verify the mobile number "{{newMobile}}" is shown in the table
