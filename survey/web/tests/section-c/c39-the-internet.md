---
tags: [survey, section-c, login, alerts, frames, tabs, upload, hover, keyboard, shadow-dom]
timeout: 900s
---

# 39 The Internet: the classic traps

The Internet is the original automation practice site: one small page per
problem. This test visits the ones that break automation most often. The login
details are printed on its Form Authentication page.

**Probes:** form login, checkbox state, a native select, waiting for content
rendered after a click, JS confirm and prompt dialogs, nested frames, a new
tab, file upload, hover-only content, a key press, shadow DOM, and an HTTP
Basic Auth prompt. The Basic Auth prompt is last, because it is the step most
likely to stop the run.

## Config
- baseUrl: https://the-internet.herokuapp.com/

## Parameters
- username: tomsmith
- password: SuperSecretPassword!

## Steps
1. Navigate to the baseUrl
2. Click "Form Authentication"
3. Enter the username {{username}} and the password {{password}}, then click Login
4. Verify the flash message says "You logged into a secure area!"
5. Click Logout
6. Navigate to /checkboxes
7. Tick checkbox 1 and untick checkbox 2
8. Verify checkbox 1 is checked and checkbox 2 is not checked
9. Navigate to /dropdown
10. Select "Option 2" in the dropdown
11. Verify the dropdown shows "Option 2"
12. Navigate to /dynamic_loading/2
13. Click Start
14. Verify the page says "Hello World!"
15. Navigate to /javascript_alerts
16. Click "Click for JS Confirm" and cancel the dialog
17. Verify the result says "You clicked: Cancel"
18. Click "Click for JS Prompt", type "steptix" into the prompt and accept it
19. Verify the result says "You entered: steptix"
20. Navigate to /nested_frames
21. Read the text of the middle frame in the top row [as: middle_text]
22. Verify that "{{middle_text}}" equals "MIDDLE"
23. Navigate to /windows
24. Click "Click Here" and switch to the tab it opened
25. Verify the page heading says "New Window"
26. Switch back to the main tab
27. Navigate to /upload
28. Upload file \attachments\notes.txt with the file chooser, then click Upload
29. Verify the page says "File Uploaded!" and shows notes.txt
30. Navigate to /hovers
31. Hover over the second user picture
32. Verify the caption says "name: user2"
33. Navigate to /key_presses
34. Click the input box and press the Tab key
35. Verify the result says "You entered: TAB"
36. Navigate to /shadowdom
37. Verify the page shows the text "Let's have some different text!"
38. Navigate to /basic_auth and sign in to the browser's authentication prompt as admin with password admin
39. Verify the page says "Congratulations! You must have the proper credentials."
