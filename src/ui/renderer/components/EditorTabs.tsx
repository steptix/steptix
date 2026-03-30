import React, { useCallback } from 'react';
import { useAppState, useAppDispatch } from '../App';

export function EditorTabs() {
  const state = useAppState();
  const dispatch = useAppDispatch();

  const handleTabClick = useCallback(
    (index: number) => {
      dispatch({ type: 'SET_ACTIVE_TAB', index });
    },
    [dispatch],
  );

  const handleTabClose = useCallback(
    (e: React.MouseEvent, index: number) => {
      e.stopPropagation();
      const tab = state.tabs[index];
      if (tab.dirty) {
        const result = confirm(`Save changes to ${tab.fileName} before closing?`);
        if (result) {
          // Save then close
          window.electronBridge
            ?.invoke('file:write', { path: tab.filePath, content: tab.content })
            .then(() => {
              dispatch({ type: 'CLOSE_TAB', index });
            });
          return;
        }
      }
      dispatch({ type: 'CLOSE_TAB', index });
    },
    [dispatch, state.tabs],
  );

  if (state.tabs.length === 0) return null;

  return (
    <div className="editor-tabs">
      {state.tabs.map((tab, i) => (
        <div
          key={tab.filePath}
          className={`editor-tab ${i === state.activeTabIndex ? 'editor-tab--active' : ''}`}
          onClick={() => handleTabClick(i)}
        >
          <span>{tab.fileName}</span>
          {tab.dirty && <span className="editor-tab__dirty">{'\u25CF'}</span>}
          <span
            className="editor-tab__close"
            onClick={(e) => handleTabClose(e, i)}
            title="Close"
          >
            {'\u00D7'}
          </span>
        </div>
      ))}
    </div>
  );
}
