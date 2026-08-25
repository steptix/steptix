---
tags: [live-integration]
---

# Compile subfolder-skill live test

Fixture for the live compile test (stories/skills-in-subfolders.md). Step 1
is the test's own; step 2 invokes a skill living in a SUBFOLDER of skillsDir,
path-qualified. Compile must propose two files — this test's sibling
`.steps.ts` and `skills/flows/enter_email.steps.ts` beside the skill.

## Config
- baseUrl: http://localhost:8787

## Steps
1. Navigate to the baseUrl
2. [skill: flows/enter_email email="demo@example.com"]
