---
name: user-journey-review
description: Review a spec or a built feature from a user's point of view - walk every journey through it, including the ones where the user declines, closes, repeats, cancels or comes back later, and report the gaps between pieces before anything is fixed. Use after writing or changing a spec, before calling a feature done, or when asked for a user-journey review.
---

# User-journey review

Unit tests and code review check that each piece does its job. They miss the
gaps *between* pieces, because every test scripts one straight path. Users
don't take it: they say Not now and change their mind, ignore a notification,
press Run twice, cancel, reload the window, open a second window, use the
terminal and VS Code together, and come back a week later.

This review walks those paths. It reports what a user would experience. It
fixes nothing until the user has chosen what to fix.

## 1. Decide what you are reviewing

- **A spec** (after writing or changing one): review the design. Read the
  spec and the code it changes. A spec gap is as real as a code gap: a step
  the spec never says how to get back to is a finding.
- **A built feature** (before calling it done): review the behaviour. Trace
  each journey through the code, and run what can be run.

Say which in the report.

## 2. List the journeys

From the spec, list every way a user meets the feature: first use, normal use,
failure, update, removal, and use alongside other parts of the product. For
each, add the off-path variants:

- **Declined or ignored:** they answer No / Not now / Cancel, close the page,
  or never look at the notification.
- **Changed their mind:** they declined, and now want it. Is there a visible
  way back?
- **Twice, or in another order:** the same button again, two entry points at
  once (a command and a page button), a batch that repeats a per-item step.
- **Interrupted:** Stop, Cancel, a window reload, VS Code closing, the machine
  sleeping, the network dropping.
- **Elsewhere:** a second window, a terminal, another version installed
  alongside.
- **Later:** the state on the next start, the next day, after an update.

## 3. Ask six questions at every step

1. **What does the user see?** Is there a visible sign of the state where
   they are looking, or only a log line in the Output panel?
2. **What if they say no, close it, or ignore it?** Can they get back? Does
   anything wait on an answer that may never come?
3. **What if they do it twice, or in another order?** Does a prompt stack or
   repeat? Does one path undo another?
4. **Can they cancel, and does it really stop?** Stop, Cancel and closing a
   page must end the work or the wait, and leave nothing half-done.
5. **When it fails, does the message say what to do next, and does the
   button do it?** A Retry that cannot succeed until VS Code restarts is a
   finding. So is advice to run a command that recreates the problem.
6. **Do all the places that show the state agree?** The status bar, panels,
   pages, notifications and the terminal must say the same thing, and update
   when the state changes by another route.

These patterns have each hidden real bugs here; look for them:

- A wait on a question that can slide out of sight (a notification).
- Work running inside a window that a button reloads.
- A per-item step inside a loop that asks, fails or downloads once per item.
- State decided once at start and never looked at again.
- A path read from the environment VS Code started with.
- One code path that clears a state while another path forgets to.

## 4. Split the work

For a large feature, give the journeys to three or four reviewers running in
parallel, grouped so each reads a coherent set of files (for example: first
use; failures; updates and removal; the setup page). Brief each one with:

- the goal, and two or three example bugs in one line each;
- its journeys, the six questions, and the files to read;
- read-only: no edits, no commits, no installs;
- report only what a user would hit, not style or code quality;
- trace each finding through the code before reporting it, and drop what it
  could not confirm;
- tag each finding **traced** (read in code) or **observed** (seen in a run,
  naming the run); a claim about what an AI model sends needs a real run
  (CLAUDE.md);
- the report format below, with a word limit.

Check the strongest findings yourself before passing them on.

## 5. Report

Rank by harm to a user, and give each finding:

- **Title**, in the user's words.
- **Steps**, as a user would do them.
- **What the user experiences.**
- **Evidence:** `file:line` and one sentence on why the code does this.
- **Suggested fix**, in one or two sentences.
- **Severity:** high (blocks or misleads a new user), medium, low.
- **Traced** or **observed**.

Then stop and let the user choose what to fix. When asked, file the findings
in one GitHub issue, written for both a person and a later agent (a plain
summary first; code links pinned to a commit; cause; fix options; how to
verify).

## 6. Before building a fix

- **Show a user-facing change before building it.** For anything the user
  will see (a banner, a dialog, a button, new wording), describe how it will
  work and, for UI, show a mockup. Build after they agree.
- **Look for a better way.** Before proposing a fix, ask whether the gap
  points at a deeper choice (a dialog instead of a notification, one check
  per batch instead of per item) rather than a patch on top.
- **Write the agreed design into the spec first**, then build it, so the
  spec and the code stay one story.
- **Each fix gets a test that fails without it**, on the journey that found
  it, not only on the straight path.
