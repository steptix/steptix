---
type: skill
---

# fill_login_form

Reusable login-form flow. Fills the username and password fields and submits
the form. Exposes the rendered welcome banner text as an output so callers
can assert against it.

## Parameters
- username: the username to type into the username field
- password: the password to type into the password field

## Outputs
- welcome_text: the visible text of the dashboard welcome banner

## Steps
1. Type "{{username}}" into the username field
2. Type "{{password}}" into the password field
3. Click the Sign in button and verify the dashboard loads
4. Capture the visible text of the welcome banner [store as: welcome_text]
