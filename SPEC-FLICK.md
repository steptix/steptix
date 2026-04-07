# Flick — UI Client Specification

## Overview

Flick is a lightweight desktop application for sending natural language steps to the ai-ui-automation Sessions API. It presents a chat-style interface where non-technical users can type instructions, submit them, and see results — including screenshots — from browser sessions running locally or on remote machines.

Built with Tauri. Distributed as a single executable with no installer required. Runs on Windows, macOS, and Linux.

The project lives at `flick/` within the ai-ui-automation repository.

---

## Window Behavior

### Initial State

- **Size**: 420px wide x 300px tall.
- **Position**: Bottom-right corner of the screen.
- **Appearance**: Normal taskbar application (not system tray).

### Expansion

- When the first result appears in the chat view, the window animates smoothly upward, expanding vertically until it reaches near-full screen height.
- The window stays pinned to the bottom-right as it grows — the bottom-right corner remains anchored.
- The user can freely resize and reposition the window at any time. Manual repositioning overrides the pinned behavior.

### Always-on-Top

- A pin icon in the title bar toggles always-on-top mode.
- Default: off.

### Window Title

- Format: `Flick — {active session display name}`
- When no session is open: `Flick`

---

## Layout

```
+---------------------------------------------------------------+
| [Tab 1] [Tab 2] [Tab 3] [+]           [status dot] [gear]    |
+---------------------------------------------------------------+
|                                                                |
|   Chat history (scrollable)                                    |
|                                                                |
|   +-- User message card --------------------------------+      |
|   | 1. Navigate to facebook.com                         |      |
|   | 2. Click the login button                           |      |
|   +-----------------------------------------------------+      |
|                                                                |
|   +-- Result card (collapsed) --------------------------+      |
|   | > Step 1: Navigate to facebook.com        [PASSED]  |      |
|   | > Step 2: Click the login button          [PASSED]  |      |
|   +-----------------------------------------------------+      |
|                                                                |
+---------------------------------------------------------------+
| | Type your steps here...                              [send] |
| |                                                      [icon] |
+---------------------------------------------------------------+
```

### Top Bar

- **Tabs**: horizontally scrollable row of session tabs.
- **"+" button**: creates a new session (right side of tab row).
- **"x" button**: on each tab, deletes that session (with confirmation).
- **Status dot**: green (connected) or red (disconnected), right side of top bar.
- **Gear icon**: opens settings screen, right side of top bar.

### Chat View (middle)

- Scrollable vertical area showing the conversation history for the active session.
- Content is arranged chronologically, newest at the bottom.
- The view auto-scrolls to the bottom when new content appears.

### Input Box (bottom)

- Multi-line text input area.
- Placeholder text: `Type your steps here...`
- **Enter** key submits the steps.
- **Shift+Enter** inserts a new line.
- **Send button**: arrow icon, positioned at the bottom-right of the input box. Clicks submit the steps.
- After submission, the input box clears.
- While steps are executing, a spinner is shown and the input is disabled.

---

## Tabs & Session Management

### Creating a Session

- Clicking "+" creates a new session.
- A GUID is generated as the session ID (used in API calls as the `:id` parameter).
- The tab displays a default name: `New Session`.
- The user can rename the session by clicking on the tab name (inline edit) or double-clicking the tab.
- The GUID is shown in a tooltip when the user hovers over the tab.

### Switching Sessions

- Clicking a tab switches the chat view to that session's history.
- The window title updates to reflect the active session name.

### Deleting a Session

1. User clicks the "x" on a tab.
2. A confirmation dialog appears: `Delete "{session name}"? This will close the browser session.`
3. On confirm:
   - A "Close the browser" step is sent to `POST /sessions/:id/steps` to terminate the server-side browser session.
   - The tab and all local history for that session are removed.
   - If the deleted tab was active, the nearest remaining tab becomes active. If no tabs remain, the UI shows an empty state.
4. On cancel: no action.

### Tab Overflow

- When tabs exceed the available width, the tab bar scrolls horizontally.

---

## Step Input & Parsing

### Input Format

The user types steps as plain text in the input box, one step per line. The following formats are all supported and parsed into individual steps:

**Plain lines** (each non-empty line is one step):
```
Navigate to facebook.com
Click the login button
Enter "user@example.com" in the email field
```

**Numbered list** (the number prefix is stripped):
```
1. Navigate to facebook.com
2. Click the login button
3. Enter "user@example.com" in the email field
```

**Dashed list** (the dash prefix is stripped):
```
- Navigate to facebook.com
- Click the login button
- Enter "user@example.com" in the email field
```

Empty lines are ignored. The parsed steps are sent as the `steps` array in `POST /sessions/:id/steps`.

### Submission Flow

1. User types steps and presses Enter (or clicks the send button).
2. The input text appears immediately in the chat view as a **user message card** showing the steps as the user typed them.
3. The input box clears.
4. A spinner appears below the user message card.
5. The parsed steps are sent to `POST /sessions/:id/steps`.
6. If this is the first request for this session (the session GUID has not been used with the API before), no `config` is sent — server defaults apply.
7. On response, the spinner is replaced with a **result card**.

---

## Chat View Content

### User Message Card

Displays the steps exactly as the user typed them. Styled distinctly from result cards (e.g. right-aligned or different background) to visually separate input from output.

### Result Card

Displays the API response for a batch of steps. Each step is shown as a collapsible row.

#### Collapsed State (default)

Each step shows one line:
- Expand/collapse chevron
- Step number
- Step text (truncated if long)
- Status badge: `PASSED` (green), `FAILED` (red), or `ERROR` (orange)

#### Expanded State

When a step row is expanded, it shows:
- **Status**: passed / failed / error
- **Reasoning**: the AI's reasoning text
- **Actions**: list of actions taken (type, selector, url, etc.)
- **Screenshot**: thumbnail image (see Screenshots section)
- **Outputs**: any captured output variables displayed as key-value pairs (e.g. `username: Jane Smith`)

#### Batch-Level Information

At the bottom of the result card:
- Steps completed: `{stepsCompleted} / {stepsTotal}`
- Overall status badge
- Accumulated outputs for this batch (if any new outputs were captured)

#### Error Display

If a step fails, its row is automatically expanded to show the error message and screenshot so the user can immediately see what went wrong.

### Output Variables

When a step captures outputs (via `[output: var]` syntax), they are displayed inline in that step's expanded view. Accumulated outputs across the session are not shown in a separate panel — they appear naturally in the chat history where they were captured.

---

## Screenshots

### Storage

- Screenshots returned by the API (base64-encoded) are decoded and saved to disk in the app's data directory.
- Directory structure: `{app_data}/flick/screenshots/{session_guid}/{timestamp}_{step_index}.png`
- The chat view references these files rather than holding base64 data in memory or local storage.

### Display

- **Thumbnail**: shown inline in the expanded step view. Fixed width (e.g. 320px), maintaining aspect ratio. Displayed vertically — each step's screenshot appears below the previous one.
- **Full view**: clicking a thumbnail opens the full-size image in a modal/overlay. The user can close it by clicking outside or pressing Escape.

---

## Settings

Accessed via the gear icon in the top bar. Opens as a modal or slide-over panel.

### Fields

| Field             | Description                                      | Default              |
|-------------------|--------------------------------------------------|----------------------|
| API URL           | Full URL of the API server (e.g. `http://127.0.0.1:3100`) | `http://127.0.0.1:3100` |
| API Key           | The `x-api-key` value for authentication         | (empty)              |
| Default Base URL  | Default `config.baseUrl` for new sessions        | (empty)              |
| Default Timeout   | Default `config.timeout` for new sessions (e.g. `30s`) | (empty)              |

### Behavior

- Settings are persisted to disk in the app's data directory (e.g. `{app_data}/flick/settings.json`).
- Changes take effect immediately on save.
- If Default Base URL or Default Timeout are set, they are sent as `config` on the first request of each new session. If both are empty, no `config` is sent.

---

## Connection Status

### Status Indicator

- A small dot in the top bar, next to the gear icon.
- **Green**: API server is reachable.
- **Red**: API server is not reachable.
- The app periodically pings the API server (e.g. `GET /sessions`) to determine connectivity. Interval: every 15 seconds when idle, more frequently when actively executing steps.

### Behavior When Disconnected

- The UI remains fully usable: the user can switch tabs, read history, type steps, access settings.
- A non-blocking toast appears when the connection is lost: `Cannot connect to server`.
- If the user submits steps while disconnected, an error toast appears: `Cannot reach the API server. Check your connection and settings.`
- When the connection is restored, the status dot turns green and a toast appears: `Connected to server`.

---

## Stale Session Indicator

When the app restarts, locally persisted sessions may no longer exist on the API server (e.g. the server also restarted).

### Detection

- When the user switches to a session tab or submits steps, the app checks the session status via `GET /sessions/:id`.
- If the API returns `404`, the session is marked as stale.

### Display

- A small info banner appears at the top of the chat view: `Server session was reset. A new browser will start on the next step.`
- The chat history is preserved (it's local data), but the user understands that server-side state (browser, outputs) is gone.
- On the next step submission, the API implicitly creates a new server-side session with the same GUID.

---

## Local Persistence

All local data is stored in the OS-appropriate app data directory:
- **Windows**: `%APPDATA%/flick/`
- **macOS**: `~/Library/Application Support/flick/`
- **Linux**: `~/.local/share/flick/`

### Data Stored

| File / Directory       | Contents                                              |
|------------------------|-------------------------------------------------------|
| `settings.json`        | API URL, API key, default config values               |
| `sessions.json`        | Array of sessions: GUID, display name, tab order      |
| `history/{guid}.json`  | Chat history for each session (step inputs + results, with screenshot file references) |
| `screenshots/{guid}/`  | Screenshot image files for each session               |

### Limits

- No limit on history per session.
- No limit on number of sessions.
- Screenshots are stored as individual PNG files on disk.
- When a session is deleted, its history file and screenshot directory are also deleted.

---

## Theming

- Light mode only.
- Clean, neutral color palette.
- Suggested palette:
  - Background: white (`#FFFFFF`)
  - Surface/cards: light gray (`#F5F5F5`)
  - Primary accent: blue (`#2563EB`)
  - Text: dark gray (`#1A1A1A`)
  - Success/passed: green (`#16A34A`)
  - Error/failed: red (`#DC2626`)
  - Warning/error status: orange (`#EA580C`)
  - Border: light gray (`#E5E5E5`)
- Typography: system font stack (SF Pro on macOS, Segoe UI on Windows, system sans-serif on Linux).

---

## Technology

- **Framework**: Tauri v2
- **Frontend**: HTML/CSS/TypeScript (framework choice TBD during implementation — could be vanilla, Svelte, or React)
- **Backend**: Rust (Tauri core) — handles file I/O, screenshot storage, settings persistence
- **Distribution**: single executable per platform, no installer required
- **Project location**: `flick/` directory within the ai-ui-automation repository

---

## Out of Scope (v1)

- Dark mode / theme switching
- Parameter input UI (advanced feature, deferred)
- Session export or sharing
- Multi-user / authentication
- Drag-and-drop tab reordering
- Step editing or re-running from history
- Keyboard shortcuts beyond Enter/Shift+Enter
- Auto-update mechanism
- System tray mode
- Step syntax highlighting in the input box
