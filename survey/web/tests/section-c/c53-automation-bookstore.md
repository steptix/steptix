---
tags: [survey, section-c, filter, live-search, lists]
timeout: 300s
---

# 53 Automation Bookstore: a live filter

A one-page bookstore whose list filters as you type. It replaced CosmoCode in
the survey list, whose practice page now redirects to an unrelated site.

**Probes:** a list that changes on every keystroke, counting items that are
hidden rather than removed, reading text off cards, clearing a filter.

## Config
- baseUrl: https://automationbookstore.dev/

## Steps
1. Navigate to the baseUrl
2. Count the books shown [as: all_books]
3. Type "test" into the filter box
4. Count the books shown [as: filtered_books]
5. Verify that {{filtered_books}} is less than {{all_books}}
6. Verify every book shown has "test" in its title, ignoring case
7. Read the titles of the books shown [as: filtered_titles]
8. Clear the filter box
9. Count the books shown [as: books_after_clear]
10. Verify that {{books_after_clear}} equals {{all_books}}
11. Type "zzzz" into the filter box
12. Verify no books are shown
