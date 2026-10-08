---
tags: [survey, section-c, forms, ads, multi-select, upload]
timeout: 300s
---

# 65 Techlistic practice form: a classic form on an ad-heavy blog

The practice form sits in the middle of a Blogger article with a big menu,
sidebars and ads. The form itself is simple. Finding it, and keeping clear of
the page around it, is the test.

**Probes:** a form inside a noisy page, radios that use the same name for
different groups, a multi-select of Selenium commands, an upload, ads and
popups that cover the page.

## Config
- baseUrl: https://www.techlistic.com/p/selenium-practice-form.html

## Steps
1. Navigate to the baseUrl
2. In the practice form, enter first name "Survey" and last name "Tester"
3. Choose Female for gender and 3 for years of experience
4. Enter the date 15/01/2026
5. Tick "Automation Tester" as the profession and "Selenium Webdriver" as the automation tool
6. Select "Europe" in the continents dropdown
7. Select "Navigation Commands" and "Wait Commands" in the Selenium commands list
8. Upload file \attachments\logo.png as the profile picture
9. Verify the first name field contains "Survey" and Europe is selected
10. Click the form's Submit button
