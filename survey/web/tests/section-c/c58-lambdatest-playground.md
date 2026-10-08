---
tags: [survey, section-c, forms, tables, progress, drag-drop, sliders, ajax]
timeout: 900s
---

# 58 LambdaTest Selenium Playground: about thirty widgets

LambdaTest's playground sits inside a busy marketing site with a large header
menu, so locating the right element starts with ignoring the page around it.

**Probes:** a simple form with a read-back, adding two numbers, checkboxes,
a select, an AJAX form submit, a download progress bar, a searchable table,
sliders set to exact values, drag and drop.

## Config
- baseUrl: https://www.lambdatest.com/selenium-playground/

## Steps
1. Navigate to simple-form-demo
2. Enter "Steptix survey" in the message field and click "Get Checked Value"
3. Verify the "Your Message" area shows "Steptix survey"
4. Enter 12 as the first value and 30 as the second value, then click "Get Sum"
5. Verify the result is 42
6. Navigate to checkbox-demo
7. Click "Check All"
8. Verify every checkbox in the multiple-checkbox section is ticked
9. Navigate to select-dropdown-demo
10. Select "Wednesday" in the day dropdown
11. Verify the page says the selected day is Wednesday
12. Navigate to ajax-form-submit-demo
13. Enter name "Survey Tester" and comment "Written by Steptix", then submit
14. Verify the page shows the form was submitted
15. Navigate to jquery-download-progress-bar-demo
16. Start the download and wait until it completes
17. Verify the page says the download is complete
18. Navigate to table-search-filter-demo
19. Search the tasks table for "Testing"
20. Verify the tasks table shows exactly one row, and it mentions Testing
21. Navigate to drag-drop-range-sliders-demo
22. Set the first slider to 95
23. Verify the first slider's output shows 95
24. Navigate to drag-and-drop-demo
25. Drag "Draggable 1" onto the drop zone
26. Verify the dropped items list shows "Draggable 1"
