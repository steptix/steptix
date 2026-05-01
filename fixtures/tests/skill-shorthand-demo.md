---
tags: [smoke, skills]
---

# Skill shorthand demo — bare-identifier parameter passing

Demonstrates the bare-identifier shorthand for `[skill: ...]` invocations.

When the caller variable and the skill parameter share a name, the explicit
form

```
[skill: fill_login_form username="{{username}}" password="{{password}}" out.welcome_text="welcome_text"]
```

can be written as

```
[skill: fill_login_form username password out.welcome_text]
```

Both forms expand identically. The shorthand also asserts at parse time that
`welcome_text` is a declared output of the skill — a typo there will fail
loudly instead of silently leaving an unresolved placeholder downstream.

## Parameters
- username: $LOGIN_USERNAME
- password: $LOGIN_PASSWORD

## Steps
1. Navigate to {{baseUrl}}/login
2. [skill: fill_login_form username password out.welcome_text]
3. Verify the welcome banner reads "{{welcome_text}}"
