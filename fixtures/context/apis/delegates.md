# Delegates API

## Service Info
- Type: Front Proxy
- Spec URL: http://localhost:8787/api/delegates/swagger.json
- Base URL: http://localhost:8787

## Authentication
This is a front proxy endpoint. It requires:
1. A valid session cookie obtained from the browser after login
2. An X-CSRF-Token header for write operations (PUT, POST, DELETE)

## CSRF Token
The CSRF token is retrieved from `GET /api/csrf-token`.
It is also embedded as a hidden input on the /delegates page:
- Selector: `input[name="__RequestVerificationToken"]`

For PUT requests, include the token as the `x-csrf-token` header.

## Endpoints
- `GET /api/delegates` — returns the full list of delegates
- `GET /api/delegates/:id` — returns a single delegate by ID
- `PUT /api/delegates/:id` — updates a delegate (body: `{ mobile, email, name, status }`)

## Notes
- All requests must include `Content-Type: application/json` for write operations
- Delegate IDs are strings in the format `del-NNN`
- Use `apiMode: "browser"` for all requests to this API (session cookies required)
