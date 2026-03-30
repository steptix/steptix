import React, { useReducer, createContext, useContext, useEffect } from 'react';
import type { RunState, StepOutput } from '../ipc-types';
import { Toolbar } from './components/Toolbar';
import { Explorer } from './components/Explorer';
import { EditorTabs } from './components/EditorTabs';
import { Editor } from './components/Editor';
import { OutputPanel } from './components/OutputPanel';
import { InputModal } from './components/InputModal';

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
  testsDir: string;
  inputPrompt: { prompt: string; variable: string } | null;
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
  testsDir: '',
  inputPrompt: null,
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
  | { type: 'RELOAD_TAB_CONTENT'; filePath: string; content: string };

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
        dispatch({ type: 'SET_CURRENT_STEP', stepIndex: data.stepIndex });
        dispatch({
          type: 'SET_STEP_OUTPUT',
          stepIndex: data.stepIndex,
          output: {
            stepIndex: data.stepIndex,
            instruction: data.instruction,
            status: 'running',
            aiReasoning: '',
            subActions: [],
            screenshots: [],
          },
        });
        dispatch({ type: 'SET_RUN_STATE', runState: { status: 'running', currentStep: data.stepIndex } });
      }),
    );

    unsubs.push(
      bridge.on('runner:step-complete', (data) => {
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
        dispatch({ type: 'SET_RUN_STATE', runState: { status: 'running', currentStep: 0 } });
      }),
    );

    unsubs.push(
      bridge.on('runner:complete', (data) => {
        dispatch({
          type: 'SET_RUN_STATE',
          runState: { status: 'complete', result: data.status },
        });
        dispatch({ type: 'SET_CURRENT_STEP', stepIndex: null });
        dispatch({ type: 'SET_RUNNING_FILE', filePath: null });
      }),
    );

    unsubs.push(
      bridge.on('runner:error', (data) => {
        dispatch({
          type: 'SET_RUN_STATE',
          runState: { status: 'complete', result: 'failed' },
        });
        console.error('Runner error:', data.message);
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
