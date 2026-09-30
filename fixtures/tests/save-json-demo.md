---
tags: [tools]
---

# Save json demo — keep each row's values in a file

Demonstrates `[tool: save_json]`, which writes the named variables as one
JSON object per line to a JSON Lines file. Each data row adds its own line.
`key="customer_id"` makes a re-run replace a row's line rather than add a
second one, so running this test twice — or running one row of it with
`--row 2` — still leaves three lines in `reports/data/customers.jsonl`.

A bare name such as `firstname` is shorthand for `firstname="{{firstname}}"`.
No step here needs the model: the row values and the `Set` are the captures.
In a real test they would be `Read … [store as: firstname]` steps.

## Steps
| customer_id | firstname | lastname |
|-------------|-----------|----------|
| C-1001      | Jane      | O'Brien  |
| C-1002      | Ravi      | Patel    |
| C-1003      | Ana       | Costa    |

1. Set {{email}} to "{{firstname}}@example.test"
2. [tool: save_json file="reports/data/customers.jsonl" key="customer_id" customer_id firstname lastname email]
