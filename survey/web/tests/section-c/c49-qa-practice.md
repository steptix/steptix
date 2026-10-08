---
tags: [survey, section-c, ecommerce, login, iframe, tables, pagination, calendar, upload]
timeout: 900s
---

# 49 QA Practice: forms, tables and a small shop

QA Practice moved from Netlify to its own domain. It has a sidebar of exercises
and a small shop behind a login whose details are shown on the login page. A
couple of its forms are deliberately buggy ("Spot the BUGS").

**Probes:** reading credentials off the page, a shop flow from login to order,
checkboxes, double-click, an iframe, a dynamic table, pagination, a date
picker, file upload, a loader.

## Config
- baseUrl: https://qa-practice.razvanvancea.ro/

## Steps
1. Navigate to /auth_ecommerce.html
2. Read the email and password shown on the page for logging in [as: shop_credentials]
3. Log in with the email and password from {{shop_credentials}}
4. Add two different products to the cart
5. Verify the cart total equals the sum of the two product prices
6. Proceed to checkout, fill in the shipping form with test details and submit the order
7. Verify the page confirms the order
8. Log out
9. Navigate to /checkboxes.html
10. Tick the first and the last checkbox
11. Verify only the first and the last checkboxes are ticked
12. Navigate to /double-click.html
13. Double-click the button
14. Verify the page says the button was double-clicked
15. Navigate to /iframe.html
16. Read the heading inside the iframe [as: iframe_heading]
17. Verify that "{{iframe_heading}}" is not empty
18. Navigate to /pagination.html
19. Go to the last page of results
20. Verify the last page is shown as the current page
21. Navigate to /calendar.html
22. Pick 15 January 2026 in the date picker
23. Verify the date field shows 15 January 2026 in its own format
24. Navigate to /file-upload.html
25. Upload file \attachments\logo.png and submit
26. Verify the page confirms logo.png was uploaded
27. Navigate to /loader.html
28. Wait for the loader to finish
29. Verify the content behind the loader is shown
