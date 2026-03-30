import React, { useState, useCallback } from 'react';
import { useAppDispatch } from '../App';
import { useIpcInvoke } from '../hooks/useIpc';

interface InputModalProps {
  prompt: string;
  variable: string;
}

export function InputModal({ prompt, variable }: InputModalProps) {
  const dispatch = useAppDispatch();
  const invoke = useIpcInvoke();
  const [value, setValue] = useState('');

  const handleSubmit = useCallback(() => {
    if (!value.trim()) return;
    invoke('runner:input-response', { variable, value: value.trim() });
    dispatch({ type: 'CLEAR_INPUT_PROMPT' });
    setValue('');
  }, [value, variable, dispatch, invoke]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <div className="input-modal-overlay">
      <div className="input-modal">
        <h3>Input Required</h3>
        <p>{prompt}</p>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Enter value for ${variable}...`}
          autoFocus
        />
        <button onClick={handleSubmit} disabled={!value.trim()}>
          Submit
        </button>
      </div>
    </div>
  );
}
