import React, { useState, useCallback } from 'react';
import { useAppState } from '../App';
import { useIpcInvoke } from '../hooks/useIpc';

export function SteeringWindow() {
  const state = useAppState();
  const invoke = useIpcInvoke();
  const [input, setInput] = useState('');

  const isPaused = state.runState.status === 'paused';

  const handleSubmit = useCallback(() => {
    if (!input.trim() || !isPaused) return;
    invoke('runner:steer', { instruction: input.trim() });
    setInput('');
  }, [input, isPaused, invoke]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <div className="steering-window">
      <div className="steering-window-header">Steering</div>
      <div className="steering-input-row">
        <input
          className="steering-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!isPaused}
          placeholder={
            isPaused
              ? 'Type a steering instruction...'
              : 'Pause at a breakpoint to use steering'
          }
        />
        <button
          className="steering-btn"
          onClick={handleSubmit}
          disabled={!isPaused || !input.trim()}
        >
          Execute
        </button>
      </div>
    </div>
  );
}
