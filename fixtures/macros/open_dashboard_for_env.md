---
type: macro
dataSources:
  endpoints: ../data/${envName}-endpoints.json
---

# open_dashboard_for_env

Opens the SecureBank login page for whichever environment the run was
started in. The macro's `dataSources` path itself contains `${envName}`,
so swapping `--env <name>` swaps the JSON file the macro reads from —
no caller change required.

This is the canonical demonstration of macro-level `dataSources` plus
dynamic, env-driven path resolution. The macro takes zero parameters; the
URL it navigates to comes entirely from its private data file.

## Outputs
- page_title: the document title of the loaded page

## Steps
1. Navigate to ${endpoints.api.url}/ and verify the SecureBank "Sign In" form is visible
2. Verify the current page URL starts with "${endpoints.api.url}"
3. Capture the document title (the value of the &lt;title&gt; tag) [store as: page_title]
