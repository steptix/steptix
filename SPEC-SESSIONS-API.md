# API Server Specification — v1

## Overview

A REST API server that allows callers to send natural language test steps for execution against persistent browser sessions. Each session manages its own browser instance, stays open between requests, and accumulates state (captured outputs, page context) across multiple step batches.

---

## Startup

- New CLI command (e.g. `ai-ui-automation serve`) starts the API server.
- Server listens on a configurable host and port, defined in the existing project config file.
- A default API key is defined in the config file. All requests must include this key in the `x-api-key` header.

### Config Fields

| Field         | Description                        | Default         |
|---------------|------------------------------------|-----------------|
| `api.host`    | Host to bind the server to         | `127.0.0.1`     |
| `api.port`    | Port to listen on                  | `3100`          |
| `api.apiKey`  | API key for authentication         | (default value)  |

---

## Authentication

All endpoints require the `x-api-key` header matching the configured API key.

- Missing or invalid key returns `401 Unauthorized`.

---

## Endpoints

### POST /sessions/:id/steps

Execute a batch of test steps within a named session.

#### Session ID

- `:id` is a caller-provided string (e.g. `"my-checkout-test"`, `"login flow"`).
- Maximum 128 characters. Spaces are allowed.
- If the session does not exist, it is created implicitly (a new browser instance is launched).
- If the session was previously closed (via a "Close the browser" step), a new session is created with the same ID.
- If the session is currently executing a previous request, the new request is queued and processed after the current execution completes.

#### Request Body

```json
{
  "config": {
    "baseUrl": "http://localhost:3000",
    "timeout": "30s",
    "viewport": "mobile"
  },
  "steps": [
    "Navigate to the login page",
    "Enter \"{{email}}\" in the email field",
    "[output: welcome_text] Assert the welcome message is visible"
  ],
  "parameters": {
    "email": "demo@example.com",
    "password": "secret123"
  }
}
```

| Field        | Required | Description |
|--------------|----------|-------------|
| `config`     | No       | Session configuration. Only allowed on the **first request** for a session. Sending `config` on subsequent requests returns `400 Bad Request`. |
| `config.baseUrl` | No  | Base URL for the application under test. |
| `config.timeout` | No  | Timeout per step (e.g. `"30s"`, `"2m"`). |
| `config.viewport` | No | Render this session's pages at exactly this size, headed **and** headless. See below. |

#### `config.viewport`

The raw `## Config: viewport:` value from the test file, forwarded verbatim —
clients do not resolve it, the server does. One validator means the CLI, the
editor and an MCP agent all refuse the same values with the same words.

| Value | Page size |
|---|---|
| `mobile` | 390 × 844 |
| `tablet` | 768 × 1024 |
| `desktop` | 1440 × 900 |
| `<width>x<height>` (e.g. `390x844`) | exactly that |

- Case-insensitive, surrounding whitespace trimmed. Each dimension must be
  between 100 and 10000.
- Anything else is refused with
  ``Invalid '## Config: viewport: <value>' — expected a preset (mobile | tablet | desktop) or `<width>x<height>` (e.g. `390x844`).``
  Validation runs **before the browser launches**, so an invalid value fails the
  batch with no browser side effects.
- Refused alongside `config.cdp`: a viewport cannot be imposed on a browser the
  user started and sized themselves.
- Like the rest of `config`, it is write-once — see the note on the `config`
  row above. A client that wants a different size on a live session closes the
  session first (`DELETE /sessions/:id`) and sends the new value on the next
  batch.
- CSS breakpoints only. No touch events, no mobile user agent, no
  `devicePixelRatio` change.
| `steps`      | Yes      | Array of natural language step strings. At least one step is required. |
| `parameters` | No       | Key-value object for `{{variable}}` interpolation in steps. Can override previously captured output variables. |

#### Step Format

Steps are natural language instructions, identical to the format used in markdown test files:

- **Plain instructions**: `"Click the Sign In button"`
- **Parameter interpolation**: `"Enter \"{{email}}\" in the email field"` — resolved from `parameters` in the request body, or from previously captured output variables.
- **Output capture**: `"[output: variable_name] Get the displayed username"` — captures a DOM value into a named variable. Multiple outputs per step are supported: `"[output: plan_name] [output: plan_price] Get the plan details"`.
- **Variable assignment**: `"Set {{summary}} to \"{{username}} had {{balance}}\""` — stores a value built from the session's existing variables under a new name, with no AI call. The template resolves `{{name}}` and `${env.X}` / `${data.x}` against the session as it stands; a reference it cannot resolve fails the step rather than storing the literal. Note that a **malformed** `Set {{name}} to …` is *not* rejected here: this endpoint receives step strings and never parses markdown, so a line that does not match the form is sent to the AI as ordinary prose. The parse-time refusal applies to files read by the CLI and by the MCP tools, not to steps posted here.
- **Ignored prefixes**: `[input: variable_name]` and `[interactive]` are silently skipped, as they are interactive/terminal concepts that do not apply to the API.

A step may also name a file to upload — `Upload file attachments/logo.png`, or
with Windows-style backslashes, which are normalised. The path is resolved
against the folder holding the `testFilePath` sent with the request, and is
fenced to the project root: a path that resolves outside it is refused. The file
must be readable **by the server process** — the bytes are read where the server
runs, not on the client machine — so a client on another host has to put the
file somewhere the server can read it. A request that omits `testFilePath` has
no folder to resolve a relative path against, so it can only use absolute paths.

#### Output Variable Accumulation

- Output variables captured via `[output: var]`, and values written by a `Set {{name}} to "…"` step, are stored in the session.
- They accumulate across multiple requests to the same session.
- They are automatically available for `{{variable}}` interpolation in subsequent requests without the caller needing to re-pass them.
- A caller can override a previously captured output by passing the same key in the `parameters` object.

#### Execution Behavior

- Steps execute **synchronously** — the HTTP response is returned only after all steps have completed or one has failed.
- If a step fails, execution **stops immediately**. Remaining steps are not executed.
- The response includes results for all steps that were attempted (including the failed one).

#### Response Body

```json
{
  "sessionId": "my-checkout-test",
  "status": "passed",
  "stepsCompleted": 5,
  "stepsTotal": 5,
  "results": [
    {
      "step": "Navigate to the login page",
      "status": "passed",
      "actions": [
        { "type": "navigate", "url": "http://localhost:3000/login" }
      ],
      "screenshot": "data:image/png;base64,...",
      "reasoning": "Navigating to the login page from baseUrl",
      "outputs": {}
    },
    {
      "step": "[output: username] Get the displayed username",
      "status": "passed",
      "actions": [
        { "type": "extract", "selector": ".profile-name" }
      ],
      "screenshot": "data:image/png;base64,...",
      "reasoning": "Found the username in the profile header",
      "outputs": { "username": "Jane Smith" }
    },
    {
      "step": "[output: email] Get the displayed email address",
      "status": "passed",
      "actions": [
        { "type": "extract", "selector": ".profile-email" }
      ],
      "screenshot": "data:image/png;base64,...",
      "reasoning": "Found the email below the username",
      "outputs": { "email": "jane@example.com" }
    },
    {
      "step": "[output: plan_name] [output: plan_price] Get the subscription plan name and price",
      "status": "passed",
      "actions": [
        { "type": "extract", "selector": ".plan-details" }
      ],
      "screenshot": "data:image/png;base64,...",
      "reasoning": "Extracted plan name and price from the subscription card",
      "outputs": { "plan_name": "Pro", "plan_price": "$29/mo" }
    },
    {
      "step": "Click the Edit Profile button",
      "status": "passed",
      "actions": [
        { "type": "click", "selector": "#edit-profile-btn" }
      ],
      "screenshot": "data:image/png;base64,...",
      "reasoning": "Clicked the edit button in the profile header",
      "outputs": {}
    }
  ],
  "outputs": {
    "username": "Jane Smith",
    "email": "jane@example.com",
    "plan_name": "Pro",
    "plan_price": "$29/mo"
  },
  "error": null
}
```

| Field            | Description |
|------------------|-------------|
| `sessionId`      | The session ID from the request. |
| `status`         | `"passed"` if all steps succeeded, `"failed"` if an assertion failed, `"error"` if a step encountered an unexpected error. |
| `stepsCompleted` | Number of steps that executed successfully. |
| `stepsTotal`     | Total number of steps in the request. |
| `results`        | Array of per-step results, in execution order. Includes all attempted steps (up to and including the failed step, if any). |
| `results[].step` | The original step text as provided. |
| `results[].status` | `"passed"`, `"failed"`, or `"error"` for this individual step. |
| `results[].actions` | Array of structured actions the AI determined and executed for this step. |
| `results[].screenshot` | Base64-encoded screenshot taken after the step completed. |
| `results[].reasoning` | The AI's reasoning for how it interpreted and executed the step. |
| `results[].outputs` | Outputs captured by this specific step. Empty object `{}` if no `[output:]` prefix was used. |
| `outputs`        | Accumulated outputs across all steps in this request, merged with outputs from any previous requests in this session. |
| `error`          | `null` on success. On failure: `{ "step": <index>, "message": "..." }` where `step` is the zero-based index of the failing step. |

#### Error Response (failed step)

```json
{
  "sessionId": "my-checkout-test",
  "status": "failed",
  "stepsCompleted": 1,
  "stepsTotal": 3,
  "results": [
    {
      "step": "Navigate to the login page",
      "status": "passed",
      "actions": [{ "type": "navigate", "url": "http://localhost:3000/login" }],
      "screenshot": "data:image/png;base64,...",
      "reasoning": "...",
      "outputs": {}
    },
    {
      "step": "Assert the welcome banner shows \"Hello Admin\"",
      "status": "failed",
      "actions": [{ "type": "assert", "expected": "Hello Admin" }],
      "screenshot": "data:image/png;base64,...",
      "reasoning": "The welcome banner shows 'Hello Guest', not 'Hello Admin'",
      "outputs": {}
    }
  ],
  "outputs": {},
  "error": {
    "step": 1,
    "message": "Assertion failed: expected 'Hello Admin' but found 'Hello Guest'"
  }
}
```

---

### GET /sessions/:id

Get the current state of an active session.

#### Response Body

```json
{
  "sessionId": "my-checkout-test",
  "status": "active",
  "currentUrl": "http://localhost:3000/profile",
  "pageTitle": "User Profile — MyApp",
  "screenshot": "data:image/png;base64,...",
  "outputs": {
    "username": "Jane Smith",
    "email": "jane@example.com"
  },
  "totalStepsExecuted": 12
}
```

| Field                | Description |
|----------------------|-------------|
| `sessionId`          | The session ID. |
| `status`             | `"active"`, `"executing"` (currently running steps), or `"queued"` (has pending requests). |
| `currentUrl`         | The current URL of the browser page. |
| `pageTitle`          | The current page title. |
| `screenshot`         | Base64-encoded screenshot of the current browser state. |
| `outputs`            | All accumulated output variables for this session. |
| `totalStepsExecuted` | Total number of steps executed across all requests to this session. |

#### Error Responses

- `404 Not Found` — Session ID does not exist or has been closed.

---

### GET /sessions

List all active sessions.

#### Response Body

```json
{
  "sessions": [
    {
      "sessionId": "my-checkout-test",
      "status": "active",
      "currentUrl": "http://localhost:3000/profile",
      "pageTitle": "User Profile — MyApp",
      "totalStepsExecuted": 12
    },
    {
      "sessionId": "login flow",
      "status": "executing",
      "currentUrl": "http://localhost:3000/login",
      "pageTitle": "Login — MyApp",
      "totalStepsExecuted": 3
    }
  ]
}
```

- Only active (not closed) sessions are returned.
- No screenshots in the list endpoint (to keep responses lightweight). Use `GET /sessions/:id` for screenshots.

---

## Session Lifecycle

```
[First POST /sessions/:id/steps]
        |
        v
   Session Created (new browser instance launched)
        |
        v
   Active — accepts step requests, queues if busy
        |
        v
   [Step "Close the browser" executed]
        |
        v
   Session Closed (browser instance destroyed, removed from active list)
        |
        v
   [POST /sessions/:id/steps with same ID]
        |
        v
   New Session Created (fresh browser instance, no state carried over)
```

- Each session = one dedicated browser instance.
- Multiple sessions run in parallel, each with independent browser instances.
- Sessions use the globally configured AI provider and model.

---

## HTTP Status Codes

| Status | Meaning |
|--------|---------|
| `200`  | Success (steps executed, even if a step failed — check `status` field). |
| `400`  | Bad request (e.g. `config` sent on non-first request, missing `steps` array, session ID exceeds 128 chars). |
| `401`  | Unauthorized (missing or invalid `x-api-key` header). |
| `404`  | Session not found (for `GET /sessions/:id` on a closed or nonexistent session). |
| `500`  | Internal server error. |

---

## Out of Scope (v1)

- WebSocket streaming of step progress
- Video recording
- Parallel step execution within a single session
- Per-session AI provider/model configuration
- Per-session browser configuration (headless/headed, viewport, proxy)
- Session persistence across server restarts
