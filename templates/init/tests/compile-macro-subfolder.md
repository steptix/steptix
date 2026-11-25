---
tags: [live-integration]
---

# Compile subfolder-macro live test

Fixture for the live compile test (stories/skills-in-subfolders.md). Step 1
is the test's own; step 2 invokes a macro living in a SUBFOLDER of macrosDir,
path-qualified. Compile must propose two files — this test's sibling
`.steps.ts` and `macros/flows/enter_email.steps.ts` beside the macro.

## Config
- baseUrl: http://localhost:8787

## Steps
1. Navigate to the baseUrl
2. [macro: flows/enter_email email="demo@example.com"]
