---
env: uat
dataSources:
  vip: ./data/vip.json
---

# Frontmatter environment

## Config

- baseUrl: ${env.BASE_URL}
- timeout: 45s

## Steps

1. Open the dashboard
2. Confirm the banner says ${env.GREETING}
