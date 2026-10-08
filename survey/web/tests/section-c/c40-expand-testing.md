---
tags: [survey, section-c, login, inputs, tables, drag-drop, tooltips]
timeout: 900s
---

# 40 Expand Testing: practice pages

Expand Testing is a newer, larger take on The Internet. This test uses the
pages that The Internet lacks or does differently. The login details are
printed on its Test Login page.

**Probes:** login, several HTML input types with a read-back, a paginated and
searchable table, drag and drop onto a target, tooltips that only exist on
hover, elements added and removed by clicks.

## Context
- The site shows Google ads, and now and then a full-screen one that covers the
  whole page after a navigation. Close it with its Close or ✕ button, then
  carry on with the step. An ad is not a failure.

## Config
- baseUrl: https://practice.expandtesting.com/

## Parameters
- username: practice
- password: SuperSecretPassword!

## Steps
1. Navigate to /login
2. Enter the username {{username}} and the password {{password}}, then click Login
3. Verify the page says "You logged into a secure area!"
4. Click Logout
5. Navigate to /inputs
6. Enter 42 in the number input, "survey" in the text input, "secret" in the password input and 2026-01-15 in the date input
7. Click "Display Inputs"
8. Verify the displayed number is 42, the displayed text is "survey" and the displayed date is 2026-01-15
9. Navigate to /dynamic-pagination-table
10. Show All entries per page
11. Search the table for "Female"
12. Count the rows in the table [as: female_rows]
13. Verify that {{female_rows}} is greater than 0
14. Verify every row shown has the gender "Female"
15. Navigate to /drag-and-drop-circles
16. Drag the red circle into the target
17. Drag the green circle into the target
18. Verify the target contains the red and green circles
19. Navigate to /tooltips
20. Hover over the "Tooltip on top" button
21. Verify a tooltip is shown
22. Navigate to /add-remove-elements
23. Click "Add Element" three times
24. Count the Delete buttons [as: delete_count]
25. Verify that {{delete_count}} equals 3
26. Click one of the Delete buttons
27. Verify there are 2 Delete buttons
