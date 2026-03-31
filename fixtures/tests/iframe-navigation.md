---
tags: [smoke, iframe, e2e]
timeout: 120s
---

# Iframe Cross-Frame Navigation Test

## Config
- baseUrl: http://localhost:8787/iframes

## Steps
1. Verify 3 iframes are visible: a top banner, a left sidebar, and a main content area
2. In the top banner iframe, verify the "Accounts" link is active and "Payments" and "Support" links are also present
3. In the sidebar iframe, verify the "Overview" option is highlighted and "Savings Account", "Checking Account", and "Credit Card" options are listed
4. In the main content iframe, verify the Account Overview page is shown with a "Total Balance" stat card displaying "$24,582.90"
5. In the main content iframe, click the "View All Accounts" button and verify a table appears showing 3 accounts: Savings Plus, Everyday Checking, and Platinum Card
6. In the top banner iframe, click the "Payments" link
7. Verify the sidebar iframe now shows payment options: "Transfer Money", "Pay Bills", and "Scheduled Payments"
8. Verify the main content iframe now shows the "Transfer Money" page with a form containing "From Account" and "To Account" fields
9. In the main content iframe, select "External Account" in the "To Account" dropdown and verify that BSB and Account Number fields appear
10. In the sidebar iframe, click "Pay Bills"
11. In the main content iframe, verify the Pay Bills page shows a table with at least 3 billers each having a "Pay Now" button
12. In the main content iframe, click the "Pay Now" button for "Electric Company" and verify a success message appears confirming the payment of $142.00
13. In the top banner iframe, click the "Support" link
14. In the sidebar iframe, click "FAQs"
15. In the main content iframe, click the "How do I reset my password?" question and verify the answer text appears mentioning "Forgot Password"
16. In the sidebar iframe, click "Report Issue"
17. In the main content iframe, select "Transaction Dispute" as the category, set priority to "High", enter "Unauthorized charge on Mar 28" as the description, and click "Submit Report"
18. Verify a success message appears with a ticket number starting with "TKT-"
