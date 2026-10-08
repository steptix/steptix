---
tags: [survey, section-c, forms, inputs, upload, colour, date, range]
timeout: 300s
---

# 46 Selenium web form: every input type on one page

The Selenium project's own test page. It is the baseline for this section: a
plain page with no ads, no frames and no tricks. If a step fails here, it fails
everywhere.

**Probes:** text, password and textarea fields, a disabled and a read-only
field, a native select, a datalist, a file input, checkboxes and radios, a
colour picker, a date picker, a range slider.

## Config
- baseUrl: https://www.selenium.dev/selenium/web/web-form.html

## Steps
1. Navigate to the baseUrl
2. Enter "Survey" in the text input, "secret" in the password field and "Written by Steptix" in the textarea
3. Verify the disabled input is disabled and the readonly input is read-only
4. Select "Two" in the dropdown (select)
5. Type "San" in the datalist dropdown and choose "San Francisco"
6. Upload file \attachments\notes.txt in the file input
7. Untick the checked checkbox and tick the default checkbox
8. Choose the default radio button
9. Set the colour picker to #00ff00
10. Set the date picker to 01/15/2026
11. Set the range slider to its maximum
12. Verify the dropdown (select) shows "Two"
13. Click Submit
14. Verify the page says "Form submitted" and "Received!"
