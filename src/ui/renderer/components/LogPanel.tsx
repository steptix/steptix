import React, { useEffect, useRef } from 'react';
import { useAppState } from '../App';

export function LogPanel() {
  const { logs } = useAppState();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [logs]);

  return (
    <div className="log-panel">
      <div className="log-panel-header">Log</div>
      <div className="log-panel-body">
        {logs.length === 0 && (
          <div className="log-empty">No output yet — start a test run.</div>
        )}
        {logs.map((entry) => (
          <div key={entry.id} className={`log-entry log-entry--${entry.level}`}>
            <span className="log-timestamp">{entry.timestamp}</span>
            <span className="log-message">{entry.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
