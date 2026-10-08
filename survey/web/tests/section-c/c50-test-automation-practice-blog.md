---
tags: [survey, section-c, blogger, forms, tables, pagination, alerts, svg, shadow-dom, slider]
timeout: 900s
---

# 50 Test Automation Practice blog: everything on one Blogger page

A Blogger page that crams a data-entry form, three kinds of table, alerts,
tabs, drag and drop, a slider, SVG shapes and shadow DOM into one long scroll,
inside Blogger's own markup. The page is long, so the snapshot sent to the
model is large.

**Probes:** a long form with a multi-select and a date range, reading a static
table, choosing rows in a paginated table, all three alert types, a popup
window, double-click copying text, drag and drop, a jQuery slider, a button
that toggles its label, SVG shapes, shadow DOM.

## Config
- baseUrl: https://testautomationpractice.blogspot.com/

## Steps
1. Navigate to the baseUrl
2. Fill in the Data Entry Form with name "Survey Tester", email "survey.tester@example.com", phone "0123456789" and address "1 Test Street"
3. Choose Female, tick Monday and Friday, and select "Japan" as the country
4. Select "Red" and "Green" in the Colors list
5. Read the price of the book "Master In Selenium" from the static web table [as: book_price]
6. Verify that {{book_price}} equals 3000
7. Count the books by the author "Mukesh" in the static web table [as: mukesh_books]
8. Verify that {{mukesh_books}} equals 2
9. In the Pagination Web Table, go to page 3 and tick the first product on it
10. Verify the first product on page 3 is ticked
11. Click "Simple Alert" and accept the alert
12. Click "Prompt Alert", type "Steptix" and accept it
13. Verify the page says "Hello Steptix! How are you today?"
14. Double-click "Copy Text"
15. Verify field 2 now contains the same text as field 1
16. Drag the "Drag me to my target" box onto the "Drop here" box
17. Verify the target says "Dropped!"
18. Click the START button
19. Verify the button now says STOP
20. Count the shapes in the SVG Elements section [as: svg_shapes]
21. Verify that {{svg_shapes}} equals 3
22. Read the text inside the ShadowDOM section [as: shadow_text]
23. Verify that "{{shadow_text}}" is not empty
