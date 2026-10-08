---
tags: [survey, section-c, forms, json, read-back]
timeout: 300s
---

# 69 httpbin form: submit and check the echo

httpbin's pizza order form posts to an endpoint that echoes back every field as
JSON. That makes it the cleanest check that what Steptix typed is what got
sent, with no app logic in between.

**Probes:** an unstyled form, a time input, checkboxes with one shared name,
reading values out of a JSON page.

## Config
- baseUrl: https://httpbin.org/forms/post

## Steps
1. Navigate to the baseUrl
2. Enter customer name "Survey Tester", telephone "0123456789" and email "survey.tester@example.com"
3. Choose the Large pizza size and tick Bacon and Mushroom
4. Set the preferred delivery time to 19:30
5. Enter delivery instructions "Ring twice"
6. Click "Submit order"
7. Verify the JSON response shows custname "Survey Tester" and size "large"
8. Verify the JSON response lists both bacon and mushroom as toppings
9. Verify the JSON response shows delivery "19:30" and comments "Ring twice"
