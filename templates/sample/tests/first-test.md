# First test

A first Steptix test. Each step below is plain English: Steptix works out
what to do on the page, then remembers it as code in `first-test.steps.ts`
beside this file, so it runs again without asking an AI. This one comes with
its steps already worked out, so it runs as it is, before you choose an AI.

The page it tests is `pages/sample-page.html`, in this project, so it needs
no network. Change a step, or add one, and Steptix uses the AI you chose to
work out the new step.

## Config
- baseUrl: ../pages/sample-page.html

## Steps
1. Open the sample page
2. Type "Ada" into the Name box
3. Click Save
4. Check the page says "Saved for Ada"
