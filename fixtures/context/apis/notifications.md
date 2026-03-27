# Notifications API

## Service Info
- Type: Private API
- Spec URL: http://localhost:8787/api/notifications/swagger.json
- Base URL: http://localhost:8787

## Authentication
This is a private API. It requires:
- `x-api-key` header with value from `$NOTIFICATIONS_API_KEY`

## Endpoints
- `GET /api/notifications` — returns the list of all notifications

## Notes
- Does not require a browser session — use `apiMode: "standalone"`
- Returns an array of `{ id, message, recipientId, createdAt }` objects
