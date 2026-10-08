---
tags: [survey, section-c, blogger, forms, frames, windows, alerts, waits]
timeout: 600s
---

# 59 H Y R Tutorials: Selenium practice pages

Practice pages on a Blogger site with a long navigation menu. The frames page
nests a form in one frame and a page of buttons in another, and the waits page
adds text fields after a delay.

**Probes:** a registration form with a read-back, frames that each hold a
different page, several windows opened at once, the three alert types,
fields added after a delay.

## Context
- The pages show ads, including a banner anchored to the bottom of the window
  that can sit over the button you need. Close it with its ✕, or scroll the
  button into the middle of the window, then click. An ad is not a failure.

## Config
- baseUrl: https://www.hyrtutorials.com/p/

## Steps
1. Navigate to basic-controls.html
2. Enter first name "Survey" and last name "Tester", choose Female and tick English and Hindi
3. Enter email "survey.tester@example.com" and password "secret", then click Register
4. Verify the page says the registration was successful
5. Navigate to frames-practice.html
6. Type "Steptix" into the name field outside the frames
7. Select "Python" in the course name dropdown inside the first frame
8. Verify the dropdown inside the frame shows "Python"
9. Navigate to window-handles-practice.html
10. Click "Open New Tab" and switch to the tab it opened
11. Capture the current page URL [store as: tab_url]
12. Switch back to the main tab
13. Verify that "{{tab_url}}" is not the window handles practice page
14. Navigate to alertsdemo.html
15. Click the button that shows a prompt box, type "Steptix" and accept it
16. Verify the page shows "Steptix"
17. Navigate to waits-demo.html
18. Click "Add Textbox1" and type "first" into the text box that appears
19. Verify the new text box contains "first"
