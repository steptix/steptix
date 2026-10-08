---
tags: [survey, section-c, forms, math-captcha, big-page]
timeout: 600s
---

# 51 Ultimate QA: forms and a very big page

Ultimate QA's practice pages run on a WordPress theme. One of the forms has a
small arithmetic challenge ("3 + 9 = ?") that the test has to solve. It is an
exercise built into the page, not a real CAPTCHA.

**Probes:** two identical forms on one page (picking the right one), solving an
arithmetic challenge read off the page, a page with hundreds of elements with
look-alike labels, simple elements located by their visible text.

## Config
- baseUrl: https://ultimateqa.com/

## Steps
1. Navigate to /filling-out-forms/
2. In the left-hand form, enter name "Survey Tester" and message "Left form", then submit it
3. Verify the left-hand form says thanks for contacting
4. In the right-hand form, enter name "Survey Tester" and message "Right form"
5. Solve the arithmetic question shown in the right-hand form and enter the answer
6. Submit the right-hand form
7. Verify the right-hand form says the message was sent or says thanks
8. Navigate to /simple-html-elements-for-automation/
9. Choose the "Female" radio button and tick "I have a car"
10. Select "Audi" in the dropdown
11. Read the salary in the "Software Development Engineer in Test" row of the HTML table with no id [as: sdet_salary]
12. Verify that "{{sdet_salary}}" is not empty
13. Navigate to /complicated-page/
14. Count the buttons in the "Section of Buttons" section [as: button_count]
15. Verify that {{button_count}} is greater than 10
16. Click the fourth button in that section
