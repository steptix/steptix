---
tags: [survey, section-c, spa, inputs, alerts, frames, tabs, tables, shadow-dom]
timeout: 900s
---

# 44 LetCode: the practice workspace

LetCode's workspace is a single-page app with 21 sandboxes, each opened by a
"Play Sandbox" button under a card. The test reaches every sandbox by clicking
through from the workspace rather than by URL, since the sandbox routes have
changed before.

**Probes:** SPA navigation, read-only and disabled inputs, long-press
buttons, single and multiple selects, all three JS dialog types,
nested iframes three deep, tab switching, summing a table column, open and
closed shadow roots.

## Context
- The site shows Google ads. An ad is not a failure: deal with it the way a
  person would, then carry on with the step.
- On the workspace page an "Unlock more content" wall can cover everything,
  with a single "View a short ad" button and no close button. Click
  "View a short ad", then close the ad that opens. After that the site stays
  open for the day.
- Several ads can be stacked on top of each other. A full-screen ad with a
  "Close" button at its top right sits above everything else, including that
  wall: close it first.
- Other ads have a Close or ✕ button. A banner anchored to the bottom of the
  window has a ˅ button that collapses it; use it when the banner covers what
  you need.

## Config
- baseUrl: https://letcode.in/test

## Steps
1. Edit Fields
2. Click Actions
3. Drop-Down
4. Dialog Box
5. Nested Frames
6. Tabs Handler
7. WebTable
8. Shadow DOM

### Open the sandbox
1. Navigate to the baseUrl

### Edit Fields
1. Open the sandbox
2. Click "Play Sandbox" on the Edit Fields card
3. Type "Survey Tester" into the full name field
4. Append " and more" to the text in the append field and press Tab
5. Read the value of the field inside the box labelled with its value [as: inside_value]
6. Verify that "{{inside_value}}" is not empty
7. Clear the clearable field
8. Verify the disabled field cannot be edited and the read-only field is read-only

### Click Actions
1. Open the sandbox
2. Click "Play Sandbox" on the Click Actions card
3. Press and hold the "Click and Hold" button
4. Verify the disabled button is disabled

### Drop-Down
1. Open the sandbox
2. Click "Play Sandbox" on the Drop-Down card
3. Select "Apple" in the fruits dropdown
4. Verify the page confirms that Apple was selected
5. Select three superheroes in the multiple-choice list
6. Read the last option in the programming languages dropdown [as: last_language]
7. Verify that "{{last_language}}" is not empty

### Dialog Box
1. Open the sandbox
2. Click "Play Sandbox" on the Dialog Box card
3. Open the simple alert and accept it
4. Open the confirm alert and dismiss it
5. Open the prompt alert, type "Steptix" and accept it
6. Verify the page shows "Steptix"

### Nested Frames
1. Open the sandbox
2. Click "Play Sandbox" on the Nested Frames card
3. Enter first name "Survey" and last name "Tester" in the form inside the frame
4. Verify the frame shows "You have entered Survey Tester"
5. Enter "survey.tester@example.com" in the email field of the innermost frame

### Tabs Handler
1. Open the sandbox
2. Click "Play Sandbox" on the Tabs Handler card
3. Click the button that opens a single new tab, and switch to that tab
4. Capture the current page URL [store as: new_tab_url]
5. Switch back to the main tab
6. Verify that "{{new_tab_url}}" starts with "https://letcode.in"

### WebTable
1. Open the sandbox
2. Click "Play Sandbox" on the WebTable card
3. Add up the prices in the shopping list table [as: price_total]
4. Read the total shown under the shopping list table [as: shown_total]
5. Verify that {{price_total}} equals {{shown_total}}

### Shadow DOM
1. Open the sandbox
2. Click "Play Sandbox" on the DOM Elements card
3. Type "Survey" into the first name field inside the open shadow root
4. Type "Tester" into the last name field inside the closed shadow root
5. Verify the first name field contains "Survey"
