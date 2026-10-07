---
tags: [survey, section-c, forms, alerts, tables, datalist]
timeout: 300s
---

# 60 Try Testing This: one dense page

A single page with three layouts packed together: an alert button, a
double-click photo, a login form, a long form and a table.

**Probes:** a dense page where labels sit far from their inputs, a datalist
autocomplete, colour, date, range and number inputs, a multi-select, reading
a table row by a value in it.

## Config
- baseUrl: https://trytestingthis.netlify.app/

## Steps
1. Navigate to the baseUrl
2. Click "Your Sample Alert Button!" and accept the alert
3. Double-click the "Double-click me" button
4. Enter first name "Survey" and last name "Tester" in the sample form, and choose Other for gender
5. Select "Option 2" in the "Choose an option" dropdown
6. Select "Option 1" and "Option 3" in the "Choose multiple options" list
7. Tick "Option 2" under "Choose applicable options"
8. Type "Str" in the autocomplete field and choose "Strawberry" from the suggestions
9. Set the favourite colour to #ff0000, the date to 2026-01-15 and the quantity to 3
10. Enter "Written by Steptix" in the long message field
11. Submit the form
12. Navigate to the baseUrl
13. Read the occupation of the person with the first name "Clark" from the sample table [as: clark_job]
14. Verify that "{{clark_job}}" is not empty
