---
tags: [survey, section-c, react, tables, tree, dynamic, practice-form, login]
timeout: 900s
---

# 41 DemoQA: React widgets and the Book Store

DemoQA is a React app full of the controls that real React apps use, which
plain HTML practice sites lack. Its pages carry heavy ads.

The last section signs in to the Book Store. Create the account at
https://demoqa.com/register and put it in `.env` as `DEMOQA_USERNAME` and
`DEMOQA_PASSWORD`. Registration has a reCAPTCHA, so a person has to do it.

**Probes:** an expandable checkbox tree, a disabled radio, editing a row in a
web table, double-click and right-click, a button enabled after a delay, a
React date picker, react-select dropdowns that depend on each other, a modal
result, ads covering content, login.

## Config
- baseUrl: https://demoqa.com/

## Parameters
- bookstore_user: $DEMOQA_USERNAME
- bookstore_password: $DEMOQA_PASSWORD

## Steps
1. Navigate to /checkbox
2. Expand the whole tree
3. Tick "Notes" and "Angular"
4. Verify the result says "You have selected" and lists notes and angular
5. Navigate to /radio-button
6. Choose "Impressive"
7. Verify the result says "You have selected Impressive"
8. Verify the "No" option is disabled
9. Navigate to /webtables
10. Edit the row for Cierra so that her salary is 12345
11. Verify the row for Cierra shows salary 12345
12. Delete the row for Alden
13. Verify the table has no row for Alden
14. Navigate to /buttons
15. Double-click the "Double Click Me" button
16. Verify the page says "You have done a double click"
17. Right-click the "Right Click Me" button
18. Verify the page says "You have done a right click"
19. Navigate to /dynamic-properties
20. Wait until the "Will enable 5 seconds" button is enabled, then click it
21. Navigate to /automation-practice-form
22. Fill in first name "Survey", last name "Tester", email "survey.tester@example.com", gender Other and mobile 0123456789
23. Set the date of birth to 15 March 1990 using the date picker
24. Add the subject "Maths"
25. Choose the state "NCR" and then the city "Delhi"
26. Submit the form
27. Verify the confirmation dialog says "Thanks for submitting the form" and shows the name "Survey Tester"
28. Close the confirmation dialog
29. Book Store login

### Book Store login
1. Navigate to /login
2. Enter the username {{bookstore_user}} and the password {{bookstore_password}}, then click Login
3. Verify the page shows the user name {{bookstore_user}}
4. Search the books for "Git"
5. Verify the book list shows "Git Pocket Guide"
6. Click "Log out"
