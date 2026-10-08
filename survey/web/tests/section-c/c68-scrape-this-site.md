---
tags: [survey, section-c, extraction, search, ajax, iframes]
timeout: 600s
---

# 68 Scrape This Site: search, AJAX and iframes

A sandbox built for scraping lessons, with four pages that each serve their
data a different way.

**Probes:** reading one value out of 250 repeated cards, a search form with
paginated results, data loaded by AJAX when a year is clicked, content inside
an iframe.

## Config
- baseUrl: https://www.scrapethissite.com/pages/

## Steps
1. Navigate to simple/
2. Read the capital of Andorra [as: andorra_capital]
3. Verify that "{{andorra_capital}}" equals "Andorra la Vella"
4. Navigate to forms/
5. Search the teams for "New York"
6. Verify every team shown has "New York" in its name
7. Read the number of wins of the New York Rangers in 1990 [as: rangers_wins]
8. Verify that "{{rangers_wins}}" is a number
9. Navigate to ajax-javascript/
10. Click the year 2015
11. Wait for the films table to load
12. Read the title of the film marked as Best Picture [as: best_picture]
13. Verify that "{{best_picture}}" equals "Spotlight"
14. Navigate to frames/
15. Click "Learn More" for the first turtle family inside the frame
16. Verify the frame shows details of that turtle family
