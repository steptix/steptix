---
tags: [live-integration]
---

# Compile code-behind section live test

Fixture for the section-body half of Compile This Step
(stories/compile-as-you-go.md §Compile This Step). The main flow calls a
section; the body's step is a pure page action against `fixtures/test-app`, so
it is not declined for "performed no page actions". Local and deterministic —
no external account, no network.

## Config
- baseUrl: http://localhost:8787

## Steps
1. Navigate to the baseUrl
2. Fill the form

### Fill the form
1. Enter "demo@example.com" in the email field
