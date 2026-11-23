---
tags: [live-integration, aria]
---

# Aria snapshot — edge-case widgets

Fixture for `aria-edge-cases.test.cjs`. Every widget lives on
`fixtures/test-app/aria-edge-cases.html`: a notice mounted on `<html>`, an
open shadow nickname, a closed shadow device label, a styled checkbox, a
moving progress bar, a sortable list, a toast that removes itself, and a
field the support bar covers until it is dismissed. The saved vault
passphrase is on the page so the recording can be checked for masking; no
step reads it.

## Config
- baseUrl: http://localhost:8787

## Steps
1. Navigate to aria-edge-cases.html?stepMs=120&toastMs=1500
2. Click Acknowledge on the session security notice
3. Verify the page says "Security notice: Acknowledged"
4. Type "Travel card" into Card nickname and click Save nickname
5. Verify the page says "Card nickname: Travel card"
6. Click the trusted device label, type "Desk key", and verify the page says "Trusted device: Desk key"
7. Click Instant SMS alerts
8. Verify the page says "Instant SMS alerts: On"
9. Click Start export, wait until the audit export progress reaches at least 75, then click Stop export
10. Verify the export status says Stopped
11. Drag Card payments below International wires
12. Verify the priority order starts with International wires
13. Click Send test alert
14. Verify the page says "Alerts sent: 1"
15. Click Dismiss help bar
16. Type "Lisbon" into Travel destination note
17. Verify the page says "Travel note: Lisbon"
