---
tags: [survey, section-c, forms, alerts, synchronisation, canvas, storage]
timeout: 900s
---

# 45 Test Pages (EvilTester): forms, timing and canvas

Alan Richardson's Test Pages is a large catalogue reached from a side menu. The
test finds each page by its menu label, because the URLs have moved between
versions of the site.

**Probes:** a server-checked HTML form with a read-back page, alerts that are
not JavaScript alerts, buttons that appear one after another, a button that
grows until it can be clicked, a canvas you draw on, a table read.

## Config
- baseUrl: https://testpages.eviltester.com/

## Steps
1. Navigate to the baseUrl
2. Open the "HTML Form" page from the menu
3. Enter user name "survey", password "secret" and comment "Steptix survey"
4. Tick checkbox 1, choose radio 3, select "Drop Down Item 4" in the dropdown, then submit
5. Verify the results page shows the user name "survey" and the comment "Steptix survey"
6. Navigate to the baseUrl
7. Open the "Alerts - JavaScript" page from the menu
8. Show the confirm box and accept it
9. Verify the page says the confirm returned true
10. Show the prompt box, enter "steptix" and accept it
11. Verify the page shows "steptix" as the prompt result
12. Navigate to the baseUrl
13. Open the "Dynamic Buttons 01" page from the menu
14. Click each button as it appears, in order, until the page says all buttons were clicked
15. Navigate to the baseUrl
16. Open the "Auto Grow Button" page from the menu
17. Wait until the button is big enough to click, then click it
18. Verify the page says the button was clicked
19. Navigate to the baseUrl
20. Open the "HTML Tag - Table" page from the menu
21. Read every name in the first table [as: table_names]
22. Verify that {{table_names}} has at least 2 entries
23. Navigate to the baseUrl
24. Open the "Canvas Draw" page from the menu
25. Draw a line across the middle of the canvas
26. Verify the canvas is no longer blank
