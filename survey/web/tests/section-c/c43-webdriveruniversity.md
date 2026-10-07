---
tags: [survey, section-c, tabs, forms, ajax, actions, todo]
timeout: 900s
---

# 43 WebdriverUniversity: small apps behind new tabs

WebdriverUniversity's home page opens every exercise in a new tab, so the test
has to follow the tab before it can do anything. The exercises are small apps
rather than single controls.

**Probes:** a link that opens a new tab, a contact form with validation, a JS
alert on a failed login, dropdowns and radios, waiting for a loader to clear,
drag and drop, double-click, hover menus, adding and removing to-do items.

## Config
- baseUrl: https://webdriveruniversity.com/

## Steps
1. Navigate to the baseUrl
2. Click "CONTACT US" and switch to the tab it opened
3. Enter first name "Survey", last name "Tester" and comments "Testing the contact form", leave the email address empty, then click SUBMIT
4. Verify the page shows an error about an invalid email address
5. Navigate to https://webdriveruniversity.com/Contact-Us/contactus.html
6. Enter first name "Survey", last name "Tester", email "survey.tester@example.com" and comments "Testing the contact form", then click SUBMIT
7. Verify the page says "Thank You for your Message!"
8. Navigate to https://webdriveruniversity.com/Login-Portal/index.html
9. Log in with the user name "nobody" and the password "wrong", and accept the alert that appears
10. Navigate to https://webdriveruniversity.com/Dropdown-Checkboxes-RadioButtons/index.html
11. Select "Python" in the first dropdown
12. Tick "Option 3" and choose the "Purple" radio button
13. Verify the first dropdown shows Python, Option 3 is ticked and Purple is selected
14. Navigate to https://webdriveruniversity.com/Ajax-Loader/index.html
15. Wait for the loader to finish, then click "CLICK ME!"
16. Verify a dialog says "Well Done For Waiting....!!!"
17. Close the dialog
18. Navigate to https://webdriveruniversity.com/Actions/index.html
19. Drag the "DRAG ME TO MY TARGET!" box onto the "DROP HERE!" box
20. Verify the target says "Dropped!"
21. Double-click the "Double Click Me!" box
22. Hover over "Hover Over Me First!" and click the link that appears
23. Accept the alert that appears
24. Navigate to https://webdriveruniversity.com/To-Do-List/index.html
25. Add the to-do item "Write survey report"
26. Verify the list contains "Write survey report"
27. Delete the to-do item "Write survey report"
28. Verify the list no longer contains "Write survey report"
