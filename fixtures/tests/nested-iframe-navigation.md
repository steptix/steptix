---
tags: [smoke, iframe, nested-iframe, e2e]
timeout: 120s
---

# Nested Iframe Navigation Test

## Config
- baseUrl: http://localhost:8787/nested-iframes

## Steps
1. Verify the Wealth Dashboard page header is visible showing "Wealth Dashboard"
2. In the left summary panel (not in an iframe), verify the portfolio total value shows "$142,850.00" and the equity allocation is "52%"
3. Inside the advisor iframe, verify the advisor header shows "Jane Mitchell, CFA" with an "Available" status
4. Inside the chat iframe (nested inside the advisor iframe), verify at least 3 chat messages are visible and the most recent advisor message mentions "rebalancing"
5. Inside the chat iframe, type "What bonds do you recommend?" in the chat input and click Send
6. Inside the chat iframe, verify a new user message appears containing "What bonds do you recommend?"
7. Inside the recommendations iframe (nested inside the advisor iframe), verify there are 3 recommendation cards: one tagged "Rebalance", one tagged "Buy", and one tagged "Hold"
8. Inside the recommendations iframe, click "View Details" on the "Rebalance: Reduce Equities" card and verify the details show a target equity allocation of "47%"
9. Inside the recommendations iframe, click the "Apply" button on the rebalance card and verify a confirmation message "Rebalance order submitted" appears
10. Inside the recommendations iframe, click "View Details" on the "Buy: Vanguard Total Bond ETF (BND)" card and verify the suggested amount is "$7,142.50" and the yield is "4.2%" annual