---
tags: [smoke, login, multi-env]
timeout: 180s
---

# Multi-environment login

This test demonstrates `${env.X}` and `${data.X.Y}` interpolation. Run it
against different environments by passing `--env <name>`:

```
steptix run fixtures/tests/multi-env-login.md --env local
steptix run fixtures/tests/multi-env-login.md --env uat
steptix run fixtures/tests/multi-env-login.md --env staging
```

Each `--env` selects:

- `.env.<name>` — secrets and `BASE_URL`
- `fixtures/data/<name>.json` — `users`, `fixtures` (assertion thresholds, etc.)

Switch environments without editing the test.

## Config
- baseUrl: ${env.BASE_URL}

## Steps
1. Navigate to the login page and dismiss the cookie banner if visible
2. Login with "${data.users.admin.email}" and "${data.users.admin.password}"
3. Verify the "Available Balance" on the dashboard is greater than ${data.fixtures.minBalance}
4. Click on "Transaction History" and verify at least ${data.fixtures.expectedTransactionCount} transactions are listed
5. Logout and verify the login page is displayed
