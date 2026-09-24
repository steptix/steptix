---
tags: [live-integration]
---

# [use ai] live test

Fixture for the live `[use ai]` test (stories/use-ai-step.md, Tests → Live).
Steps 2 and 3 ask the model for a value with no page in sight: step 2 names it
in the author's own words ("store it in random_name"), step 3 pins the name
with `[store as:]`. Step 4 joins the two into an email address, step 5 types it
into the sign-in page's Email address field, and step 6 reads it back. Step 7
uses a placeholder nothing ever sets, so it fails before any model call, and
its `otherwise continue` tail makes that failure amber. Step 8 is there to
prove the run carried on.

The cache is on and the live test runs this file twice. The page steps replay
from the cache on the second run. The `[use ai]` steps ask the model again,
every time, and never touch the cache.

Today's date comes from `{{today}}` on purpose: the model is told nothing the
step does not say, so the step has to say what today is.

## Config
- baseUrl: http://localhost:8787/
- cache: on

## Parameters
- today: 2026-09-24

## Steps
1. Navigate to the baseUrl
2. [use ai] Create a name starting with "AUTO" and ending with a random 4 digit number and store it in random_name
3. [use ai] Today is {{today}}. Give the date 3 days later formatted as yyyymmdd [store as: days_from_now]
4. Set {{login_name}} to "{{random_name}}-{{days_from_now}}@example.com"
5. Enter {{login_name}} in the Email address field
6. Read the value of the Email address field [store as: typed_back]

<!-- Step 7 FAILS ON PURPOSE. Nothing in this test sets nobody_set_this, so
     the step must fail before the model is asked, and its "otherwise
     continue" tail must turn that failure amber so the run goes on to step 8. -->

7. [use ai] Greet {{nobody_set_this}} and store it in greeting otherwise continue with warning "no greeting"
8. Verify the page title contains "Sign In"
