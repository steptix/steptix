---
tags: [survey, section-c, iframes, jquery-ui, drag-drop, datepicker, tabs, progress]
timeout: 900s
---

# 52 GlobalSQA demo site: jQuery UI inside iframes

Every GlobalSQA widget demo puts a jQuery UI sample inside an iframe, and most
pages have several tabs, each with its own iframe. The pages also carry ads.

**Probes:** picking the right tab and then the right iframe, drag and drop
inside an iframe, a date picker inside an iframe, a progress bar dialog,
sortable lists, an alert box demo.

## Config
- baseUrl: https://www.globalsqa.com/demo-site/

## Steps
1. Navigate to /draganddrop/
2. In the Photo Manager tab, drag the "High Tatras" photo into the trash
3. Verify the trash now holds "High Tatras" and the gallery no longer does
4. Navigate to /datepicker/
5. In the Simple Date Picker tab, pick the 15th of next month
6. Verify the date field holds a date on the 15th
7. Navigate to /progress-bar/
8. In the Download Manager tab, click "Start Download"
9. Wait until the dialog says "Complete!"
10. Close the download dialog
11. Navigate to /sorting/
12. In the Portlets tab, drag the "Shopping" portlet to the top of its column
13. Verify "Shopping" is now the first portlet in its column
14. Navigate to /select-dropdown-menu/
15. Select "India" in the country dropdown
16. Verify the dropdown shows India
