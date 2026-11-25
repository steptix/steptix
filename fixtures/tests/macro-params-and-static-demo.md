---
tags: [smoke, macros, data]
timeout: 120s
---

# Macro demo — caller parameters + static macro data

The `open_site_page` macro shows the two ways a macro gets values, side by side:

- **`page`** is passed in by *this test* (a `## Parameters` input). Note it
  differs between the two calls below — that's the caller varying it.
- the site's **name and URL** come from the macro's own `site` dataSource
  (`fixtures/data/securebank-site.json`) — static, identical on every call,
  and never set by this test.

> **Run with an environment selected.** A macro's `${…}` dataSource only
> resolves when the run supplies an env. In the Steptix sidebar pick an env
> (e.g. **local**) before running; on the CLI use `steptix run … --env local`.
> (Any env works — the site file has no `${envName}` in its path, so it's the
> same file every time.)

## Steps
1. [macro: open_site_page page="transactions" out.page_heading="first_heading"]
2. Verify "{{first_heading}}" equals "Transaction History"
3. [macro: open_site_page page="statements" out.page_heading="second_heading"]
4. Verify "{{second_heading}}" equals "Statements"
