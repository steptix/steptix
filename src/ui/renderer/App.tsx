import React, { useReducer, createContext, useContext, useEffect } from 'react';
import type { RunState, StepOutput, SubActionResult, AiInteraction } from '../ipc-types';
import { Toolbar } from './components/Toolbar';
import { Explorer } from './components/Explorer';
import { EditorTabs } from './components/EditorTabs';
import { Editor } from './components/Editor';
import { OutputPanel } from './components/OutputPanel';
import { LogPanel } from './components/LogPanel';
import { InputModal } from './components/InputModal';

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------
export interface LogEntry {
  id: number;
  level: 'info' | 'success' | 'error' | 'warn' | 'detail';
  message: string;
  timestamp: string;
}

let logIdCounter = 0;

function now(): string {
  return new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function describeSubAction(sa: SubActionResult): string {
  const a = sa.action;
  switch (a.action) {
    case 'click':    return `click ${a.selector ?? a.description}`;
    case 'type':     return `type "${a.value ?? ''}" → ${a.selector ?? ''}`;
    case 'navigate': return `navigate → ${a.url ?? ''}`;
    case 'openPage': return `open new page → ${a.url ?? ''}`;
    case 'assert':   return `assert: ${a.condition ?? a.description}`;
    case 'wait':     return `wait ${a.condition ? `"${a.condition}"` : `${a.timeout ?? ''}ms`}`;
    case 'select':   return `select "${a.value ?? ''}" in ${a.selector ?? ''}`;
    case 'api_call': return `${a.method ?? 'GET'} ${a.url ?? ''}`;
    case 'extract_csrf':  return `extract CSRF from ${a.source ?? a.selector ?? ''}`;
    case 'extract_value': return `extract ${a.path ?? ''} as ${a.as ?? ''}`;
    case 'scroll':   return `scroll ${a.direction ?? ''} ${a.amount ?? ''}px`;
    case 'keyboard': return `keyboard: ${a.key ?? ''}`;
    default:         return `${a.action}${a.description ? ` — ${a.description}` : ''}`;
  }
}

// ---------------------------------------------------------------------------
// Tab model
// ---------------------------------------------------------------------------
export interface TabInfo {
  filePath: string;
  fileName: string;
  content: string;
  dirty: boolean;
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
export interface AppState {
  tabs: TabInfo[];
  activeTabIndex: number;
  runState: RunState;
  stepOutputs: Map<number, StepOutput>;
  breakpoints: Set<number>;
  selectedStep: number | null;
  currentStep: number | null;
  runningFile: string | null;
  reportPath: string | null;
  testsDir: string;
  inputPrompt: { prompt: string; variable: string } | null;
  logs: LogEntry[];
}

const initialState: AppState = {
  tabs: [],
  activeTabIndex: -1,
  runState: { status: 'idle' },
  stepOutputs: new Map(),
  breakpoints: new Set(),
  selectedStep: null,
  currentStep: null,
  runningFile: null,
  reportPath: null,
  testsDir: '',
  inputPrompt: null,
  logs: [],
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
export type AppAction =
  | { type: 'OPEN_FILE'; filePath: string; fileName: string; content: string }
  | { type: 'CLOSE_TAB'; index: number }
  | { type: 'SET_ACTIVE_TAB'; index: number }
  | { type: 'UPDATE_TAB_CONTENT'; index: number; content: string }
  | { type: 'MARK_TAB_SAVED'; index: number }
  | { type: 'SET_RUN_STATE'; runState: RunState }
  | { type: 'SET_STEP_OUTPUT'; stepIndex: number; output: StepOutput }
  | { type: 'UPDATE_STEP_OUTPUT'; stepIndex: number; patch: Partial<StepOutput> }
  | { type: 'TOGGLE_BREAKPOINT'; stepIndex: number }
  | { type: 'SET_SELECTED_STEP'; stepIndex: number | null }
  | { type: 'SET_CURRENT_STEP'; stepIndex: number | null }
  | { type: 'SET_RUNNING_FILE'; filePath: string | null }
  | { type: 'SET_TESTS_DIR'; dir: string }
  | { type: 'CLEAR_EXECUTION_STATE' }
  | { type: 'SET_INPUT_PROMPT'; prompt: string; variable: string }
  | { type: 'CLEAR_INPUT_PROMPT' }
  | { type: 'RELOAD_TAB_CONTENT'; filePath: string; content: string }
  | { type: 'ADD_LOG'; level: LogEntry['level']; message: string }
  | { type: 'SET_REPORT_PATH'; path: string | null }
  | { type: 'UPDATE_STEP_AI_INTERACTIONS'; stepIndex: number; aiInteractions: AiInteraction[]; domSnapshot?: string };

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'OPEN_FILE': {
      const existing = state.tabs.findIndex((t) => t.filePath === action.filePath);
      if (existing >= 0) {
        return { ...state, activeTabIndex: existing };
      }
      const newTab: TabInfo = {
        filePath: action.filePath,
        fileName: action.fileName,
        content: action.content,
        dirty: false,
      };
      const tabs = [...state.tabs, newTab];
      return { ...state, tabs, activeTabIndex: tabs.length - 1 };
    }
    case 'CLOSE_TAB': {
      const tabs = state.tabs.filter((_, i) => i !== action.index);
      let activeTabIndex = state.activeTabIndex;
      if (action.index === activeTabIndex) {
        activeTabIndex = Math.min(activeTabIndex, tabs.length - 1);
      } else if (action.index < activeTabIndex) {
        activeTabIndex--;
      }
      return { ...state, tabs, activeTabIndex };
    }
    case 'SET_ACTIVE_TAB':
      return { ...state, activeTabIndex: action.index };
    case 'UPDATE_TAB_CONTENT': {
      const tabs = state.tabs.map((t, i) =>
        i === action.index ? { ...t, content: action.content, dirty: true } : t,
      );
      return { ...state, tabs };
    }
    case 'MARK_TAB_SAVED': {
      const tabs = state.tabs.map((t, i) =>
        i === action.index ? { ...t, dirty: false } : t,
      );
      return { ...state, tabs };
    }
    case 'SET_RUN_STATE':
      return { ...state, runState: action.runState };
    case 'SET_STEP_OUTPUT': {
      const stepOutputs = new Map(state.stepOutputs);
      stepOutputs.set(action.stepIndex, action.output);
      return { ...state, stepOutputs };
    }
    case 'UPDATE_STEP_OUTPUT': {
      const stepOutputs = new Map(state.stepOutputs);
      const existing = stepOutputs.get(action.stepIndex);
      if (existing) {
        stepOutputs.set(action.stepIndex, { ...existing, ...action.patch });
      }
      return { ...state, stepOutputs };
    }
    case 'TOGGLE_BREAKPOINT': {
      const breakpoints = new Set(state.breakpoints);
      if (breakpoints.has(action.stepIndex)) {
        breakpoints.delete(action.stepIndex);
      } else {
        breakpoints.add(action.stepIndex);
      }
      return { ...state, breakpoints };
    }
    case 'SET_SELECTED_STEP':
      return { ...state, selectedStep: action.stepIndex };
    case 'SET_CURRENT_STEP':
      return { ...state, currentStep: action.stepIndex };
    case 'SET_RUNNING_FILE':
      return { ...state, runningFile: action.filePath };
    case 'SET_TESTS_DIR':
      return { ...state, testsDir: action.dir };
    case 'CLEAR_EXECUTION_STATE':
      return {
        ...state,
        stepOutputs: new Map(),
        currentStep: null,
        selectedStep: null,
        reportPath: null,
        logs: [],
      };
    case 'SET_REPORT_PATH':
      return { ...state, reportPath: action.path };
    case 'UPDATE_STEP_AI_INTERACTIONS': {
      const stepOutputs = new Map(state.stepOutputs);
      const existing = stepOutputs.get(action.stepIndex);
      if (existing) {
        stepOutputs.set(action.stepIndex, {
          ...existing,
          aiInteractions: action.aiInteractions,
          ...(action.domSnapshot !== undefined && { domSnapshot: action.domSnapshot }),
        });
      }
      return { ...state, stepOutputs };
    }
    case 'ADD_LOG':
      return {
        ...state,
        logs: [...state.logs, {
          id: ++logIdCounter,
          level: action.level,
          message: action.message,
          timestamp: now(),
        }],
      };
    case 'SET_INPUT_PROMPT':
      return { ...state, inputPrompt: { prompt: action.prompt, variable: action.variable } };
    case 'CLEAR_INPUT_PROMPT':
      return { ...state, inputPrompt: null };
    case 'RELOAD_TAB_CONTENT': {
      const tabs = state.tabs.map((t) =>
        t.filePath === action.filePath ? { ...t, content: action.content, dirty: false } : t,
      );
      return { ...state, tabs };
    }
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------
export const AppStateContext = createContext<AppState>(initialState);
export const AppDispatchContext = createContext<React.Dispatch<AppAction>>(() => {});

export function useAppState() {
  return useContext(AppStateContext);
}

export function useAppDispatch() {
  return useContext(AppDispatchContext);
}

// ---------------------------------------------------------------------------
// App component
// ---------------------------------------------------------------------------
export function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);

  // Get initial data (testsDir) on mount
  useEffect(() => {
    if (window.electronBridge) {
      window.electronBridge.getInitialData().then((data) => {
        dispatch({ type: 'SET_TESTS_DIR', dir: data.testsDir });
      });
    }
  }, []);

  // Subscribe to runner IPC events
  useEffect(() => {
    const bridge = window.electronBridge;
    if (!bridge) return;

    const unsubs: Array<() => void> = [];

    unsubs.push(
      bridge.on('runner:step-start', (data) => {
        dispatch({ type: 'ADD_LOG', level: 'info', message: `→ Step ${data.stepIndex}/${data.totalSteps}: ${data.instruction}` });
        dispatch({ type: 'SET_CURRENT_STEP', stepIndex: data.stepIndex });
        dispatch({
          type: 'SET_STEP_OUTPUT',
          stepIndex: data.stepIndex,
          output: {
            stepIndex: data.stepIndex,
            instruction: data.instruction,
            status: 'running',
            aiReasoning: '',
            aiInteractions: [],
            subActions: [],
            screenshots: [],
          },
        });
        dispatch({ type: 'SET_RUN_STATE', runState: { status: 'running', currentStep: data.stepIndex } });
      }),
    );

    unsubs.push(
      bridge.on('runner:step-complete', (data) => {
        const dur = (data.durationMs / 1000).toFixed(1);
        if (data.status === 'passed') {
          dispatch({ type: 'ADD_LOG', level: 'success', message: `✓ Step ${data.stepIndex} passed (${dur}s)` });
        } else if (data.status === 'skipped') {
          // A decision the run made, or a step a `return` left behind — not a
          // problem either way: the untaken branch of a chain, a loop body
          // that never ran, an unattended `[input:]`, or everything after a
          // `return` in this flow. The reason says which.
          dispatch({
            type: 'ADD_LOG',
            level: 'info',
            message: `— Step ${data.stepIndex} skipped${data.reason ? `: ${data.reason}` : ''}`,
          });
        } else {
          const errPart = data.error ? `: ${data.error}` : '';
          dispatch({ type: 'ADD_LOG', level: 'error', message: `✗ Step ${data.stepIndex} failed${errPart} (${dur}s)` });
        }
        dispatch({
          type: 'UPDATE_STEP_OUTPUT',
          stepIndex: data.stepIndex,
          patch: { status: data.status, durationMs: data.durationMs, error: data.error },
        });
      }),
    );

    // Note: subaction, screenshot, and ai-reasoning events are handled
    // in a separate useEffect below using stateRef for array-append logic.

    unsubs.push(
      bridge.on('runner:paused', (data) => {
        dispatch({ type: 'ADD_LOG', level: 'warn', message: `⏸ Paused at step ${data.stepIndex} (${data.reason})` });
        dispatch({
          type: 'SET_RUN_STATE',
          runState: { status: 'paused', currentStep: data.stepIndex, reason: data.reason },
        });
        dispatch({ type: 'SET_CURRENT_STEP', stepIndex: data.stepIndex });
        if (data.reason === 'input' && data.inputPrompt && data.inputVariable) {
          dispatch({
            type: 'SET_INPUT_PROMPT',
            prompt: data.inputPrompt,
            variable: data.inputVariable,
          });
        }
      }),
    );

    unsubs.push(
      bridge.on('runner:resumed', () => {
        dispatch({ type: 'ADD_LOG', level: 'info', message: '▶ Resumed' });
        dispatch({ type: 'SET_RUN_STATE', runState: { status: 'running', currentStep: 0 } });
      }),
    );

    unsubs.push(
      bridge.on('runner:complete', (data) => {
        dispatch({ type: 'ADD_LOG', level: data.status === 'passed' ? 'success' : 'error', message: data.status === 'passed' ? '✓ Test passed' : '✗ Test failed' });
        if (data.reportPath) {
          dispatch({ type: 'ADD_LOG', level: 'info', message: `📄 Report: ${data.reportPath}` });
        }
        dispatch({
          type: 'SET_RUN_STATE',
          runState: { status: 'complete', result: data.status },
        });
        dispatch({ type: 'SET_CURRENT_STEP', stepIndex: null });
        dispatch({ type: 'SET_RUNNING_FILE', filePath: null });
        dispatch({ type: 'SET_REPORT_PATH', path: data.reportPath ?? null });
      }),
    );

    unsubs.push(
      bridge.on('runner:error', (data) => {
        dispatch({ type: 'ADD_LOG', level: 'error', message: `✗ Error: ${data.message}` });
        dispatch({
          type: 'SET_RUN_STATE',
          runState: { status: 'complete', result: 'failed' },
        });
      }),
    );

    unsubs.push(
      bridge.on('runner:log', (data) => {
        const level = data.level === 'warn' ? 'warn' : data.level === 'error' ? 'error' : 'detail';
        dispatch({ type: 'ADD_LOG', level, message: data.message });
      }),
    );

    return () => unsubs.forEach((fn) => fn());
  }, []);

  // Better approach: use refs to handle array-append events
  const stateRef = React.useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const bridge = window.electronBridge;
    if (!bridge) return;

    const unsubs: Array<() => void> = [];

    unsubs.push(
      bridge.on('runner:subaction', (data) => {
        const sa = data.subAction;
        const desc = describeSubAction(sa);
        dispatch({ type: 'ADD_LOG', level: sa.error ? 'error' : 'detail', message: `  · ${desc}${sa.error ? ` — ${sa.error}` : ''}` });
        const existing = stateRef.current.stepOutputs.get(data.stepIndex);
        if (existing) {
          dispatch({
            type: 'SET_STEP_OUTPUT',
            stepIndex: data.stepIndex,
            output: {
              ...existing,
              subActions: [...existing.subActions, data.subAction],
            },
          });
        }
      }),
    );

    unsubs.push(
      bridge.on('runner:screenshot', (data) => {
        const existing = stateRef.current.stepOutputs.get(data.stepIndex);
        if (existing) {
          dispatch({
            type: 'SET_STEP_OUTPUT',
            stepIndex: data.stepIndex,
            output: {
              ...existing,
              screenshots: [...existing.screenshots, data.dataUrl],
            },
          });
        }
      }),
    );

    unsubs.push(
      bridge.on('runner:ai-reasoning', (data) => {
        const existing = stateRef.current.stepOutputs.get(data.stepIndex);
        if (existing) {
          dispatch({
            type: 'SET_STEP_OUTPUT',
            stepIndex: data.stepIndex,
            output: {
              ...existing,
              aiReasoning: existing.aiReasoning + data.text,
            },
          });
        }
      }),
    );

    unsubs.push(
      bridge.on('runner:ai-interactions', (data) => {
        dispatch({
          type: 'UPDATE_STEP_AI_INTERACTIONS',
          stepIndex: data.stepIndex,
          aiInteractions: data.aiInteractions,
          ...(data.domSnapshot !== undefined && { domSnapshot: data.domSnapshot }),
        });
      }),
    );

    return () => unsubs.forEach((fn) => fn());
  }, []);

  const activeTab = state.tabs[state.activeTabIndex] ?? null;

  return (
    <AppStateContext.Provider value={state}>
      <AppDispatchContext.Provider value={dispatch}>
        <div className="app-layout">
          <Toolbar />
          <div className="app-panels">
            <Explorer />
            <div className="app-center">
              <EditorTabs />
              {activeTab ? (
                <Editor
                  key={activeTab.filePath}
                  tab={activeTab}
                  tabIndex={state.activeTabIndex}
                />
              ) : (
                <div className="editor-placeholder">
                  Open a file from the explorer to begin
                </div>
              )}
              <LogPanel />
            </div>
            <OutputPanel />
          </div>
        </div>
        {state.inputPrompt && (
          <InputModal
            prompt={state.inputPrompt.prompt}
            variable={state.inputPrompt.variable}
          />
        )}
      </AppDispatchContext.Provider>
    </AppStateContext.Provider>
  );
}
