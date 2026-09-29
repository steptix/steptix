# 062 — The selector rules steer the model into selectors that match nothing

**Status:** partly fixed. Rule 3 is rewritten, and every path that takes a
model-written selector now resolves it through Playwright, on branch
`claude/selector-role-names` (PR #162, after one review round; see
[The fix](#the-fix-rule-3-rewritten-and-every-selector-path-taught-playwright)).
The follow-ups under [Not done](#not-done) are open.
**Area:** [src/ai/prompts.ts](../src/ai/prompts.ts), rule 3 of
`buildSystemPrompt` ("SELECTOR STRATEGY"): ladder items 3, 7 and 9 and the
cookbook.
**Opened:** 2026-09-28

## Summary

Simple clicks were failing, and it was not the model's fault. Rule 3 tells the
model how to write a selector, and it recommended two forms that match nothing
on ordinary modern markup:

1. **`tag:text-is("label")`**, recommended for short labels. `:text-is` only
   matches the innermost element that holds the text. Component libraries wrap
   a button's label in a child element (`<a role="button"><span>Join</span></a>`),
   so the text belongs to the `<span>`, and `a:text-is("Join")` matches nothing.
2. **`[role="button"][name="..."]`**, described as "accessible role + name". It
   is not. It is plain CSS, and in CSS `[name="..."]` is the HTML `name`
   attribute that form fields carry, not the name a screen reader announces.
   It matches nothing unless the element happens to have a `name` attribute
   equal to its label.

The model followed the rules to the letter. Each bad selector then waited out
the click's 10-second timeout, and the retry usually recovered with
`:has-text`. That is why "Click Join" took 30 to 60 seconds, and why some steps
failed outright.

## What it looks like

Source: 17 runs of `templates/init/tests/recording.md` on 2026-09-28, between
06:38 and 07:13, against <https://www.super.test/> and its join flow (worktree
`use-ai-step-idea-b50ba5`, reports in `templates/init/reports/`). Three models:
`gpt-5.6-luna`, `gpt-6-luna` and `gemini-3.8-flash`.

### Example 1: the Join button

The element, as the model received it in the DOM snapshot:

```html
<a role="button">
  <span>
    Join
  </span>
  <i><!-- hidden: aria-hidden --></i>
</a>
```

Selectors the model chose across the runs. Every one failed with
`locator.click: Timeout 10000ms exceeded` and a call log that never resolved an
element:

```
a:text-is("Join")
a[role="button"]:text-is("Join")
header a[role="button"]:text-is("Join")
[role="button"]:text-is("Join")
[role="button"][name="Join"]            (four runs)
```

What worked on the retry: `a[role="button"]:has-text("Join")`.

### Example 2: the "Mr" option in the Title dropdown

A React Aria listbox. The option's text is three levels down:

```html
<li role="option" aria-selected="false" aria-labelledby="react-aria5255916501-:r3b:" id="react-aria5255916501-:r1c:-option-Mr">
  <span id="react-aria5255916501-:r3b:">
    <div>
      <span>
        Mr
      </span>
    </div>
  </span>
</li>
```

The model's reply (`gemini-3.8-flash`, 07:12):

```json
{
  "action": "click",
  "selector": "[role=\"listbox\"] [role=\"option\"]:text-is(\"Mr\")",
  "description": "Click Mr option in Title dropdown"
}
```

The result:

```
locator.click: Timeout 10000ms exceeded.
Call log:
  - waiting for locator('[role="listbox"] [role="option"]:text-is("Mr")').filter({ visible: true }).first()
```

Earlier runs tried `[role="option"]:text-is("Mr")` and `li:text-is("Mr")`, with
the same result. This step never passed.

## The numbers

Across the 17 runs, the model chose a selector for 38 actions, and 19 of them
failed on the first try. All 19 came from the two forms above:

| Selector form | Used | Failed | How they failed |
|---|---|---|---|
| `:text-is(...)` | 17 | 15 | 14 matched nothing. 1 (`h3:text-is("Join super")`) matched a heading that the site's open menu covered, and the heading was not the link anyway. |
| `[role="..."][name="..."]` | 4 | 4 | All matched nothing. |
| Everything else: `:has-text`, `href`, `data-testid`, `aria-label`, `input[type]` | 17 | 0 | |

The two `:text-is` selectors that worked were `button:text-is("Continue")`,
where the text sits directly inside the button, and
`a:has(span:text-is("Join super"))`.

One more failure in the set was not about selectors. In the 07:03 run the step
after "Continue" looked at the page before it had moved on, and asked for
clarification. That is a separate problem.

## Why: what Playwright actually matches

Measured on a local Playwright page with the same markup. Each figure is the
number of elements matched:

| Markup | Selector | Matches |
|---|---|---|
| `<a role="button"><span>Join</span><i aria-hidden="true"></i></a>` | `a[role="button"]:text-is("Join")` | 0 |
| same | `[role="button"][name="Join"]` | 0 |
| same | `role=button[name="Join"]` | 1 |
| The nested "Mr" option above, next to a "Mrs" option | `[role="option"]:text-is("Mr")` | 0 |
| same | `role=option[name="Mr"]` | 1 (not Mrs) |
| `<button>Continue</button>` | `button:text-is("Continue")` | 1 |
| same | `role=button[name="Continue"]` | 1 |
| `<a href="/new">New</a>` | `a:has(:text-is("New"))` | 0 |

What that establishes:

- `:text-is` skips any element whose child element also matches, so wrapping a
  label in a `<span>` moves the match onto the `<span>`.
- Playwright's `role=` selector matches the accessible name: the
  `aria-labelledby` text if there is one, else `aria-label`, else all the
  text inside the element however deeply it is wrapped. The attributes REPLACE
  the text: `<a href="/join" aria-label="Join Example super today">Join</a>` is not
  matched by `role=link[name="Join"]`. It matches the whole name, and
  capitalisation counts: `role=button[name="join"]` matched nothing.
- Whitespace is normalised on both sides: spaces around the label, newlines,
  indentation and non-breaking spaces are trimmed or collapsed, zero-width
  spaces are deleted, and `role=button[name=" Join "]` matches too. Missing
  whitespace is not added: `<span>Save</span><span>draft</span>` shows as
  "Save draft" but its name is "Savedraft".
- CSS `text-transform` is not part of the name: the page shows "JOIN" and
  `role=button[name="Join"]` matches, `name="JOIN"` does not. So the model
  copies the name from the DOM snapshot, not the screenshot. CSS-generated
  content IS part of the name, though: `::before`/`::after` text, icon-font
  glyphs, CSS-drawn arrows and required-field asterisks, and an SVG `<title>`.
  None of those appear in the snapshot, so for those elements the exact name
  cannot be copied and the rule falls back to `:has-text`.
- An element has a role only through its `role` attribute or its tag:
  `<button>`, `<input type="submit|button">`, an `<a>` WITH `href`. An `<a>`
  without `href` or a clickable `<div>` has none, so a `role=` selector finds
  nothing and the text forms are right.
- `:has(:text-is("..."))` only works when the text is wrapped, and fails when it
  is not. It cannot be the general answer.
- To scope a `role=` selector to a container, Playwright needs ` >> `:
  `nav >> role=link[name="New"]` matched 1. With a plain space,
  `nav role=link[name="New"]` is invalid CSS, and Playwright throws a parse
  error in about 5 ms instead of waiting out the timeout.
- A name containing a double quote goes in single quotes:
  `role=button[name='Say "hi"']`.

## The fix: rule 3 rewritten, and every selector path taught Playwright

In `src/ai/prompts.ts`:

- **Item 3** recommends Playwright's `role=` form (`role=button[name="..."]`,
  and link, option, menuitem, tab). It says which elements have a role, where
  the name comes from (aria-labelledby, else aria-label, else the text inside),
  that it must match whole and be copied from the snapshot, that
  `[role="button"][name="..."]` is the CSS look-alike, to scope with ` >> `,
  how to quote a name with a double quote, and — the fallback — that a name
  which matches nothing has parts the snapshot cannot show, so use item 8.
- **Item 7** keeps `tag:text-is("...")` for elements item 3 does not cover, and
  only when the text sits directly inside the element.
- **Item 9's** example becomes `#site-nav >> role=link[name="Login"]`.
- **The cookbook** changes its button, nav-link and dialog lines to the `role=`
  form, and gains a line for options in custom dropdowns.
- **Rules 12, 13, 14, 19 and 20** stop saying "CSS selector": every one of
  those actions now takes any form.
- **Code-behind rule 7** says a `role=` selector from the transcript is exact:
  keep it as written, or pass `exact: true` to `getByRole`, whose default
  matches any name containing the text, in any capitalisation.

In the code, so the advice is true everywhere a model-written selector goes:

- **`expand` and `find`'s scope** (`expandDomSubtree`, `findInDom` in
  `src/browser/dom-cleaner.ts`) resolve the selector through
  `page.locator(...)`, stamp the first match with a temporary
  `data-steptix-target` attribute, and let their in-page scripts find it by that
  stamp. They used to call `document.querySelector` on the model's selector,
  which throws on `role=` and ` >> `. The readTable structure question expands
  its region the same way, so it is fixed by the same change.
- **`wait` with `waitType` `count` or `attribute`** polls `root.locator(...)`
  instead of running `document.querySelector` in `page.waitForFunction`. It now
  also honours `frame`, which it ignored before.
- **`inferWaitType`** recognises `role=`, `text=`, `css=`, `xpath=` and
  ` >> ` as selectors. A `role=` condition with no `waitType` used to be taken
  for a text wait and ran out its whole timeout.
- **`promoteIframeFromSelector`** (`src/browser/actions.ts`), the safety net
  that moves an iframe written into `selector` over to `frame`, split on
  whitespace only. `#pay-frame >> role=button[name="Pay now"]` came out as the
  selector `>> role=button[name="Pay now"]`, which Playwright rejects. It now
  splits the first segment off at whitespace or ` >> ` and keeps the rest
  verbatim.
- **The readTable structure question** no longer sends `expand`'s in-band
  error text ("[expand] …") to the model as the region's markup
  (`src/runner/step-executor.ts`).

`tests/selector-role-names.test.ts` pins the Playwright measurements above on a
real page, including the limits (aria-label, CSS content, run-together spans,
`<a>` without href, quotes). It clicks through `executeAction` with the role
form, inside one iframe and two, with and without the `frame` field; runs the
count, attribute and inferred waits with role selectors; checks `expand` and
`find` take the role form and leave no stamp behind; and checks the prompt
text. Nine of its tests fail against the code before this change.
`tests/api-server-table-structure.test.ts` gains the structure-question case.

### Checked on the real site after the fix

The first four steps of `recording.md` (navigate, then three menu clicks; no
form data), run through a Sessions API server built from this branch, once per
model, on 2026-09-28:

| Model | Result | Selectors the model chose |
|---|---|---|
| `gpt-6-luna` | 4/4 passed, no retries, 35 s | `header >> role=button[name="Join"]`, `header >> role=link[name="Super"]`, `role=link[name="Join super"]` |
| `gpt-5.6-luna` | 4/4 passed, no retries, 49 s | `role=button[name="Join"]`, `header a[href="/super/join-super"]`, `role=link[name="Join super"]` |
| `gemini-3.8-flash` | 4/4 passed, no retries, 101 s | `role=button[name="Join"]`, `header >> role=link[name="Super"]`, `role=link[name="Join super"]` |

All 12 clicks worked on the first try. The same steps in the morning's 06:59 run
(`gpt-6-luna`, old rule) took 115 s, with two clicks failing first.

Re-run after the review round's rewording, same steps and models: all three
passed 4/4 again with no failed action (48 s, 56 s, 64 s), choosing
`role=button[name="Join"]` or `header >> role=button[name="Join"]`,
`role=link[name="Super"]` with or without `header >>`, and
`role=link[name="Join super"]`. The "Mr"
option was not re-run live: it sits behind the join form's personal-details
steps. The test file covers its markup instead.

## Not done

- **Check the selector before acting.** Count the matches and confirm the text
  in code before clicking. On zero matches or the wrong text, go straight back
  to the model with the reason, instead of a 10-second timeout and a whole retry.
  That would also catch a selector that matches the wrong element and passes.
- **Keep score.** Record first-try success for each selector form, and run a
  small suite of simple steps on real sites, so rule changes are judged by
  numbers rather than a single run. The storage design is still under
  discussion.
- **The page-not-settled failure** from the 07:03 run.
- **Names the snapshot cannot show.** The fallback to `:has-text` covers CSS
  content, icon glyphs and run-together words, but the model only learns it
  needed the fallback after a miss. A snapshot that showed the name Playwright
  computed (its accessibility snapshot does) would remove the guess.

## Revisit when

- The scoreboard exists. Check `role=` first-try success on real sites. If names
  often fail to match whole (extra words, text inside icons), consider teaching
  the regex form `role=button[name=/Join/]`, or have the pre-action check suggest
  the exact name it found.
