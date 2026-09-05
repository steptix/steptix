---
tags: [live-integration]
---

# store-as captures survive TWO breakpoint pauses

The sibling test, `store-as-survives.md`, proves a captured value crosses
ONE batch boundary. That is a single hop, and a single hop can be passed
by a handoff that only works once — the second batch reading whatever the
first one left behind.

Carrying values across a paused run is not a handoff, it is a loop: every
step writes its captures into `session.outputs`, and every batch opens by
seeding itself from that same accumulated set. Two breakpoints is the
smallest test that can tell those two designs apart, because it asks two
questions one boundary cannot:

- does a value captured in batch 1 survive TWO boundaries, still readable
  in batch 3, and
- does a value captured in batch 2 — a batch that is neither the first nor
  the last — carry forward at all?

Breakpoints go on steps 3 and 5, splitting the run into three batches:
steps 1-2 capture `first_url`, steps 3-4 capture `second_url`, and steps
5-8 consume both.

Each navigation is followed by a heading check, because navigating to a
merely *valid* URL proves nothing if it is the wrong page. Step 8 confirms
`{{first_url}}` still held the FIRST page's address. Step 6 closes the
subtler hole: if the two captures had aliased and `second_url` carried
`first_url`'s value, step 5 would still pass — the browser is already on
that page — so only the heading can tell the two apart.

Everything runs against the local fixture app on port 8787 — no external
site, so nothing here depends on the network or a rate limit.

## Steps
1. Navigate to http://127.0.0.1:8787/assertions.html
2. Capture the current page URL [store as: first_url]
3. Navigate to http://127.0.0.1:8787/dom-noise.html
4. Capture the current page URL [store as: second_url]
5. Navigate to {{second_url}}
6. Verify the page heading says "DOM Noise Fixture"
7. Navigate to {{first_url}}
8. Verify the page heading says "SecureBank Portfolio"
