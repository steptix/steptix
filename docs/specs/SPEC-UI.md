# Steptix — Runner UI Technical Specification v1.0

**Author:** Paul Kent
**Date:** 2026-03-30
**Status:** Draft

---

## 1. Overview

The Runner UI is an Electron-based desktop application that provides a visual interface for authoring, running, and debugging Markdown test files. It mirrors the capabilities of the existing `steptix run` CLI while adding a real-time execution view, breakpoints, an edit-and-continue pointer, and an inline steering REPL.

The UI is launched via a new CLI command and does not modify or interfere with existing commands.

### Design Principle: Web-Portability

The Electron renderer process is built as a pure web application (React + standard browser APIs). All system-level operations (file I/O, test runner, process spawning) are handled exclusively in the Electron main process via a typed IPC bridge. This clean separation means the renderer can be extracted and served as a standalone web app with a WebSocket backend at a later date with minimal changes.

---

## 2. New CLI Command

```
steptix ui [directory]
```

- `directory` — optional path to the tests root directory. Defaults to `tests/` in the current working directory (same as `steptix.config.json` → `tests.dir`).
- Launches the Electron window and loads the specified directory into the Explorer.
- Accepts the same `--config` and `--env` options as the `run` command.

---

## 3. Layout

The UI is a single-window application with three main panels, styled similarly to VS Code.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Toolbar: [Start] [Stop] [Step Over] [Resume] [Save]   Status: Idle │
├──────────────┬──────────────────────────────┬───────────────────────┤
│              │                              │                       │
│   Explorer   │      Editor / File Tabs      │    Output Panel       │
│              │                              │                       │
│  tests/      │  ┌──────────────────────┐   │  [Step output here]   │
│  ├ login.md  │  │ 1  ---               │   │                       │
│  └ signup.md │  │ 2  tags: [smoke]     │   │  AI Reasoning         │
│              │  │ 3  ---               │   │  Sub-actions          │
│  context/    │  │ 4                    │   │  Screenshot strip     │
│  └ app.md    │  │ 5  # Login Test      │   │                       │
│              │  │ 6                    │   │                       │
│              │  │ 7  ## Steps          │   │                       │
│              │  │●8  1. Navigate to... │   │   [Steering Window]   │
│              │  │→9  2. Enter email... │   │                       │
│              │  │ 10 3. Click Login    │   │  > type step here...  │
│              │  │ 11 4. Verify...      │   │  [Execute]            │
│              │  └──────────────────────┘   │                       │
└──────────────┴──────────────────────────────┴───────────────────────┘
```

### 3.1 Toolbar

| Control | Behaviour |
|---------|-----------|
| **Start** | Begins executing the active test file from the first step (or from the current pointer position if manually moved). Disabled during a run. |
| **Stop** | Cancels the current run immediately. Resets state to Idle. |
| **Step Over** | Visible and enabled only when paused at a breakpoint. Executes the current step then pauses again at the next step. |
| **Resume** | Visible and enabled only when paused. Continues execution until the next breakpoint or end of test. |
| **Save** | Saves changes to the currently active file. Keyboard shortcut: `Ctrl+S` / `Cmd+S`. |
| **Status** | Right-aligned text indicator: `Idle` / `Running` / `Paused` / `Passed` / `Failed`. |

### 3.2 Explorer Panel

- Displays the directory tree rooted at the configured tests directory.
- Shows all files and subdirectories; `.md` files are primary but all files are visible.
- Clicking a `.md` file opens it in a new editor tab (or focuses the tab if already open).
- Tree supports expand/collapse for subdirectories.
- Right-click context menu: **New File**, **Rename**, **Delete**.
- Active running file is highlighted.

### 3.3 Editor Panel

- Tabbed interface — multiple files open simultaneously.
- Tabs show the filename; a dot indicator marks unsaved changes.
- The editor displays the raw Markdown source with line numbers.
- The editor is fully editable at all times, including during a run.
- Syntax highlighting for Markdown and YAML frontmatter.

#### Execution Indicators (step lines only)

Step lines are lines inside the `## Steps` section that begin with a list item number (e.g. `1.`, `2.`).

| Indicator | Meaning |
|-----------|---------|
| Yellow `→` arrow on the line number gutter | The currently executing (or paused) step |
| Red `●` dot on the line number gutter | A breakpoint is set on this step |
| Green `✓` dim overlay on the line | Step completed — passed |
| Red `✗` dim overlay on the line | Step completed — failed |

Non-step lines (frontmatter, headings, config, parameters, blank lines) never receive execution indicators or breakpoints.

#### Setting Breakpoints

- Click the gutter (left of the line number) on any step line to toggle a breakpoint.
- Breakpoints can be added or removed at any time — before a run, during a run, or while paused.
- Breakpoints persist for the lifetime of the UI session but are not saved to the file.

#### Moving the Execution Pointer

- When the run is **paused**, the user can drag the yellow `→` arrow up or down to a different step line, or right-click a step line and choose **Move Execution Here**.
- Execution resumes from the new position when **Resume** or **Step Over** is clicked.
- The browser is **not** reset — execution continues with the current browser state.
- Moving the pointer does not skip or replay steps in the report; only steps that actually execute are recorded.
- Moving is only supported within the currently running test file.

### 3.4 Output Panel

The output panel has two sub-sections: the **Step Output** area and the **Steering Window**.

#### Step Output Area

- Displays the detailed output for whichever step line is **currently selected** (clicked) in the editor.
- Clicking a different step line updates this panel immediately.
- While a step is actively executing, the panel updates in real time as sub-actions arrive.
- Content mirrors the final HTML report format:
  - AI reasoning text
  - List of sub-actions with pass/fail status
  - Thumbnail screenshot strip (one thumbnail per sub-action screenshot)
  - Clicking a thumbnail opens the screenshot full-size in a modal overlay
  - Any assertion values extracted by the AI
  - Error message and AI explanation on failure

#### Steering Window

- Visible at all times; active (input enabled) only when the run is **paused at a breakpoint**.
- Behaves identically to the `[interactive]` REPL in the existing runner:
  - User types a free-form natural language instruction and presses **Execute** (or `Enter`).
  - The instruction is executed as an AI-driven step against the current browser state.
  - Results (pass/fail, sub-actions, screenshots) appear in the Step Output area above.
  - The instruction is added to the session's conversation history so subsequent steps have context.
  - The loop continues — the user can type more instructions without resuming.
  - Manual steps executed in the steering window are **not** written back to the test file.
- Typing `/continue` or clicking **Resume** ends the steering session and resumes the test. Other slash commands (`/exit`, `/help`, `/list`) follow the same vocabulary as the CLI REPL.
- When the run is not paused, the steering input is visually disabled with placeholder text: `"Paused at a breakpoint to use steering"`.

---

## 4. Execution Flow

### 4.1 Normal Run

```
User clicks Start
  → Runner begins at step 1 (or current pointer position)
  → For each step:
      → Yellow arrow moves to step line
      → Step executes (AI + Playwright)
      → Step output streams into Output Panel
      → Step completes → line gets ✓ or ✗ overlay
      → If a breakpoint is set on this step → pause (see 4.2)
  → All steps complete → Status: Passed or Failed
  → Execution indicators remain visible
  → UI resets to Idle-ready state (Start button re-enabled)
```

### 4.2 Breakpoint Pause

```
Runner reaches a step with a breakpoint set
  → Execution pauses before executing that step
  → Yellow arrow remains on the breakpoint line
  → Status changes to: Paused
  → Step Over, Resume buttons become active
  → Steering Window becomes active

User options:
  A. Type instructions in Steering Window → execute one or more manual steps
  B. Move the pointer to a different step
  C. Click Step Over → execute current step, pause at next step
  D. Click Resume → continue to next breakpoint or end of test
  E. Click Stop → cancel the run
```

### 4.3 Step Over

- Executes the step the pointer is currently on.
- After completion, pauses at the immediately following step (regardless of whether it has a breakpoint).

### 4.4 Input Steps (`[input: variable]`)

- When the runner reaches an `[input: variable]` step, the UI presents a modal dialog with the prompt text and a text input field.
- The user types the value and clicks **Submit**.
- Execution continues with the value stored as a parameter.

### 4.5 Interactive Steps (`[interactive]`)

- When the runner reaches an `[interactive]` step, execution automatically pauses and the Steering Window activates — identical to a breakpoint pause.
- The step is considered complete when the user clicks **Resume** or types `/continue`.

---

## 5. Architecture

### 5.1 Process Separation

```
┌──────────────────────────────────────────────────────┐
│  Electron Main Process                                │
│  - File system access (read, write, watch)            │
│  - Spawns / controls the test runner                  │
│  - Manages Playwright browser session                 │
│  - IPC bridge (typed event bus)                       │
└──────────────────────┬───────────────────────────────┘
                       │ IPC (contextBridge)
┌──────────────────────▼───────────────────────────────┐
│  Electron Renderer Process (pure web app)             │
│  - React UI                                           │
│  - No direct Node.js / file system access             │
│  - All state managed in renderer; updated via IPC     │
│  - Could be replaced with WebSocket bridge for web    │
└──────────────────────────────────────────────────────┘
```

### 5.2 IPC Event Bus

All communication between main and renderer is via a typed, named-event IPC bridge exposed through Electron's `contextBridge`.

#### Main → Renderer Events

| Event | Payload | Description |
|-------|---------|-------------|
| `runner:step-start` | `{ stepIndex, instruction, totalSteps }` | A step has begun executing |
| `runner:step-complete` | `{ stepIndex, status, durationMs }` | A step finished |
| `runner:subaction` | `{ stepIndex, subAction: SubActionResult }` | A sub-action completed within a step |
| `runner:screenshot` | `{ stepIndex, dataUrl }` | Screenshot taken (base64 data URL) |
| `runner:ai-reasoning` | `{ stepIndex, text }` | AI reasoning text chunk (streamed) |
| `runner:paused` | `{ stepIndex, reason: 'breakpoint' \| 'interactive' \| 'input' \| 'stepover' }` | Execution paused |
| `runner:resumed` | `{}` | Execution resumed |
| `runner:complete` | `{ status: 'passed' \| 'failed', summary }` | Run finished |
| `runner:error` | `{ message }` | Fatal runner error |
| `file:changed` | `{ path, content }` | File changed externally (fs watch) |

#### Renderer → Main Events

| Event | Payload | Description |
|-------|---------|-------------|
| `runner:start` | `{ filePath, breakpoints: number[] }` | Start a test run |
| `runner:stop` | `{}` | Cancel the run |
| `runner:resume` | `{}` | Resume from pause |
| `runner:step-over` | `{}` | Execute one step then pause |
| `runner:move-pointer` | `{ toStepIndex }` | Move execution pointer |
| `runner:steer` | `{ instruction }` | Execute a manual steering instruction |
| `runner:input-response` | `{ variable, value }` | User response to an `[input:]` prompt |
| `file:read` | `{ path }` → `{ content }` | Read a file |
| `file:write` | `{ path, content }` | Write a file |
| `file:list` | `{ dir }` → `{ tree }` | List directory tree |
| `file:create` | `{ path }` | Create a new file |
| `file:rename` | `{ from, to }` | Rename a file |
| `file:delete` | `{ path }` | Delete a file |

### 5.3 Runner Integration

The main process integrates with the existing test runner (`src/runner/test-runner.ts`) with the following adaptations:

- The runner is invoked in-process (not as a subprocess) so IPC events can be emitted synchronously during execution.
- A `UIRunnerAdapter` wraps the existing runner, intercepting step lifecycle points to emit IPC events.
- Breakpoint checking occurs at the start of each step: if the step index is in the breakpoint set, the runner suspends and emits `runner:paused`.
- Suspension is implemented via a `Promise` that resolves when `runner:resume` or `runner:step-over` is received.
- The steering REPL maps directly to the existing `[interactive]` REPL logic, but instead of `readline`, it waits on `runner:steer` IPC events.
- Pointer movement sets the runner's internal step counter before the next iteration.

### 5.4 Technology Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Electron (latest stable) |
| Renderer framework | React 18 |
| Editor component | CodeMirror 6 (Markdown + YAML language support, custom gutter for breakpoints/pointer) |
| Styling | CSS Modules or Tailwind CSS |
| Build tool | Vite (renderer) + TypeScript |
| IPC typing | Shared `ipc-types.ts` file imported by both main and renderer |

---

## 6. File & Directory Structure

New files and directories added to the project:

```
src/
  ui/
    main/                  ← Electron main process
      index.ts             ← Main entry point, creates BrowserWindow
      ipc-handler.ts       ← Registers all IPC handlers
      runner-adapter.ts    ← Wraps test runner with IPC event emission
      file-manager.ts      ← File system operations
    renderer/              ← React web app (pure browser code)
      index.html
      index.tsx
      App.tsx
      components/
        Explorer.tsx
        EditorTabs.tsx
        Editor.tsx         ← CodeMirror wrapper with gutter extensions
        OutputPanel.tsx
        SteeringWindow.tsx
        Toolbar.tsx
        ScreenshotStrip.tsx
        ScreenshotModal.tsx
      hooks/
        useRunnerState.ts
        useIpc.ts
        useFileTree.ts
      ipc-types.ts         ← Shared IPC event types (imported by main + renderer)
    preload.ts             ← contextBridge IPC exposure
electron-builder.config.ts ← Electron packaging config
```

New CLI command registered in `src/cli/commands/ui.ts` and added to `src/cli/index.ts`.

---

## 7. State Model

The renderer maintains a single run state object:

```typescript
type RunState =
  | { status: 'idle' }
  | { status: 'running';   currentStep: number }
  | { status: 'paused';    currentStep: number; reason: PauseReason }
  | { status: 'complete';  result: 'passed' | 'failed' }

type PauseReason = 'breakpoint' | 'interactive' | 'input' | 'stepover'

interface StepOutput {
  stepIndex: number
  instruction: string
  status: 'pending' | 'running' | 'passed' | 'failed'
  aiReasoning: string          // streamed
  subActions: SubActionResult[]
  screenshots: string[]        // base64 data URLs
  error?: string
  durationMs?: number
}
```

- `breakpoints` is a `Set<number>` of step indices managed entirely in the renderer and sent to main on start.
- `stepOutputs` is a `Map<number, StepOutput>` — the Output Panel reads from this map for whichever step is selected.

---

## 8. Behaviour Details

### 8.1 Editing During a Run

- The editor remains editable during a run.
- Changes to the file during a run do not affect the in-progress execution — the runner operates on the parsed test loaded at start time.
- If the file is modified and saved during a run, a banner appears: `"File saved — changes will take effect on next run"`.

### 8.2 Execution Indicators Reset

- When **Start** is clicked, all existing `✓`/`✗` overlays and the `→` arrow are cleared.
- Breakpoints (`●`) are preserved across runs.

### 8.3 Post-Run State

- After a run completes, all step overlays remain visible showing pass/fail for each step.
- The pointer arrow is removed.
- The **Start** button re-enables.
- The Output Panel shows the output for the last selected step.
- No automatic reset — the user sees the final state until they click Start again.

### 8.4 Multi-File Tabs

- Each tab is independently editable.
- Only the **active tab** can be run — Start always runs the file in the focused tab.
- Closing a tab with unsaved changes prompts: `"Save changes to [filename] before closing?"` with Save / Discard / Cancel options.

### 8.5 External File Changes

- The main process watches the tests directory with `fs.watch`.
- If a file currently open in a tab is modified externally, a banner appears: `"File changed on disk — [Reload] [Keep My Version]"`.

---

## 9. Out of Scope (v1.0)

- Running multiple test files in sequence from the UI (use the CLI `run` command for batch runs)
- Tag filtering in the UI
- Saving manual steering steps back to the test file
- Moving the execution pointer across different files
- Resetting browser state when moving the pointer
- Diff/version history for test files
- Remote / web-hosted version (architecture supports it; implementation deferred)
