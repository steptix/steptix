import React, { useEffect, useCallback } from 'react';
import { useAppState, useAppDispatch } from '../App';
import { useIpcInvoke } from '../hooks/useIpc';

export function Toolbar() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const invoke = useIpcInvoke();

  const { runState, tabs, activeTabIndex, breakpoints } = state;
  const status = runState.status;
  const activeTab = tabs[activeTabIndex] ?? null;

  const isIdle = status === 'idle';
  const isRunning = status === 'running';
  const isPaused = status === 'paused';
  const isComplete = status === 'complete';

  const handleStart = useCallback(() => {
    if (!activeTab) return;
    dispatch({ type: 'CLEAR_EXECUTION_STATE' });
    dispatch({ type: 'SET_RUNNING_FILE', filePath: activeTab.filePath });
    invoke('runner:start', {
      filePath: activeTab.filePath,
      breakpoints: Array.from(breakpoints),
    });
    dispatch({
      type: 'SET_RUN_STATE',
      runState: { status: 'running', currentStep: 0 },
    });
  }, [activeTab, breakpoints, dispatch, invoke]);

  const handleStop = useCallback(() => {
    invoke('runner:stop', {});
    dispatch({ type: 'SET_RUN_STATE', runState: { status: 'idle' } });
    dispatch({ type: 'SET_CURRENT_STEP', stepIndex: null });
    dispatch({ type: 'SET_RUNNING_FILE', filePath: null });
  }, [dispatch, invoke]);

  const handleStepOver = useCallback(() => {
    invoke('runner:step-over', {});
  }, [invoke]);

  const handleResume = useCallback(() => {
    invoke('runner:resume', {});
  }, [invoke]);

  const handleSave = useCallback(() => {
    if (!activeTab) return;
    invoke('file:write', {
      path: activeTab.filePath,
      content: activeTab.content,
    }).then(() => {
      dispatch({ type: 'MARK_TAB_SAVED', index: activeTabIndex });
    });
  }, [activeTab, activeTabIndex, dispatch, invoke]);

  // Keyboard shortcut: Ctrl+S / Cmd+S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave]);

  const statusLabel =
    status === 'complete'
      ? (runState as { result: string }).result === 'passed'
        ? 'Passed'
        : 'Failed'
      : status.charAt(0).toUpperCase() + status.slice(1);

  const statusClass =
    status === 'complete'
      ? (runState as { result: string }).result === 'passed'
        ? 'status-passed'
        : 'status-failed'
      : `status-${status}`;

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <button
          className="toolbar-btn toolbar-btn--start"
          disabled={!(isIdle || isComplete) || !activeTab}
          onClick={handleStart}
          title="Start run (active file)"
        >
          &#9654; Start
        </button>
        <button
          className="toolbar-btn toolbar-btn--stop"
          disabled={!(isRunning || isPaused)}
          onClick={handleStop}
          title="Stop run"
        >
          &#9632; Stop
        </button>
        <button
          className="toolbar-btn"
          disabled={!isPaused}
          onClick={handleStepOver}
          title="Step Over"
        >
          &#8631; Step Over
        </button>
        <button
          className="toolbar-btn"
          disabled={!isPaused}
          onClick={handleResume}
          title="Resume"
        >
          &#9654;&#9654; Resume
        </button>
        <button
          className="toolbar-btn"
          onClick={handleSave}
          disabled={!activeTab}
          title="Save (Ctrl+S)"
        >
          &#128190; Save
        </button>
      </div>
      <div className="toolbar-right">
        <span className={`status-indicator ${statusClass}`}>{statusLabel}</span>
      </div>
    </div>
  );
}
