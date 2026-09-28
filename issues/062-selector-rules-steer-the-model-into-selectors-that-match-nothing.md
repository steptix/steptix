# 062 — The selector rules steer the model into selectors that match nothing

**Status:** partly fixed. Rule 3 is rewritten on branch
`claude/selector-role-names` (see [The fix](#the-fix-rule-3-rewritten)). The
two follow-ups under [Not done](#not-done) are open.
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
- Playwright's `role=` selector matches the accessible name, which is built from
  all the text inside the element however deeply it is wrapped (or from
  `aria-label` / `aria-labelledby`). It matches the whole name, and
  capitalisation counts: `role=button[name="join"]` matched nothing.
- Whitespace does not matter. Spaces around the label, newlines and indentation,
  non-breaking spaces and zero-width spaces all still matched
  `role=button[name="Join"]`, and so did `role=button[name=" Join "]`.
- The name comes from the page's text, not from how it is drawn. With
  `text-transform: uppercase` the page shows "JOIN", but
  `role=button[name="Join"]` matched and `role=button[name="JOIN"]` did not. So
  the model has to copy the name from the DOM snapshot, not the screenshot.
- `:has(:text-is("..."))` only works when the text is wrapped, and fails when it
  is not. It cannot be the general answer.
- To scope a `role=` selector to a container, Playwright needs ` >> `:
  `nav >> role=link[name="New"]` matched 1. With a plain space,
  `nav role=link[name="New"]` is invalid CSS, and Playwright throws a parse
  error in about 5 ms instead of waiting out the timeout.

## The fix: rule 3 rewritten

- **Item 3** now recommends Playwright's `role=` form (`role=button[name="..."]`,
  `role=link`, `role=option`, `role=menuitem`, `role=tab`). It explains that the
  name comes from all the text inside, must match whole, and must be copied from
  the snapshot. It warns that `[role="button"][name="..."]` is a different, CSS
  selector, says to scope with ` >> `, and lists the actions that need plain CSS
  (below).
- **Item 7** keeps `tag:text-is("...")` only for elements with no role, and only
  when the text sits directly inside the element.
- **Item 9's** example becomes `#site-nav >> role=link[name="Login"]`.
- **The cookbook** changes its button, nav-link and dialog lines to the `role=`
  form, and gains a line for options in custom dropdowns.

Where a `role=` selector is accepted, from reading the action code: click, type,
select, hover, upload, `read` (single and `multiple`), `count`, `readTable`,
and `wait` with `waitType` `selector` or `hidden` all resolve through
Playwright locators (`root.locator(selector)` in `src/browser/actions.ts`). Four places run the selector through
`document.querySelector` in the page, so they need plain CSS and would throw on
`role=`:

- `expand` (`expandDomSubtree` in `src/browser/dom-cleaner.ts`)
- `find`'s optional `selector` scope (`findInDom`)
- `wait` with `waitType` `count`
- `wait` with `waitType` `attribute`

The new rule names these, and rules 12, 19 and 20 already asked for CSS there.

`tests/selector-role-names.test.ts` pins the Playwright measurements above on a
real page, drives a click through `executeAction` with the new form, and checks
that the prompt carries the new guidance and no longer recommends the CSS
look-alike.

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
(`gpt-6-luna`, old rule) took 115 s, with two clicks failing first. The "Mr"
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
- **Let the four CSS-only paths accept Playwright selectors.** That would remove
  the exception from the rule.
- **The page-not-settled failure** from the 07:03 run.

## Revisit when

- The scoreboard exists. Check `role=` first-try success on real sites. If names
  often fail to match whole (extra words, text inside icons), consider teaching
  the regex form `role=button[name=/Join/]`, or have the pre-action check suggest
  the exact name it found.
