---
tags: [survey, section-c, forms, datepicker, autocomplete, modal, windows, drag-drop]
timeout: 600s
---

# 47 Formy: Bootstrap components

Formy is a small Bootstrap site with one page per component and a complete web
form. Its autocomplete is backed by the Google Places widget.

**Probes:** a Bootstrap form with a date picker, a Places autocomplete, a
Bootstrap modal, switching to a new window, drag and drop, enabled and disabled
fields.

## Config
- baseUrl: https://formy-project.herokuapp.com/

## Steps
1. Navigate to /form
2. Enter first name "Survey", last name "Tester" and job title "QA Engineer"
3. Choose "College" for highest level of education and tick "Prefer not to say" for sex
4. Select "2-4" for years of experience
5. Set the date to 01/15/2026 using the date picker
6. Click Submit
7. Verify the page says "The form was successfully submitted!"
8. Navigate to /autocomplete
9. Type "1600 Amphitheatre" into the address field and pick the first suggestion
10. Verify the address field contains "Amphitheatre"
11. Navigate to /modal
12. Open the modal
13. Verify the modal is shown
14. Close the modal with its Close button
15. Navigate to /switch-window
16. Click "Open new tab" and switch to the tab it opened
17. Verify the page heading says "Welcome to Formy"
18. Switch back to the main tab
19. Navigate to /dragdrop
20. Drag the Selenium logo into the box
21. Verify the box says "Dropped!"
22. Navigate to /enabled
23. Verify the first input is disabled
24. Type "enabled" into the enabled input
