---
tags: [survey, section-c, autocomplete, alerts, tables, hover, tabs, iframe]
timeout: 600s
---

# 48 Rahul Shetty Academy: Automation Practice

One page with a dozen classic exercises, including a fixed-header table whose
total is printed underneath. The test checks that total by adding up the column
itself.

**Probes:** radio buttons, an autocomplete suggestion list, a native select,
checkboxes, a new tab, an alert that echoes typed text, a confirm, hiding and
showing a field, adding up a table column, a hover menu, an iframe holding a
whole other site.

## Config
- baseUrl: https://rahulshettyacademy.com/AutomationPractice/

## Steps
1. Navigate to the baseUrl
2. Choose Radio2
3. Type "ind" into the suggestion field and choose "India" from the suggestions
4. Verify the suggestion field contains "India"
5. Select "Option3" in the dropdown
6. Tick checkbox Option1 and Option3
7. Type "Steptix" into the name field under "Switch To Alert Example" and click Alert
8. Verify the alert text contains "Steptix", then accept it
9. Click Confirm and dismiss the dialog
10. Click Hide, then verify the text box under "Element Displayed Example" is hidden
11. Click Show, then verify it is visible again
12. Add up the Amount column of the fixed-header web table [as: amount_sum]
13. Read the "Total Amount Collected" value under that table [as: amount_shown]
14. Verify that {{amount_sum}} equals {{amount_shown}}
15. Read the price of the "Master Selenium Automation in simple Python Language" course in the web table [as: course_price]
16. Verify that {{course_price}} equals 25
17. Hover over "Mouse Hover" and click "Top"
18. Click "Open Tab" and switch to the tab it opened
19. Verify the tab shows the Rahul Shetty Academy site
20. Switch back to the main tab
21. Read the heading of the first section inside the iframe [as: iframe_heading]
22. Verify that "{{iframe_heading}}" is not empty
