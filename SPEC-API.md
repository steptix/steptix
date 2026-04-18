# ai-ui-automation — API Testing Extension Specification v1.0

**Author:** Greg (AI Tech Lead) / Paul Kent
**Date:** 2026-03-27
**Status:** Draft
**Depends on:** SPEC.md (core UI testing specification)

---

## 1. Overview

This specification extends ai-ui-automation to support **API testing alongside UI testing** within a single framework. Test authors write natural language instructions that can freely mix browser interactions and API calls in the same test. The AI determines from the instruction whether a step is a UI action or an API call and executes accordingly.

### Core Principles

- API steps are written in the same natural language as UI steps — no HTTP syntax in test files
- The AI infers whether a step is UI or API from the instruction (no prefixes or markers required)
- API knowledge comes from OpenAPI/Swagger specs and context files
- Authentication is handled automatically based on the API type defined in context
- API responses are remembered across steps — the AI uses values from earlier responses in later steps
- Browser session state (cookies, CSRF tokens) can be shared with API calls when needed

---

## 2. Architecture Extension

The existing architecture (SPEC.md §2) is extended with an API execution path:

```
┌─────────────────────────────────────────────────────┐
│                  AI Step Executor                    │
│  - Determines step type: UI or API                  │
│  - For UI steps: existing Playwright flow           │
│  - For API steps: HTTP client flow (below)          │
│  - For hybrid: browser session API flow             │
└──────────────┬──────────────────────┬───────────────┘
               │                      │
               ▼                      ▼
┌──────────────────────────┐  ┌───────────────────────┐
│   Playwright Browser     │  │    HTTP Client         │
│  (existing)              │  │  - Standalone (fetch)  │
│                          │  │  - Browser context     │
│  Also provides:          │  │    (context.request)   │
│  - context.request for   │  │  - Cookie/CSRF from    │
│    front proxy calls     │  │    browser session     │
│  - Cookie/CSRF source    │  │  - API key / Bearer    │
└──────────────────────────┘  └───────────────────────┘
               │                      │
               ▼                      ▼
┌─────────────────────────────────────────────────────┐
│                API Response Store                    │
│  - Stores responses from all API steps              │
│  - AI references prior responses in later steps     │
│  - Included in conversation history                 │
└─────────────────────────────────────────────────────┘
```

### Key Integration Points

1. **Browser → API:** Front proxy endpoints use cookies and CSRF tokens obtained from the browser session. The tool extracts these from the Playwright browser context.
2. **API → UI:** An API call may change backend state that the next UI step needs to verify. The AI carries context between both step types.
3. **API → API:** One API call's response may contain values needed for the next API call. The response store makes prior results available.

---

## 3. API Knowledge Base

### 3.1 OpenAPI/Swagger Specs

API specs are the primary source of endpoint knowledge — request schemas, response schemas, path parameters, query parameters, and available operations.

**Referencing specs in context files:**

```markdown
## Delegates API
- Spec URL: https://api-t1.example.com/swagger/v1/swagger.json
- Spec: specs/delegates-swagger.json
```

**Spec management:**
- Specs are referenced by URL in context files
- On first use, the tool downloads the spec and caches it in the `specs/` directory (relative to project root)
- Cached specs are used for subsequent runs
- The `specs/` directory is auto-created if it doesn't exist

**CLI commands for spec management:**

```bash
# Sync all specs referenced in context files (re-download from URLs)
npx ai-ui-auto specs sync

# Sync a specific spec
npx ai-ui-auto specs sync delegates

# List cached specs and their source URLs
npx ai-ui-auto specs list
```

### 3.2 Context Files for APIs

Context files (in the existing `context/` directory) describe each API service. The AI uses these to understand how to call endpoints — what type of API it is, how to authenticate, and any quirks.

**Example: `context/apis/delegates.md`**

```markdown
# Delegates API

## Service Info
- Type: Front Proxy
- Spec URL: https://api-t1.example.com/delegates/swagger/v1/swagger.json
- Base URL: $DELEGATES_API_URL

## Authentication
This is a front proxy endpoint. It requires:
1. A valid session cookie obtained from the browser after login
2. An X-CSRF-Token header

## CSRF Token
The CSRF token is found in the response body of the /delegates page.
Look for a hidden input field with name="__RequestVerificationToken".
The token value should be sent as the X-CSRF-Token header value.

## Notes
- All requests must include Content-Type: application/json
- The base path for all endpoints is /api/delegates/v1
- Delegate IDs are GUIDs
```

**Example: `context/apis/notifications.md`**

```markdown
# Notifications API

## Service Info
- Type: Private API
- Spec URL: https://api-internal.example.com/notifications/swagger.json
- Base URL: $NOTIFICATIONS_API_URL

## Authentication
This is a private API. It requires:
- x-api-key header with value from $NOTIFICATIONS_API_KEY

## Notes
- Rate limited to 100 requests per minute
- All timestamps are UTC ISO 8601
```

**Example: `context/apis/auth-service.md`**

```markdown
# Auth Service

## Service Info
- Type: Serverless API
- Spec URL: https://api.example.com/auth/openapi.json
- Base URL: $AUTH_API_URL

## Authentication
- Public endpoints (login, register): No auth required
- Protected endpoints: Bearer token in Authorization header
- Token obtained from POST /auth/token response body (field: access_token)
- Token expires after 3600 seconds

## Notes
- Login returns both access_token and refresh_token
- Use refresh_token to obtain new access_token without re-authenticating
```

### 3.3 API Types

The framework recognises different API types, each with distinct authentication and calling patterns:

| API Type       | Auth Method                                      | HTTP Client          |
|----------------|--------------------------------------------------|----------------------|
| Front Proxy    | Browser session cookies + CSRF token from page   | Browser context.request (default) or standalone with extracted cookies |
| Experience API | Browser session cookies (no CSRF)                | Browser context.request or standalone |
| Private API    | x-api-key header                                 | Standalone           |
| Serverless API | Bearer token or API key                          | Standalone           |
| Public API     | None                                             | Standalone           |

The AI reads the API type and auth description from the context file and applies the correct authentication method automatically. The test author does not need to specify auth details in test steps.

---

## 4. API Step Execution

### 4.1 Step Detection

The AI determines whether a step is UI or API based on the natural language instruction. No explicit prefix or marker is required.

**API step indicators (AI infers from language):**
- "Call the /update/delegates endpoint..."
- "Send a POST request to..."
- "Hit the notifications API..."
- "Update the mobile number via the API..."
- "Fetch the delegate details from the API..."

**UI step indicators:**
- "Click on...", "Navigate to...", "Verify the page shows..."
- "Login with...", "Fill in the form..."

**Hybrid indicators (API call using browser session):**
- "Using the current session, call the API..."
- Context file declares the API as Front Proxy (automatic)

### 4.2 API Execution Flow

For each API step:

```
1. Identify the target API
   - Match the endpoint/service mentioned in the step to a context file
   - Load the corresponding OpenAPI spec from specs/ cache
   - If spec not cached, download from the URL in context and cache it

2. Resolve authentication
   - Read the API type from the context file
   - Front Proxy: extract cookies from Playwright browser context,
     obtain CSRF token as described in context (e.g. scrape from page)
   - Private: read API key from environment variable
   - Serverless: use Bearer token (from prior auth step or env var)
   - Public: no auth needed

3. Build the request
   - AI determines: HTTP method, URL path, query params, request body
   - AI uses the OpenAPI spec to understand the schema
   - AI uses context file for any additional guidance
   - Parameter values come from: step instruction, prior API responses,
     test parameters, or AI reasoning

4. Execute the request
   - Front Proxy / Experience API: use Playwright context.request
     (automatically carries session cookies)
   - All other types: use standalone HTTP client (fetch/undici)
   - Apply auth headers as determined in step 2

5. Process the response
   - Store full response (status, headers, body) in the API response store
   - Log to report: request details, response status, response body
   - If step contains an assertion: AI evaluates pass/fail

6. On failure
   - Capture request/response details
   - Retry once with enriched context (same pattern as UI retry)
   - If retry fails: mark step as FAILED with AI explanation
```

### 4.3 CSRF Token Handling

CSRF tokens are a special case because they require interaction with the browser to obtain:

1. The context file describes where the CSRF token is found (e.g. hidden input on a specific page, meta tag, API response)
2. Before making the API call, the AI plans a sub-action to obtain the CSRF token:
   - If it's on a page: navigate to that page (or use current page), extract the token from the DOM
   - If it's from an API: call the endpoint that returns it
3. The extracted token is included in the request headers
4. The token is cached for the duration of the test (unless the context says it changes per request)

### 4.4 HTTP Client Modes

**Standalone client (default for non-browser-session APIs):**
- Uses Node.js `fetch` (or `undici`)
- Auth credentials injected from environment variables
- No dependency on browser state
- Used for: Private APIs, Serverless APIs, Public APIs

**Browser context.request (for front proxy / experience APIs):**
- Uses Playwright's `APIRequestContext` from the browser context
- Automatically inherits all cookies from the browser session
- Maintains cookie jar consistency with the browser
- Used when: API type is Front Proxy or Experience, or instruction says "using the current session"

### 4.5 API Response Store

All API responses are stored in memory during test execution and made available to subsequent steps:

```typescript
interface StoredResponse {
  stepNumber: number;
  endpoint: string;
  method: string;
  url: string;
  requestBody?: any;
  status: number;
  headers: Record<string, string>;
  body: any;
  timestamp: number;
}
```

**How the AI uses stored responses:**
- Responses are included in the conversation history as structured summaries
- When a later step needs a value from a prior response (e.g. a delegate ID), the AI extracts it from the stored response
- No explicit variable binding required — the AI reasons about which prior response contains the needed value
- Example: "Delete the delegate we just created" → AI looks at prior responses, finds the POST that created a delegate, extracts the ID from that response

---

## 5. Test File Format (Extended)

The test file format remains the same as SPEC.md §3. API steps are simply natural language instructions in the Steps section.

### Example: Mixed UI + API Test

```markdown
---
tags: [smoke, delegates, api]
timeout: 120s
---

# Delegate Mobile Update Test

## Config
- baseUrl: https://app.example.com

## Parameters
- username: admin@test.com
- password: $ENV_PASSWORD
- newMobile: 0400000000

## Steps
1. Navigate to the login page and login with "{{username}}" and "{{password}}"
2. Call the /delegates endpoint to get the list of delegates
3. Update the first delegate's mobile number to "{{newMobile}}" using the /update/delegates endpoint
4. Navigate to the delegates page and verify the mobile number shows "{{newMobile}}"
5. Call the /delegates endpoint again and verify the response contains "{{newMobile}}"
```

### Example: Pure API Test

```markdown
---
tags: [api, notifications]
timeout: 30s
---

# Notification Send Test

## Parameters
- recipientId: $TEST_RECIPIENT_ID

## Steps
1. Send a POST to the notifications API to create a new notification for "{{recipientId}}" with message "Test notification"
2. Verify the response status is 201
3. Fetch the notifications for "{{recipientId}}" and verify the new notification appears in the list
```

### Example: API Test Requiring Browser Auth

```markdown
---
tags: [api, delegates, auth]
timeout: 90s
---

# Delegates API via Front Proxy

## Config
- baseUrl: https://app.example.com

## Parameters
- username: admin@test.com
- password: $ENV_PASSWORD

## Steps
1. Login with "{{username}}" and "{{password}}"
2. Call the /api/delegates/v1/list endpoint to get all delegates
3. Verify the response contains at least one delegate
4. Update the first delegate's email to "updated@test.com"
5. Fetch the delegate by ID and verify the email is now "updated@test.com"
```

In this example, step 1 is a UI step (browser login). Steps 2–5 are API steps that use the browser session's cookies because the Delegates API is defined as a Front Proxy in the context file.

---

## 6. Environment Configuration

### 6.1 Environment Files

Each environment has a separate `.env` file in the project root:

```
my-project/
├── .env.t1
├── .env.t2
├── .env.staging
├── .env.production
├── ai-ui-auto.config.ts
├── context/
├── specs/
├── tests/
└── ...
```

**Example: `.env.t1`**

```bash
# Base URLs
BASE_URL=https://app-t1.example.com
DELEGATES_API_URL=https://api-t1.example.com/delegates
NOTIFICATIONS_API_URL=https://api-t1.example.com/notifications
AUTH_API_URL=https://api-t1.example.com/auth

# Credentials
ENV_PASSWORD=t1-test-password
TEST_RECIPIENT_ID=user-123-t1

# API Keys
NOTIFICATIONS_API_KEY=t1-notif-key-xxxxx
```

**Example: `.env.production`**

```bash
# Base URLs
BASE_URL=https://app.example.com
DELEGATES_API_URL=https://api.example.com/delegates
NOTIFICATIONS_API_URL=https://api.example.com/notifications
AUTH_API_URL=https://api.example.com/auth

# Credentials
ENV_PASSWORD=prod-readonly-password
TEST_RECIPIENT_ID=user-456-prod

# API Keys
NOTIFICATIONS_API_KEY=prod-notif-key-xxxxx
```

### 6.2 CLI Usage

```bash
# Run tests against T1 environment
npx ai-ui-auto run tests/ --env t1

# Run against staging
npx ai-ui-auto run tests/ --env staging

# Run specific test against production
npx ai-ui-auto run tests/delegates.md --env production
```

### 6.3 Environment Resolution

1. `--env t1` loads `.env.t1` from the project root
2. Variables from the env file are merged with the process environment
3. Env file values take precedence over existing process environment variables
4. If `--env` is not specified, no env file is loaded (falls back to process environment only)
5. Context files reference variables with `$VAR_NAME` syntax — these resolve from the loaded environment

### 6.4 Spec URLs Per Environment

Since Swagger spec URLs may differ per environment, context files can reference environment variables for the spec URL:

```markdown
## Delegates API
- Spec URL: $DELEGATES_SPEC_URL
- Base URL: $DELEGATES_API_URL
```

The `specs/` cache stores specs keyed by resolved URL to avoid conflicts between environments.

---

## 7. AI Interaction Model (Extended)

### 7.1 API Action Types

New action types added to the existing set (SPEC.md §6.1):

| Action         | Fields                                               | Description                          |
|----------------|------------------------------------------------------|--------------------------------------|
| `api_call`     | `method`, `url`, `headers`, `body`, `description`    | Make an HTTP request                 |
| `extract_csrf` | `source`, `selector`, `description`                  | Extract CSRF token from page/response|
| `extract_value`| `from`, `path`, `as`, `description`                  | Extract value from prior API response|

### 7.2 Extended System Prompt

The AI system prompt is extended with API context when API-related context files are present:

```
## API Context
You can also execute API calls. When a step describes an API operation, return
an "api_call" action instead of browser actions.

### Available APIs
{loaded API context files with auth methods and base URLs}

### OpenAPI Specs
{relevant spec summaries — endpoints, methods, request/response schemas}

### Authentication Rules
- For Front Proxy APIs: use the browser session cookies. If a CSRF token is needed,
  extract it first using an "extract_csrf" action as described in the API context.
- For Private APIs: include the API key header as specified in the context.
- For Serverless APIs: include the Bearer token as specified.
- Authentication is automatic — determine the correct method from the API context.

### API Response History
{summaries of prior API responses in this test, including status and key fields}

### Rules for API Steps
1. Determine the target API by matching the endpoint to a known API from context
2. Use the OpenAPI spec to construct the correct request (method, path, body schema)
3. Apply authentication automatically based on the API type
4. If the step references values from prior steps, extract them from API response history
5. Return the full request details in the "api_call" action
6. If the step includes an assertion about the response, include an "assert" action after the api_call
```

### 7.3 Conversation History with API Responses

Prior API steps are included in conversation history as structured summaries:

```
Step 2 (API): GET /api/delegates/v1/list → 200 OK
Response summary: Array of 3 delegates. First delegate: { id: "abc-123", name: "John Smith", mobile: "0411222333" }

Step 3 (API): PUT /api/delegates/v1/abc-123 → 200 OK
Request body: { mobile: "0400000000" }
Response summary: Updated delegate { id: "abc-123", mobile: "0400000000" }
```

This allows the AI to reference prior responses when planning subsequent steps without carrying full response bodies in context.

---

## 8. Report Extension

### 8.1 API Step Report Content

API steps in the HTML report include:

```
Step 2: Get list of delegates              ✅ PASS
├─ Sub-action 2.1: API Call
│  ├─ Request: GET https://api-t1.example.com/delegates/v1/list
│  ├─ Headers: [collapsible — shows auth headers (redacted), content-type]
│  ├─ Response Status: 200 OK
│  ├─ Response Body: [collapsible — formatted JSON]
│  ├─ Duration: 342ms
│  └─ AI reasoning: "Calling delegates list endpoint, using browser session cookies..."
└─ Duration: 1.1s
```

### 8.2 Auth Flow Visibility

When a step requires CSRF extraction or token retrieval, the report shows the auth sub-actions:

```
Step 3: Update delegate mobile            ✅ PASS
├─ Sub-action 3.1: Extract CSRF Token
│  ├─ Source: /delegates page, hidden input __RequestVerificationToken
│  ├─ Token: [redacted]
│  └─ AI reasoning: "Front proxy API requires CSRF. Extracting from delegates page..."
├─ Sub-action 3.2: API Call
│  ├─ Request: PUT https://api-t1.example.com/delegates/v1/abc-123
│  ├─ Headers: [collapsible — X-CSRF-Token: [redacted], Cookie: [redacted]]
│  ├─ Request Body: { "mobile": "0400000000" }
│  ├─ Response Status: 200 OK
│  ├─ Response Body: [collapsible]
│  └─ AI reasoning: "Updating delegate abc-123 mobile number..."
└─ Duration: 2.3s
```

### 8.3 Sensitive Data Redaction

In reports, the following are redacted by default:
- Cookie values (shown as `[redacted]`)
- CSRF token values
- API key values
- Bearer token values
- Values of environment variables containing `KEY`, `SECRET`, `PASSWORD`, or `TOKEN` in the name

Full values are available in a debug mode (`--debug-report`) for troubleshooting.

---

## 9. Configuration Extension

### 9.1 New Config Fields

Added to `ai-ui-auto.config.ts`:

```typescript
export default defineConfig({
  // ... existing config from SPEC.md §7 ...

  // API Configuration
  api: {
    specsDir: './specs',                   // Cache directory for OpenAPI specs
    requestTimeout: 30_000,                // Default timeout per API request (ms)
    redactSensitive: true,                 // Redact auth values in reports
  },
});
```

### 9.2 New CLI Flags

| Flag       | Type    | Default | Description                     |
|------------|---------|---------|---------------------------------|
| `--env`    | string  | —       | Environment name (loads .env.<name>) |

### 9.3 New CLI Commands

```bash
# Spec management
npx ai-ui-auto specs sync              # Download/update all referenced specs
npx ai-ui-auto specs sync delegates    # Sync a specific spec (matched by context file name)
npx ai-ui-auto specs list              # List cached specs with source URLs and last-synced date
```

---

## 10. Project Structure (Extended)

New files and directories added to the existing structure (SPEC.md §11):

```
ai-ui-automation/
├── ...existing files...
├── specs/                            # Cached OpenAPI/Swagger specs
│   ├── delegates-swagger.json
│   └── notifications-swagger.json
├── src/
│   ├── ...existing files...
│   ├── api/
│   │   ├── client.ts                 # HTTP client (standalone + browser context)
│   │   ├── spec-loader.ts            # OpenAPI spec download, cache, parse
│   │   ├── auth-resolver.ts          # Determine and apply auth per API type
│   │   ├── csrf-handler.ts           # CSRF token extraction logic
│   │   ├── response-store.ts         # Store and query prior API responses
│   │   └── types.ts                  # API-specific type definitions
│   ├── env/
│   │   └── loader.ts                 # Environment file loader (.env.<name>)
│   └── cli/
│       └── commands/
│           └── specs.ts              # Specs sync/list CLI command
```

---

## 11. Dependencies (New)

| Package       | Purpose                             |
|---------------|-------------------------------------|
| `undici`      | HTTP client for standalone API calls|
| `swagger-parser` | OpenAPI spec parsing and validation |

---

## 12. Design Decisions

1. **Extension, not separate tool:** API and UI tests must be combinable in a single test file because real-world test scenarios cross both boundaries (e.g. login via UI, test via API, verify via UI). A separate tool would require complex orchestration to share browser state.

2. **AI-inferred step type over explicit markers:** Requiring prefixes like `API:` or `UI:` adds ceremony and makes tests less natural. The AI is capable of determining intent from the instruction. If ambiguous, the context files (which describe available APIs) help the AI disambiguate.

3. **Swagger specs downloaded and cached locally:** Rather than fetching specs on every run (slow, requires network, specs might change mid-run) or requiring manual management, specs are fetched on first use and cached. The `specs sync` command provides explicit control when updates are needed.

4. **Automatic auth over explicit auth:** The test author should not need to specify "use cookies" or "add x-api-key" in every step. The context file defines the auth method for each API type, and the AI applies it automatically. This keeps test files focused on business intent.

5. **Playwright context.request for front proxy APIs:** This is the natural choice because front proxy endpoints require browser session cookies. Playwright's `APIRequestContext` inherits the cookie jar from the browser context, avoiding manual cookie extraction. For non-browser APIs, a standalone HTTP client avoids unnecessary browser dependency.

6. **Implicit response references over explicit variables:** Rather than requiring `"Save the ID as {{delegateId}}"`, the AI remembers all prior responses and extracts needed values from context. This is more natural and matches how a human tester would work — "update the delegate we just created" is clearer than "update delegate {{delegateId}}".

7. **Separate .env files per environment:** This is the simplest approach that developers are already familiar with. It avoids overcomplicating the config file with nested environment blocks and works well with existing tooling (.gitignore, CI/CD secret injection). Each environment is a flat key-value file.

8. **Sensitive data redaction in reports by default:** API tests will inevitably involve secrets (API keys, tokens, session cookies). Reports should be safe to share and store without leaking credentials. Debug mode is available when full values are needed for troubleshooting.

---

*End of API testing extension specification.*
