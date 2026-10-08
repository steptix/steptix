---
tags: [survey, section-c, delays, popups, sliders, tables, iframes, forms, hover]
timeout: 600s
---

# 57 Practice Automation: one page per control type

A WordPress site with a page per control type and a WordPress comment form
under each one, which a test must not fill by mistake.

**Probes:** a countdown before content appears, alert, confirm and prompt
popups, a slider set to an exact value, reading a table, an iframe, a form
whose submit shows an alert, a hover reveal.

## Config
- baseUrl: https://practice-automation.com/

## Steps
1. Navigate to /javascript-delays/
2. Click Start and wait for the countdown to finish
3. Verify the page says "Liftoff!"
4. Navigate to /popups/
5. Open the confirm popup and click Cancel
6. Verify the page says Cancel was clicked
7. Open the prompt popup, type "Steptix" and accept it
8. Verify the page shows "Steptix"
9. Navigate to /slider/
10. Set the slider to 75
11. Verify the slider value shows 75
12. Navigate to /tables/
13. Read the price of Oranges from the simple table [as: orange_price]
14. Verify that "{{orange_price}}" contains "$"
15. Navigate to /hover/
16. Hover over the "Mouse over me" text
17. Verify the text changes to say you hovered
18. Navigate to /form-fields/
19. In the practice form (not the comment form at the bottom), enter name "Survey Tester" and password "secret"
20. Tick "Water" and "Coffee" under favourite drink, and choose "Blue" as favourite colour
21. Select "Yes" for whether you like automation
22. Enter email "survey.tester@example.com" and message "Written by Steptix"
23. Submit the practice form and accept the alert that appears
