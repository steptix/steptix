---
tags: [survey, section-c, forms, long-form, datepicker, conditional-fields, stop-before-payment]
timeout: 600s
---

# 70 DummyTicket: a long real-world booking form

A real commercial booking form (WooCommerce) with conditional sections: adding
passengers reveals more fields, and choosing a round trip reveals a return
date. The test fills it in and **stops before payment**. It must never place
the order.

**Probes:** a long form, sections that appear depending on earlier answers,
jQuery date pickers, select2-style dropdowns, knowing when to stop.

## Config
- baseUrl: https://www.dummyticket.com/dummy-ticket-for-visa-application/

## Steps
1. Navigate to the baseUrl
2. Choose the dummy ticket for visa application option
3. Enter first name "Survey" and last name "Tester"
4. Set the date of birth to 15 March 1990 and choose Female
5. Tick "Add more passengers", then choose "add 1 more passenger" in the number of additional passengers dropdown
6. Verify the second passenger details section is shown
7. Enter the second passenger's first name "Second" and choose Adult as their type
8. Choose Round trip
9. Verify a return date field is shown
10. Enter "London" as the origin city and "Paris" as the destination city
11. Pick a departure date about one month from today and a return date one week after it
12. Choose "Visa application" as the purpose
13. Verify the order summary shows a total price
14. Stop here without placing the order or entering any payment details
