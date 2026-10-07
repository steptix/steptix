---
tags: [survey, section-c, forms, delays, iframes, drag-drop, shadow-dom, autosuggest]
timeout: 600s
---

# 56 QAVBox demo: a sign-up form and nine small pages

QAVBox is a GitHub Pages site whose home page is a short menu. The test opens
each page from that menu.

**Probes:** a sign-up form with a multi-select and an upload, a web table,
an iframe, alerts, delayed content, drag and drop, shadow DOM, auto-suggestions.

## Config
- baseUrl: https://qavbox.github.io/demo/

## Steps
1. Navigate to the baseUrl
2. Click "SignUp Form"
3. Enter full name "Survey Tester", email "survey.tester@example.com" and telephone "0123456789"
4. Choose "Male" as the gender, pick an experience level and tick two skills
5. Select two tools in the tools list
6. Upload file \attachments\notes.txt
7. Submit the form
8. Verify the page confirms the submission
9. Navigate to the baseUrl
10. Click "Delay"
11. Click the button that loads the delayed text, and wait for the text to appear
12. Verify the delayed text is shown
13. Navigate to the baseUrl
14. Click "DragnDrop"
15. Drag the draggable box onto the drop target
16. Verify the drop target says it received the drop
17. Navigate to the baseUrl
18. Click "Shadow DOM"
19. Type "Steptix" into the field inside the shadow root
20. Navigate to the baseUrl
21. Click "Auto Suggestions"
22. Type "Ind" and choose "India" from the suggestions
23. Verify the field contains "India"
