---
type: test
tags: [demo, sections]
---

# Sections demo

Demonstrates inline sections: a named block of steps defined by a `###`
heading inside `## Steps`, invoked by writing its name as the whole step
text. `Sign in` is invoked twice and its body calls a skill, so the expanded
run carries both a section and a skill badge on those rows.

## Parameters
- username: $LOGIN_USERNAME
- password: $LOGIN_PASSWORD

## Steps
1. Open the demo app
2. Sign in
3. Add the first product to the cart
4. Sign in
5. Verify the order confirmation shows "Thank you"

### Sign in
1. [skill: fill_login_form username="{{username}}" password="{{password}}"]
2. Verify the dashboard greeting is visible
