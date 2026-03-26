---
tags: [smoke]
---

# Example Login Test

## Config
- baseUrl: http://localhost:3000

## Parameters
- email: demo@example.com
- password: $TEST_PASSWORD

## Steps
1. Navigate to the login page
2. Enter "{{email}}" in the email field
3. Enter "{{password}}" in the password field
4. Click the Sign In button
5. Assert that the dashboard page is visible with a welcome message
