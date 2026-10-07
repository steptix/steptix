---
tags: [survey, section-c, extraction, pagination, login, js-rendered, infinite-scroll]
timeout: 600s
---

# 67 Quotes to Scrape: extraction across rendering styles

The same ten quotes per page, served in several ways: plain HTML, rendered by
JavaScript, rendered by JavaScript after a delay, and loaded by infinite
scroll. The login accepts any user name and password.

**Probes:** extracting a list, following pagination, filtering by tag, content
that only exists after scripts run, content that arrives late, infinite scroll,
a login that accepts any credentials.

## Config
- baseUrl: https://quotes.toscrape.com/

## Steps
1. Navigate to the baseUrl
2. Read the author of the first quote [as: first_author]
3. Verify that "{{first_author}}" equals "Albert Einstein"
4. Click "Next" twice
5. Verify this is page 3 of the quotes
6. Navigate to /tag/love/
7. Read the authors of every quote on the page [as: love_authors]
8. Verify that {{love_authors}} has 10 entries
9. Navigate to /js/
10. Read the author of the first quote [as: js_author]
11. Verify that "{{js_author}}" equals "Albert Einstein"
12. Navigate to /js-delayed/
13. Wait for the quotes to appear, then read the author of the first quote [as: delayed_author]
14. Verify that "{{delayed_author}}" equals "Albert Einstein"
15. Navigate to /scroll
16. Scroll until at least 30 quotes are shown
17. Count the quotes shown [as: scrolled_quotes]
18. Verify that {{scrolled_quotes}} is at least 30
19. Navigate to /login
20. Log in with the user name "survey" and the password "anything"
21. Verify the page shows a Logout link
22. Click Logout
