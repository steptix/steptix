---
tags: [survey, section-c, blogger, alerts, delays, iframes, multi-select, popup]
timeout: 600s
---

# 54 omayo: odd controls on a 2013 Blogger page

omayo (QAFox) is an old Blogger page of oddities: buttons with the same name,
text that appears and disappears on a timer, a button that enables itself, two
iframes and a popup window.

**Probes:** look-alike buttons, a timed button that enables itself, text that
shows for a few seconds and then disappears, alerts and prompts, a multi-select
box, a table read, a popup window, a dropdown that opens after a delay.

## Config
- baseUrl: https://omayo.blogspot.com/

## Steps
1. Navigate to the baseUrl
2. Replace the text in the first text area with "Written by Steptix"
3. Read the age of Kishore from the table [as: kishore_age]
4. Verify that "{{kishore_age}}" is a number
5. Select "Volvo" and "Audi" in the multi-selection box
6. Click the "ClickToGetAlert" button and accept the alert
7. Click the GetPrompt button, type "Steptix" and accept the prompt
8. Click the "Check this" button and wait until the checkbox next to it is enabled
9. Tick the checkbox next to "Check this"
10. Click the "Try it" button under "TimerEnableButton" and wait until "My Button" is enabled
11. Verify "My Button" is enabled
12. Double-click the "Double click Here" button and accept the alert
13. Click "Open a popup window" and switch to the window it opened
14. Verify the popup window has a heading
15. Switch back to the main tab
16. Click the delayed "Dropdown" button and choose "Gmail" from the menu that appears
