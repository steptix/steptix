---
tags: [survey, section-c, waits, dynamic-id, aria-table, overlap, visibility]
timeout: 900s
---

# 42 UI Testing Playground: one hard thing per page

Every page on UI Testing Playground is built to break one assumption that test
tools make: stable ids, instant content, unobstructed elements, tables built
from `<table>`. The site serves plain HTTP.

**Probes:** a button whose id changes on every load, a button hidden behind
another, waiting for an AJAX label, waiting for a client-side computation, a
DIV-based ARIA table whose columns move on reload, stopping a progress bar
near a value, text with a non-breaking space, an element covered by another,
a sample login form, a button reached by scrolling inside a box.

## Config
- baseUrl: http://uitestingplayground.com/

## Steps
1. Navigate to /dynamicid
2. Click the button with the dynamic id
3. Navigate to /hiddenlayers
4. Click the green button
5. Verify the green button is now covered by a blue button
6. Navigate to /ajax
7. Click "Button Triggering AJAX Request"
8. Verify the page says "Data loaded with AJAX get request."
9. Navigate to /clientdelay
10. Click "Button Triggering Client Side Logic"
11. Verify the page says "Data calculated on the client side."
12. Navigate to /dynamictable
13. Read the CPU value for Chrome from the table [as: chrome_cpu]
14. Read the value in the yellow label [as: label_text]
15. Verify that "{{label_text}}" says "Chrome CPU: {{chrome_cpu}}"
16. Navigate to /progressbar
17. Click Start, and click Stop as soon as the progress bar reaches 75%
18. Verify the progress bar stopped between 70% and 85%
19. Navigate to /nbsp
20. Click the "My Button" button
21. Navigate to /overlapped
22. Enter "Survey" in the Name field
23. Verify the Name field contains "Survey"
24. Navigate to /textinput
25. Enter "Steptix" in the text field and click the blue button
26. Verify the blue button now says "Steptix"
27. Navigate to /sampleapp
28. Log in with the user name "survey" and the password "pwd"
29. Verify the status says "Welcome, survey!"
30. Navigate to /scrollbars
31. Click the "Hiding Button" in the scrollable area
