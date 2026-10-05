---
tags: [smoke, popup, new-window, e2e]
timeout: 600s
---

# New Window and Tab Navigation Test

## Config
- baseUrl: http://localhost:8787/new-window

## Steps
1. Verify the "Window & Tab Test" page is visible with "Open New Window" and "Open New Tab" buttons
2. Click the "Open New Window" button and verify the status shows "Opened new window (popup)"
3. Switch to the popup window and verify it shows the "Popup Window" heading
4. In the popup window, type "Hello from popup" in the message input and click "Send to Opener"
5. Switch back to the main page and verify the original "Window & Tab Test" heading is still visible
6. Click the "Open New Tab" button and verify the status shows "Opened new tab"
7. Switch to the new tab page showing "Account Summary"
8. Verify the account summary table shows 3 rows with Savings, Checking, and Investment accounts
9. Switch back to the main page and verify the "Window & Tab Test" heading is visible
10. Close the new tab and verify we are back on the main page showing the "Window & Tab Test" heading
11. Switch to the popup window and click the "Close Window" button
12. Verify we are automatically back on the main page showing the "Window & Tab Test" heading
