---
tags: [tools, regex, strings, demo]
timeout: 60s
---

# Slice a value out of a longer string with `regex_extract`

A `read` action captures an element's WHOLE text. When the value you actually
want is buried inside a longer string — e.g. a card that renders
`Account number: 1234 1234 1234 OIN:12345678` — `read` alone can't return just the
account number. Pipe the captured text through the `regex_extract` tool: it stores
the first capture group (or the whole match when the pattern has no group) and
FAILS the step if the pattern is invalid or matches nothing, so a wrong pattern
surfaces here instead of silently poisoning a later step.

## Notes

- **Real-world shape (read → slice).** Against a live page you'd capture the text
  first, then slice it:
    1. Capture the account number line as {{acct_raw}}
    2. `[tool: regex_extract text="{{acct_raw}}" pattern="Account number: ([0-9]{4} [0-9]{4} [0-9]{4})" out.match="account_number"]`

  After step 2, `{{account_number}}` is `1234 1234 1234`.
- The numbered steps below are **self-contained** (literal `text=`) so the demo is
  deterministic and needs no DOM — each shows a different facet of the tool.
- `out.match="<name>"` renames the tool's single `match` output into a variable of
  your choosing (here `account_number`, `iban_country`, `order_id`).
- Patterns use ordinary JavaScript regex syntax — `\d`, `\s`, `\b`, flags, etc. all
  work (the tool calls `new RegExp(pattern, flags)`). The examples below use
  `[0-9]` / literal spaces purely so the regex reads cleanly inline.
- A capture group returns that group; with **no** group the **whole match** is
  stored (step 3). Pass `flags="i"` for case-insensitive, `group=2` for a later
  group.

## Steps

1. [tool: regex_extract text="Account number: 1234 1234 1234 OIN:12345678" pattern="Account number: ([0-9]{4} [0-9]{4} [0-9]{4})" out.match="account_number"]
2. Assert that {{account_number}} equals "1234 1234 1234"
3. [tool: regex_extract text="DE89 3704 0044 0532 0130 00" pattern="^[A-Z]{2}" out.match="iban_country"]
4. Assert that {{iban_country}} equals "DE"
5. [tool: regex_extract text="https://shop.example.com/orders/O-1007/details" pattern="/orders/([A-Z0-9-]+)" out.match="order_id"]
6. Assert that {{order_id}} equals "O-1007"
