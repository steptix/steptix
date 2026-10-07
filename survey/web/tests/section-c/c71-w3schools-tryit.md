---
tags: [survey, section-c, code-editor, iframe, cookie-banner]
timeout: 300s
---

# 71 W3Schools Tryit: a code editor and a result iframe

The Tryit editor is a code editor on the left (CodeMirror, not a textarea) and
the rendered result in an iframe on the right. W3Schools also shows a cookie
consent dialog on first visit.

**Probes:** replacing all the text in a rich code editor, a Run button, reading
content inside a result iframe, a consent dialog.

## Config
- baseUrl: https://www.w3schools.com/html/tryit.asp?filename=tryhtml_basic

## Steps
1. Navigate to the baseUrl
2. If a cookie consent dialog is shown, reject the non-essential cookies
3. Replace all of the code in the editor with: <h1 id="greeting">Hello from Steptix</h1><button onclick="this.textContent='Clicked'">Press me</button>
4. Click Run
5. Verify the result frame shows the heading "Hello from Steptix"
6. Click "Press me" in the result frame
7. Verify the button in the result frame now says "Clicked"
