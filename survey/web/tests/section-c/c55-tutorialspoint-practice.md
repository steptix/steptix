---
tags: [survey, section-c, forms, dependent-select, tables, alerts, frames]
timeout: 600s
---

# 55 Tutorialspoint practice: a DemoQA look-alike in plain HTML

Tutorialspoint copies DemoQA's layout as server-rendered pages. That makes it a
useful pair with test 41: the same tasks on a different stack.

**Probes:** a registration form with a state and city pair, a date input, a
web table where rows are added and removed, alerts, frames.

## Config
- baseUrl: https://www.tutorialspoint.com/selenium/practice/

## Steps
1. Navigate to selenium_automation_practice.php
2. Enter name "Survey Tester", email "survey.tester@example.com", gender Female and mobile "0123456789"
3. Enter the date of birth 15/03/1990
4. Enter the subject "Maths" and tick the Reading hobby
5. Upload file \attachments\logo.png as the picture
6. Enter the current address "1 Test Street"
7. Choose the state "Uttar Pradesh" and then the city "Lucknow"
8. Verify the city dropdown shows Lucknow
9. Navigate to webtables.php
10. Search the table for "Alden"
11. Verify the table shows the row for Alden and no row for Cierra
12. Clear the search box
13. Verify the table has a row for Cierra again
14. Navigate to alerts.php
15. Click the button that shows a confirm box, and dismiss it
16. Click the button that shows a prompt box, type "Steptix" and accept it
17. Navigate to frames.php
18. Read the heading inside the first frame [as: frame_heading]
19. Verify that "{{frame_heading}}" is not empty
