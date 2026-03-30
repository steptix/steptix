import React from 'react';
import { useAppState } from '../App';
import { ScreenshotStrip } from './ScreenshotStrip';
import { SteeringWindow } from './SteeringWindow';

export function OutputPanel() {
  const state = useAppState();
  const { selectedStep, stepOutputs } = state;

  const output = selectedStep !== null ? stepOutputs.get(selectedStep) : null;

  return (
    <div className="output-panel">
      <div className="output-panel-header">Output</div>
      <div className="output-step-content">
        {!output && (
          <div className="output-empty">Select a step to view output</div>
        )}
        {output && (
          <>
            {/* Step header */}
            <div className="output-section">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>
                  Step {output.stepIndex + 1}
                </span>
                <span className={`step-status-badge step-status-${output.status}`}>
                  {output.status}
                </span>
                {output.durationMs !== undefined && (
                  <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                    {(output.durationMs / 1000).toFixed(1)}s
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
                {output.instruction}
              </div>
            </div>

            {/* AI Reasoning */}
            {output.aiReasoning && (
              <div className="output-section">
                <div className="output-section-title">AI Reasoning</div>
                <div className="output-reasoning">{output.aiReasoning}</div>
              </div>
            )}

            {/* Sub-actions */}
            {output.subActions.length > 0 && (
              <div className="output-section">
                <div className="output-section-title">
                  Sub-actions ({output.subActions.length})
                </div>
                {output.subActions.map((sa, i) => (
                  <div key={i} className="output-subaction">
                    <span className="output-subaction-icon">
                      {sa.error ? '\u2717' : '\u2713'}
                    </span>
                    <div className="output-subaction-text">
                      <div>{sa.action?.action ?? 'action'}</div>
                      {sa.aiReasoning && (
                        <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                          {sa.aiReasoning}
                        </div>
                      )}
                      {sa.error && (
                        <div style={{ color: 'var(--status-failed)', fontSize: 11 }}>
                          {sa.error}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Screenshots */}
            {output.screenshots.length > 0 && (
              <div className="output-section">
                <div className="output-section-title">Screenshots</div>
                <ScreenshotStrip screenshots={output.screenshots} />
              </div>
            )}

            {/* Error */}
            {output.error && (
              <div className="output-section">
                <div className="output-section-title">Error</div>
                <div className="output-error">{output.error}</div>
              </div>
            )}
          </>
        )}
      </div>
      <SteeringWindow />
    </div>
  );
}
