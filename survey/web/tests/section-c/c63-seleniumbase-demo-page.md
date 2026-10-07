---
tags: [survey, section-c, inputs, iframe, slider, meter, drag-drop]
timeout: 300s
---

# 63 SeleniumBase demo page: every control, plus an iframe

SeleniumBase's own demo page puts most controls in one table: text, textarea,
a select that drives a progress bar, a slider that drives a meter, radios,
checkboxes (one inside an iframe), drag and drop, and a button that changes
colour.

**Probes:** a select whose choice changes another element, a slider read back
through a meter, a checkbox inside an iframe, drag and drop of an image, a
button whose label changes on click.

## Config
- baseUrl: https://seleniumbase.io/demo_page

## Steps
1. Navigate to the baseUrl
2. Type "Written by Steptix" into the text input and into the textarea
3. Select "Set to 75%" in the dropdown
4. Verify the progress bar label says 75%
5. Move the slider to 100
6. Verify the meter label says 100%
7. Choose radio button 2
8. Tick checkboxes 2 and 4
9. Tick the checkbox inside the iframe
10. Verify the checkbox inside the iframe is ticked
11. Drag the logo image into the drop box
12. Verify the logo is now inside the drop box
13. Click "Click Me (Green)"
14. Verify the button now says "Click Me (Purple)"
