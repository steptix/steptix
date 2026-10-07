---
tags: [survey, section-c, accordion, calculator, loader, popups, predictive-search, tables]
timeout: 600s
---

# 61 automationtesting.co.uk: the testing arena

A set of pages from the author of WebdriverUniversity, with a left-hand menu.
The calculator is a set of buttons rather than input fields, so the test has to
press keys in order.

**Probes:** an accordion, a button calculator, a loader that blocks the page, a
JS popup, predictive search, a table read, hidden elements.

## Config
- baseUrl: https://www.automationtesting.co.uk/

## Steps
1. Navigate to accordion.html
2. Expand the second accordion section
3. Verify the second section's text is visible
4. Navigate to calculator.html
5. Press 1, 2, +, 3, 0, = on the calculator
6. Verify the display shows 42
7. Navigate to loader.html
8. Wait for the loader to disappear, then click the button it was covering
9. Navigate to popups.html
10. Trigger the alert popup and accept it
11. Navigate to predictive.html
12. Type "Un" into the search field and choose "United Kingdom" from the suggestions
13. Verify the search field contains "United Kingdom"
14. Navigate to tables.html
15. Read the last row of the first table [as: last_row]
16. Verify that "{{last_row}}" is not empty
17. Navigate to hiddenElements.html
18. Count the elements on the page that are hidden from view [as: hidden_count]
19. Verify that {{hidden_count}} is greater than 0
