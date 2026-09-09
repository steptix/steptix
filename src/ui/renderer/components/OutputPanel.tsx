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
                      {sa.apiCallData && (
                        <div style={{ marginTop: 4, fontSize: 11, fontFamily: 'monospace' }}>
                          <div style={{ color: 'var(--text-secondary)' }}>
                            {sa.apiCallData.method} {sa.apiCallData.url}
                            {' → '}
                            <span style={{ color: sa.apiCallData.status >= 400 ? 'var(--status-failed)' : 'var(--status-passed)' }}>
                              {sa.apiCallData.status}
                            </span>
                          </div>
                          {sa.apiCallData.requestBody != null && (
                            <details style={{ marginTop: 2 }}>
                              <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>Request body</summary>
                              <pre style={{ margin: '2px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                                {typeof sa.apiCallData.requestBody === 'string'
                                  ? sa.apiCallData.requestBody
                                  : JSON.stringify(sa.apiCallData.requestBody, null, 2)}
                              </pre>
                            </details>
                          )}
                          {sa.apiCallData.responseBody != null && (
                            <details style={{ marginTop: 2 }}>
                              <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>Response body</summary>
                              <pre style={{ margin: '2px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                                {typeof sa.apiCallData.responseBody === 'string'
                                  ? sa.apiCallData.responseBody
                                  : JSON.stringify(sa.apiCallData.responseBody, null, 2)}
                              </pre>
                            </details>
                          )}
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

            {/* AI API Responses */}
            {output.aiInteractions && output.aiInteractions.length > 0 && (
              <div className="output-section">
                <div className="output-section-title">
                  AI API Responses ({output.aiInteractions.length})
                </div>
                {output.aiInteractions.map((interaction, i) => {
                  let parsed: unknown;
                  try { parsed = JSON.parse(interaction.response); } catch { parsed = null; }
                  const formatted = parsed !== null
                    ? JSON.stringify(parsed, null, 2)
                    : interaction.response;
                  return (
                    <details key={i} className="output-ai-interaction" style={{ marginBottom: 6 }}>
                      <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 500, padding: '4px 0', userSelect: 'none' }}>
                        <span className="output-interaction-purpose">{interaction.purpose}</span>
                        {/* `AiInteraction` (src/report/types.ts) carries no turn number — turns
                            are grouped on `StepResult.turns`, and each interaction is already
                            listed in turn order here — so there is no "Turn N" badge; the
                            attempt badge below is the one field the shape does carry. */}
                        {interaction.attemptNumber && interaction.attemptNumber > 1 && (
                          <span className="step-status-badge step-status-skipped" style={{ marginLeft: 6, fontSize: 10 }}>
                            Attempt {interaction.attemptNumber}
                          </span>
                        )}
                      </summary>
                      {interaction.requestMessages && interaction.requestMessages.length > 0 && (
                        <details style={{ marginBottom: 4 }}>
                          <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text-secondary)', padding: '2px 0', userSelect: 'none' }}>
                            Request ({interaction.requestMessages.length} message{interaction.requestMessages.length !== 1 ? 's' : ''})
                          </summary>
                          {interaction.requestMessages.map((msg, j) => (
                            <div key={j} style={{ marginBottom: 4 }}>
                              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-secondary)', padding: '2px 4px', background: 'var(--bg-secondary)' }}>
                                {msg.role}
                              </div>
                              <pre className="output-ai-response" style={{ maxHeight: 300 }}>{msg.content}</pre>
                            </div>
                          ))}
                        </details>
                      )}
                      <pre className="output-ai-response">{formatted}</pre>
                    </details>
                  );
                })}
              </div>
            )}

            {/* DOM Context */}
            {output.domSnapshot && (
              <div className="output-section">
                <details>
                  <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 500, padding: '4px 0', userSelect: 'none' }}>
                    Page Context (DOM snapshot)
                  </summary>
                  <pre className="output-dom-snapshot">{output.domSnapshot}</pre>
                </details>
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
