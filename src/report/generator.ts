import fs from 'node:fs/promises';
import path from 'node:path';
import Handlebars from 'handlebars';
import type { TestReport, StepResult, SubActionResult, AiInteraction, TurnResult, ApiCallData, FailureDiagnosis, AssertionResult } from './types.js';
import { getAllAiInteractions } from './types.js';
import { getReportTemplate } from './template.js';
import { toDataUri } from '../browser/screenshot.js';
import { logger } from '../utils/logger.js';

/**
 * Generate an HTML report for a single test run and write it to disk.
 * Returns the absolute path of the written file.
 */
export async function generateReport(
  report: TestReport,
  outputDir: string,
): Promise<string> {
  await fs.mkdir(path.resolve(outputDir), { recursive: true });

  const fileName = buildFileName(report);
  const filePath = path.resolve(outputDir, fileName);

  const html = renderReport(report);
  await fs.writeFile(filePath, html, 'utf-8');

  logger.debug(`HTML report written: ${filePath}`);
  return filePath;
}

function buildFileName(report: TestReport): string {
  const timestamp = new Date(report.date)
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .substring(0, 19);

  const safeName = report.testName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);

  const rowSuffix = report.dataRow !== undefined ? `-row${report.dataRow}` : '';
  return `${timestamp}-${safeName}${rowSuffix}.html`;
}

function renderReport(report: TestReport): string {
  const template = Handlebars.compile(getReportTemplate());

  const status = report.status;
  const statusClass = status === 'passed' ? 'badge-pass' : status === 'failed' ? 'badge-fail' : 'badge-skip';
  const statusIcon = status === 'passed' ? '✓' : status === 'failed' ? '✗' : '—';
  const statusText = status.toUpperCase();

  const date = new Date(report.date).toLocaleString('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Australia/Sydney',
  });

  const duration = formatDuration(report.durationMs);
  const tokensUsed = report.tokensUsed.toLocaleString();
  const inputTokens = report.inputTokens.toLocaleString();
  const outputTokens = report.outputTokens.toLocaleString();
  const stepsHtml = renderSteps(report.steps);
  const diagnosisHtml = report.diagnosis ? renderDiagnosis(report.diagnosis) : '';
  const modelSummary = summarizeModels(report);
  const scriptText = buildScriptText(report.steps);

  return template({
    testName: report.testName,
    status,
    statusClass,
    statusIcon,
    statusText,
    date,
    duration,
    baseUrl: report.baseUrl,
    filePath: report.filePath,
    dataRow: report.dataRow,
    tags: report.tags,
    totalSteps: report.totalSteps,
    passedSteps: report.passedSteps,
    failedSteps: report.failedSteps,
    totalSubActions: report.totalSubActions,
    tokensUsed,
    inputTokens,
    outputTokens,
    modelSummary,
    stepsHtml: new Handlebars.SafeString(stepsHtml),
    diagnosisHtml: new Handlebars.SafeString(diagnosisHtml),
    scriptText,
  });
}

/**
 * Build a replayable test script from the captured steps.
 * Skips `[interactive]` header rows (their children carry the actual commands)
 * and `[interactive: …]` synthetic rows (e.g. screenshots) and strips
 * `(interactive N)` / `(fsd)` prefixes so the output is ready to paste
 * into a .md test file. The `(fsd)` prefix is accepted for back-compat
 * with reports written before the FSD/interactive merge.
 */
function buildScriptText(steps: StepResult[]): string {
  const INTERACTIVE_HEADER = /^\[interactive(?::|\])/i;
  const PREFIX = /^\((?:interactive\s+\d+|fsd|interactive)\)\s*/i;
  const lines: string[] = [];
  let n = 1;
  for (const step of steps) {
    if (step.hookScope) continue;
    if (step.interactiveAdHoc) continue;
    const raw = step.instruction.trim();
    if (INTERACTIVE_HEADER.test(raw)) continue;
    const cleaned = raw.replace(PREFIX, '').trim();
    if (!cleaned) continue;
    lines.push(`${n}. ${cleaned}`);
    n++;
  }
  return lines.join('\n');
}

/**
 * Count AI interactions per model across every captured interaction in the report.
 * The map is ordered by call count, descending.
 */
function collectModelCounts(report: TestReport): Map<string, number> {
  const counts = new Map<string, number>();
  const pushInteraction = (ai: AiInteraction): void => {
    if (!ai.model) return;
    counts.set(ai.model, (counts.get(ai.model) ?? 0) + 1);
  };

  for (const step of report.steps) {
    for (const ai of getAllAiInteractions(step)) pushInteraction(ai);
  }
  if (report.diagnosis?.aiInteraction) pushInteraction(report.diagnosis.aiInteraction);

  return new Map([...counts.entries()].sort((a, b) => b[1] - a[1]));
}

/**
 * Build a label describing the model(s) that served this run.
 * Returns a single name ("claude-sonnet-4-5") or a combined label with call counts
 * ("claude-sonnet-4-5 (12), gpt-4o (2)") when more than one was served.
 */
function summarizeModels(report: TestReport): string {
  const counts = collectModelCounts(report);
  if (counts.size === 0) return '';
  if (counts.size === 1) return [...counts.keys()][0]!;
  return [...counts.entries()]
    .map(([name, n]) => `${name} (${n})`)
    .join(', ');
}

/** Return the single most-used model in the report, or undefined if none were captured. */
export function getPrimaryModel(report: TestReport): string | undefined {
  const counts = collectModelCounts(report);
  return counts.size > 0 ? [...counts.keys()][0] : undefined;
}

function renderDiagnosis(diagnosis: FailureDiagnosis): string {
  const categoryLabel = diagnosis.faultCategory.replace(/-/g, ' ');
  const evidenceHtml = diagnosis.evidence.length > 0
    ? `<ul class="diagnosis-evidence">${diagnosis.evidence.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`
    : '<div class="diagnosis-root-cause">(no specific observations cited)</div>';

  const aiInteractionHtml = diagnosis.aiInteraction
    ? renderAiInteraction(diagnosis.aiInteraction)
    : '';

  return `<div class="diagnosis-block">
  <div class="diagnosis-header">
    <span class="diagnosis-title">🔎 Root Cause Analysis</span>
    <span class="badge badge-cat-${escapeHtml(diagnosis.faultCategory)}">${escapeHtml(categoryLabel)}</span>
    <span class="badge badge-conf-${escapeHtml(diagnosis.confidence)}">${escapeHtml(diagnosis.confidence)} confidence</span>
  </div>

  <div class="diagnosis-section">
    <div class="diagnosis-section-label">What went wrong</div>
    <div class="diagnosis-root-cause">${escapeHtml(diagnosis.rootCause)}</div>
  </div>

  <div class="diagnosis-section">
    <div class="diagnosis-section-label">Evidence</div>
    ${evidenceHtml}
  </div>

  <div class="diagnosis-section">
    <div class="diagnosis-section-label">Suggested fix</div>
    <div class="diagnosis-fix">${escapeHtml(diagnosis.suggestedFix)}</div>
  </div>

  ${aiInteractionHtml ? `<div class="diagnosis-section">${aiInteractionHtml}</div>` : ''}
</div>`;
}

function renderSteps(steps: StepResult[]): string {
  const out: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.interactiveChild) continue; // handled when we meet the parent

    const interactiveMatch = step.instruction.match(/^\[interactive\]\s*(.*)$/i);
    if (interactiveMatch) {
      const hint = interactiveMatch[1]!.trim();
      out.push(renderInteractiveBanner(step.index, hint));
      let subIdx = 1;
      while (i + 1 < steps.length && steps[i + 1]!.interactiveChild) {
        const child = steps[++i]!;
        const typed = child.instruction.replace(/^\(interactive\s+\d+\)\s*/i, '');
        out.push(renderStep(child, { numberLabel: `Step ${step.index}.${subIdx}`, displayInstruction: typed }));
        subIdx++;
      }
      continue;
    }

    out.push(renderStep(step));
  }
  return out.join('\n');
}

function renderInteractiveBanner(stepIndex: number, hint: string): string {
  const hintHtml = hint ? `<span class="interactive-banner-hint">${escapeHtml(hint)}</span>` : '';
  return `<div class="interactive-banner">
    <span class="interactive-banner-label">Step ${stepIndex} · Interactive prompt</span>
    ${hintHtml}
  </div>`;
}

/** Format an ISO timestamp to a short time string (HH:MM:SS) in local timezone */
function formatTime(isoString?: string): string {
  if (!isoString) return '';
  try {
    return new Date(isoString).toLocaleTimeString('en-AU', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: 'Australia/Sydney',
    });
  } catch {
    return '';
  }
}

interface RenderStepOverrides {
  numberLabel?: string;
  displayInstruction?: string;
}

function renderStep(step: StepResult, overrides: RenderStepOverrides = {}): string {
  const statusClass = step.status === 'passed' ? 'badge-pass' : step.status === 'failed' ? 'badge-fail' : 'badge-skip';
  const statusIcon = step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : '—';
  const duration = formatDuration(step.durationMs);
  const retryBadge = step.retried ? '<span class="badge badge-skip">Retried</span>' : '';

  // Render turns chronologically
  const hasMultipleAttempts = new Set(step.turns.map((t) => t.attemptNumber)).size > 1;
  const turnsHtml = step.turns.length > 0
    ? step.turns.map((turn) => renderTurn(turn, step.turns.length > 1, hasMultipleAttempts)).join('\n')
    : '';

  const assertionHtml = (step.assertions ?? [])
    .map((a) => renderAssertion(a))
    .join('\n');

  const failureHtml = step.status === 'failed'
    ? `<div class="failure-block">
        <div class="failure-title">✗ Step Failed</div>
        <div class="failure-message">${escapeHtml(step.error ?? 'Unknown error')}</div>
        ${step.aiExplanation ? `<div class="reasoning-block">${escapeHtml(step.aiExplanation)}</div>` : ''}
       </div>`
    : '';

  const toolHtml = step.toolStep ? renderToolStep(step.toolStep) : '';

  const domHtml = step.domSnapshot
    ? `<details class="dom-snapshot">
        <summary>DOM Snapshot<button class="copy-btn" type="button" title="Copy DOM"><span class="copy-btn-label">Copy</span></button></summary>
        <pre>${escapeHtml(step.domSnapshot)}</pre>
       </details>`
    : '';

  const endScreenshotLabel = step.status === 'failed' ? 'Page state at failure' : 'Page state at step end';
  const endUrlHtml = step.pageUrl ? `<div class="screenshot-url">${escapeHtml(step.pageUrl)}</div>` : '';
  const endScreenshotHtml = step.screenshotBase64
    ? `<div class="screenshot-container step-end-screenshot">
        <div class="screenshot-label">${endScreenshotLabel}</div>
        ${endUrlHtml}
        <img class="screenshot-img" src="${toDataUri(step.screenshotBase64)}" alt="Step end screenshot" loading="lazy">
       </div>`
    : `<div class="screenshot-container step-end-screenshot screenshot-disabled">
        <div class="screenshot-label">${endScreenshotLabel}</div>
        ${endUrlHtml}
        <div class="screenshot-placeholder">Screenshot not captured — set <code>browser.captureScreenshotsPerAction: true</code> to enable.</div>
       </div>`;

  const childStepClass = step.interactiveChild ? ' step-interactive-child' : '';
  const stepNumberLabel = overrides.numberLabel ?? `Step ${step.index}`;
  const displayedInstruction = overrides.displayInstruction ?? step.instruction;

  const sourceSkillBadge = step.sourceSkill
    ? `<span class="badge badge-skill" title="Step expanded from skill ${escapeHtml(step.sourceSkill)}">${escapeHtml(step.sourceSkill)}</span>`
    : '';

  return `<div class="step${childStepClass}">
  <div class="step-header">
    <span class="step-number">${escapeHtml(stepNumberLabel)}</span>
    <span class="step-instruction">${escapeHtml(displayedInstruction)}</span>
    ${sourceSkillBadge}
    ${retryBadge}
    <span class="step-duration">${duration}</span>
    <span class="badge ${statusClass}">${statusIcon} ${step.status.toUpperCase()}</span>
    <span class="step-chevron">▼</span>
  </div>
  <div class="step-body">
    ${domHtml}
    ${toolHtml}
    ${turnsHtml}
    ${assertionHtml}
    ${failureHtml}
    ${endScreenshotHtml}
  </div>
</div>`;
}

/** Exported for unit-test use; not part of the report's public API. */
export { renderStep };

/** Render the tool-invocation block for a `[tool: ...]` step.
 *  Surfaces args, captured outputs, and tool logs alongside the existing
 *  step chrome — failure forensics for deterministic tool runs.
 *  Exported for unit-test use; not part of the report's public API. */
export function renderToolStep(toolStep: NonNullable<StepResult['toolStep']>): string {
  const argRows = Object.entries(toolStep.args);
  const argsHtml = argRows.length === 0
    ? '<div class="tool-empty">(no args)</div>'
    : `<div class="tool-kv">${argRows
        .map(([k, v]) => `<div class="tool-kv-row"><span class="tool-kv-key">${escapeHtml(k)}</span><span class="tool-kv-value">${escapeHtml(formatToolValue(v))}</span></div>`)
        .join('')}</div>`;

  const outputRows = Object.entries(toolStep.outputs);
  const outputsHtml = outputRows.length === 0
    ? '<div class="tool-empty">(no outputs captured)</div>'
    : `<div class="tool-kv">${outputRows
        .map(([k, v]) => `<div class="tool-kv-row"><span class="tool-kv-key">${escapeHtml(k)}</span><span class="tool-kv-value">${escapeHtml(v)}</span></div>`)
        .join('')}</div>`;

  const logsHtml = toolStep.logs.length === 0
    ? ''
    : `<div class="tool-section">
        <div class="tool-section-label">Logs</div>
        <div class="tool-logs">${toolStep.logs
          .map((l) => `<div class="tool-log-line tool-log-${l.level}">[${l.level}] ${escapeHtml(l.message)}</div>`)
          .join('')}</div>
       </div>`;

  const hintHtml = renderToolHintBlock(toolStep);

  return `<div class="tool-block">
  <div class="tool-header">
    <span class="tool-title">🔧 Tool</span>
    <span class="tool-name">${escapeHtml(toolStep.name)}</span>
  </div>
  <div class="tool-section">
    <div class="tool-section-label">Args</div>
    ${argsHtml}
  </div>
  <div class="tool-section">
    <div class="tool-section-label">Outputs</div>
    ${outputsHtml}
  </div>
  ${logsHtml}
  ${hintHtml}
</div>`;
}

/**
 * If the tool-step's logs include a "not found in catalogue" error (the
 * catalogue's standard message), render a styled "How to register a tool"
 * callout below the args/outputs/logs. The callout reproduces the
 * defineTool recipe so an author who's debugging a failed tool call can
 * fix the missing registration without leaving the report.
 *
 * Returns an empty string when no such error is present — non-failure tool
 * runs and other failure modes (e.g. a tool that ran but threw) are
 * unaffected.
 */
function renderToolHintBlock(toolStep: NonNullable<StepResult['toolStep']>): string {
  const errorLog = toolStep.logs.find(
    (l) => l.level === 'error' && l.message.includes('not found in catalogue'),
  );
  if (!errorLog) return '';
  const toolName = escapeHtml(toolStep.name);
  const recipe = `// tools/${toolStep.name}.ts
import { defineTool } from 'ai-ui-automation/tools';

export default defineTool({
  name: '${toolStep.name}',
  parameters: { /* ... */ },
  outputs:    { /* ... */ },
  async run(args, { page, step, log }) { /* ... */ },
});`;
  return `<div class="tool-section tool-hint" title="The framework couldn't find this tool. Add a TS file to tests.toolsDir whose default export is a defineTool(...) result.">
    <div class="tool-section-label">💡 How to register "${toolName}"</div>
    <div class="tool-hint-body">
      <p>The framework couldn't find <code>${toolName}</code> in the tool catalogue.
         Drop a TypeScript file into the directory configured as
         <code>tests.toolsDir</code> in <code>aiui.config.json</code>. Its default
         export must be a <code>defineTool(...)</code> result, like:</p>
      <pre class="tool-hint-recipe">${escapeHtml(recipe)}</pre>
      <p class="tool-hint-foot">If the tool already exists, double-check that
         <code>tests.toolsDir</code> points at the directory containing it —
         the path the framework scanned is shown in the failure log above.</p>
    </div>
  </div>`;
}

function formatToolValue(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function renderTurn(turn: TurnResult, showTurnHeader: boolean, showAttempt: boolean): string {
  const timeStr = formatTime(turn.timestamp);
  const timeLabel = timeStr ? `<span class="turn-time">${timeStr}</span>` : '';
  const attemptBadge = showAttempt
    ? ` <span class="badge badge-skip">Attempt ${turn.attemptNumber}</span>`
    : '';

  const headerHtml = showTurnHeader
    ? `<div class="turn-header">Turn ${turn.turnNumber}${attemptBadge} ${timeLabel}</div>`
    : '';

  // AI interactions (action-plan, clarification)
  const aiHtml = turn.aiInteractions.map((ai) => renderAiInteraction(ai)).join('\n');

  // Sub-actions
  const subActionsHtml = turn.subActions.length > 0
    ? `<div class="sub-actions">${turn.subActions.map(renderSubAction).join('\n')}</div>`
    : '';

  return `<div class="turn">
  ${headerHtml}
  ${aiHtml}
  ${subActionsHtml}
</div>`;
}

function renderAiInteraction(ai: AiInteraction): string {
  const label = escapeHtml(ai.purpose);
  const pretty = formatJson(tryParseJson(ai.response));
  const timeStr = formatTime(ai.timestamp);
  const timeLabel = timeStr ? ` <span class="event-time">${timeStr}</span>` : '';

  const urlHtml = ai.pageUrl ? `<div class="screenshot-url">${escapeHtml(ai.pageUrl)}</div>` : '';
  const screenshotHtml = ai.screenshotBase64
    ? `<div class="screenshot-container turn-screenshot">
        <div class="screenshot-label">Page state at AI decision</div>
        ${urlHtml}
        <img class="screenshot-img" src="${toDataUri(ai.screenshotBase64)}" alt="AI decision screenshot" loading="lazy">
       </div>`
    : `<div class="screenshot-container turn-screenshot screenshot-disabled">
        <div class="screenshot-label">Page state at AI decision</div>
        ${urlHtml}
        <div class="screenshot-placeholder">Screenshot not captured — set <code>browser.captureScreenshotsPerAction: true</code> to enable.</div>
       </div>`;

  const requestHtml = ai.requestMessages && ai.requestMessages.length > 0
    ? ai.requestMessages.map((m) =>
        `<div class="ai-request-message">
          <div class="ai-request-role">
            <span>${escapeHtml(m.role)}</span>
            <button type="button" class="copy-btn" data-copy-target="next" title="Copy to clipboard" aria-label="Copy ${escapeHtml(m.role)} message">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              <span class="copy-btn-label">Copy</span>
            </button>
          </div>
          <pre class="ai-request-content">${escapeHtml(m.content)}</pre>
        </div>`,
      ).join('')
    : '';

  const requestSection = requestHtml
    ? `<details class="ai-request">
        <summary>Request (${ai.requestMessages!.length} message${ai.requestMessages!.length !== 1 ? 's' : ''})</summary>
        <div class="ai-request-body">${requestHtml}</div>
      </details>`
    : '';

  const attemptLabel = ai.attemptNumber && ai.attemptNumber > 1
    ? ` <span class="badge badge-skip">Attempt ${ai.attemptNumber}</span>`
    : '';

  const modelLabel = ai.model
    ? ` <span class="ai-model">${escapeHtml(ai.model)}</span>`
    : '';

  return `<details class="ai-response">
  <summary>AI — ${label}${attemptLabel}${modelLabel}${timeLabel}</summary>
  ${screenshotHtml}
  ${requestSection}
  <pre class="json-block">${highlightJson(pretty)}</pre>
</details>`;
}

function renderSubAction(sub: SubActionResult): string {
  const actionName = sub.action.action;
  const description = sub.action.description;
  const timeStr = formatTime(sub.timestamp);
  const timeLabel = timeStr ? `<span class="event-time">${timeStr}</span>` : '';
  const hasBody = sub.screenshotBase64 || sub.domSnapshot || sub.aiReasoning || sub.error || sub.apiCallData;

  const subUrlHtml = sub.pageUrl ? `<div class="screenshot-url">${escapeHtml(sub.pageUrl)}</div>` : '';
  const screenshotHtml = sub.screenshotBase64
    ? `<div class="screenshot-container">
        <div class="screenshot-label">After action</div>
        ${subUrlHtml}
        <img class="screenshot-img" src="${toDataUri(sub.screenshotBase64)}" alt="Sub-action screenshot" loading="lazy">
       </div>`
    : `<div class="screenshot-container screenshot-disabled">
        <div class="screenshot-label">After action</div>
        ${subUrlHtml}
        <div class="screenshot-placeholder">Screenshot not captured — set <code>browser.captureScreenshotsPerAction: true</code> to enable.</div>
       </div>`;

  const domHtml = sub.domSnapshot
    ? `<details class="dom-snapshot">
        <summary>DOM after action<button class="copy-btn" type="button" title="Copy DOM"><span class="copy-btn-label">Copy</span></button></summary>
        <pre>${escapeHtml(sub.domSnapshot)}</pre>
       </details>`
    : '';

  const reasoningHtml = sub.aiReasoning
    ? `<div class="reasoning-block">${escapeHtml(sub.aiReasoning)}</div>`
    : '';

  const errorHtml = sub.error
    ? `<div class="failure-block">
        <div class="failure-title">Action failed</div>
        <div class="failure-message">${escapeHtml(sub.error)}</div>
       </div>`
    : '';

  const apiHtml = sub.apiCallData
    ? renderApiCallData(sub.apiCallData)
    : '';

  return `<div class="sub-action">
  <div class="sub-action-header">
    <span class="sub-action-index">${sub.index}</span>
    <span class="action-badge">${escapeHtml(actionName)}</span>
    <span class="sub-action-desc">${escapeHtml(description)}</span>
    ${timeLabel}
  </div>
  ${hasBody ? `<div class="sub-action-body">${apiHtml}${screenshotHtml}${domHtml}${reasoningHtml}${errorHtml}</div>` : ''}
</div>`;
}

function renderApiCallData(data: ApiCallData): string {
  const statusClass = data.status >= 200 && data.status < 300
    ? 'badge-pass'
    : data.status >= 400
      ? 'badge-fail'
      : 'badge-skip';

  const requestBodyHtml = data.requestBody !== undefined
    ? `<details class="dom-snapshot">
        <summary>Request Body</summary>
        <pre>${escapeHtml(formatJson(data.requestBody))}</pre>
       </details>`
    : '';

  const responseBodyHtml = data.responseBody !== undefined
    ? `<details class="dom-snapshot">
        <summary>Response Body</summary>
        <pre>${escapeHtml(formatJson(data.responseBody))}</pre>
       </details>`
    : '';

  const headersHtml = data.requestHeaders && Object.keys(data.requestHeaders).length > 0
    ? `<details class="dom-snapshot">
        <summary>Request Headers</summary>
        <pre>${escapeHtml(formatRedactedHeaders(data.requestHeaders))}</pre>
       </details>`
    : '';

  return `<div class="api-call-block">
  <div class="assertion-row">
    <span class="assertion-key">Request:</span>
    <span>${escapeHtml(data.method)} ${escapeHtml(data.url)}</span>
  </div>
  <div class="assertion-row">
    <span class="assertion-key">Status:</span>
    <span class="badge ${statusClass}">${data.status}</span>
  </div>
  ${requestBodyHtml}
  ${headersHtml}
  ${responseBodyHtml}
</div>`;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatRedactedHeaders(headers: Record<string, string>): string {
  const sensitivePatterns = /key|secret|password|token|cookie|authorization/i;
  const redacted: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    redacted[k] = sensitivePatterns.test(k) ? '[redacted]' : v;
  }
  return JSON.stringify(redacted, null, 2);
}

function renderAssertion(assertion: AssertionResult): string {
  const cls = assertion.pass ? 'pass' : 'fail';
  const icon = assertion.pass ? '✓' : '✗';
  const label = assertion.pass ? 'PASSED' : 'FAILED';

  const aiHtml = assertion.aiInteraction
    ? renderAiInteraction(assertion.aiInteraction)
    : '';

  const cacheIndicator = assertion.fromCache !== undefined
    ? `<div class="assertion-row">
    <span class="assertion-key">Source:</span>
    <span>${assertion.fromCache ? '⚡ cached (no AI call)' : '🤖 AI generated'}</span>
  </div>`
    : '';

  const codeBlock = assertion.assertionCode
    ? `<details class="assertion-code">
    <summary>Assertion code</summary>
    <pre><code>${escapeHtml(assertion.assertionCode)}</code></pre>
  </details>`
    : '';

  // Predicate-mode assertions don't have a literal `expected` — both sides
  // of the comparison live in `condition`. Swap the row labels to
  // "Predicate" / "Result" to communicate that semantic shape, and skip
  // the (empty) Expected row entirely.
  const isPredicate = assertion.against === 'predicate';
  const conditionLabel = isPredicate ? 'Predicate:' : 'Condition:';
  const valueLabel = isPredicate ? 'Result:' : 'Actual:';
  const expectedRow = isPredicate
    ? ''
    : `<div class="assertion-row">
    <span class="assertion-key">Expected:</span>
    <span>${escapeHtml(assertion.expected ?? '')}</span>
  </div>`;

  return `<div class="assertion-block ${cls}">
  <div class="assertion-title">${icon} ${escapeHtml(assertion.description)} — ${label}</div>
  <div class="assertion-row">
    <span class="assertion-key">${conditionLabel}</span>
    <span>${escapeHtml(assertion.condition)}</span>
  </div>
  ${expectedRow}
  <div class="assertion-row">
    <span class="assertion-key">${valueLabel}</span>
    <span>${escapeHtml(assertion.actual)}</span>
  </div>
  <div class="assertion-row">
    <span class="assertion-key">Explanation:</span>
    <span>${escapeHtml(assertion.explanation)}</span>
  </div>
  <div class="assertion-row">
    <span class="assertion-key">Turn / sub-action:</span>
    <span>turn ${assertion.turnNumber}, sub-action ${assertion.subActionIndex}</span>
  </div>
  ${cacheIndicator}
  ${codeBlock}
  ${aiHtml}
</div>`;
}

function tryParseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Applies simple syntax highlighting to a pretty-printed JSON string.
 * Returns an HTML string with <span> colour tags — safe to embed in a <pre>.
 */
function highlightJson(json: string): string {
  // Tokenise line-by-line so we can escape each segment before wrapping in spans
  return json
    .split('\n')
    .map((line) => highlightJsonLine(line))
    .join('\n');
}

function highlightJsonLine(line: string): string {
  // Match: key, string value, number, boolean/null
  // We process segments left-to-right and escape each piece.
  const segments: string[] = [];
  let remaining = line;

  while (remaining.length > 0) {
    // Leading whitespace / structural characters
    const ws = remaining.match(/^([\s{}\[\],]+)/);
    if (ws) {
      segments.push(escapeHtml(ws[1]!));
      remaining = remaining.slice(ws[1]!.length);
      continue;
    }

    // JSON key (string followed by colon)
    const keyMatch = remaining.match(/^("(?:[^"\\]|\\.)*")(\s*:)/);
    if (keyMatch) {
      segments.push(`<span class="j-key">${escapeHtml(keyMatch[1]!)}</span>${escapeHtml(keyMatch[2]!)}`);
      remaining = remaining.slice(keyMatch[0].length);
      continue;
    }

    // String value
    const strMatch = remaining.match(/^"(?:[^"\\]|\\.)*"/);
    if (strMatch) {
      segments.push(`<span class="j-str">${escapeHtml(strMatch[0])}</span>`);
      remaining = remaining.slice(strMatch[0].length);
      continue;
    }

    // Number
    const numMatch = remaining.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (numMatch) {
      segments.push(`<span class="j-num">${escapeHtml(numMatch[0])}</span>`);
      remaining = remaining.slice(numMatch[0].length);
      continue;
    }

    // Boolean / null
    const boolMatch = remaining.match(/^(true|false|null)/);
    if (boolMatch) {
      segments.push(`<span class="j-kw">${boolMatch[1]!}</span>`);
      remaining = remaining.slice(boolMatch[1]!.length);
      continue;
    }

    // Fallback: emit one character escaped
    segments.push(escapeHtml(remaining[0]!));
    remaining = remaining.slice(1);
  }

  return segments.join('');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
