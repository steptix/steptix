---
tags: [survey, section-c, primefaces, jsf, datatable, select, alerts, windows]
timeout: 900s
---

# 62 Leafground: PrimeFaces components

Leafground is built with JSF and PrimeFaces, whose markup is unlike modern SPA
frameworks: generated ids like `j_idt107`, hidden native inputs behind styled
widgets, and AJAX partial page updates.

**Probes:** PrimeFaces text inputs and autocompletes, styled selects that hide
a native select, checkboxes drawn over hidden inputs, a sortable and filterable
DataTable, PrimeFaces dialogs and alerts, windows opened by buttons.

## Config
- baseUrl: https://www.leafground.com/

## Steps
1. Navigate to input.xhtml
2. Type "Survey Tester" into the name field
3. Append " Chennai" to the city field
4. Verify the disabled field is disabled
5. Type "Steptix" into the field that has to be cleared first
6. Navigate to select.xhtml
7. Choose "Playwright" as the favourite UI automation tool
8. Choose "India" as the country, then "Chennai" as the city
9. Verify the city shows Chennai
10. Navigate to checkbox.xhtml
11. Tick "Basic" and "Ajax"
12. Verify a message confirms the Ajax checkbox was checked
13. Navigate to table.xhtml
14. Filter the table by the country "India"
15. Verify every row shown has the country India
16. Sort the table by the representative's name
17. Navigate to alert.xhtml
18. Open the confirm dialog and click Cancel
19. Open the sweet alert and dismiss it
20. Navigate to window.xhtml
21. Click "Open" and switch to the window it opened
22. Verify the new window shows the Leafground dashboard
23. Switch back to the main tab
