import fs from 'node:fs/promises';
import path from 'node:path';
import Handlebars from 'handlebars';
import type { TestReport, StepResult, SubActionResult, AiInteraction, ApiCallData } from './types.js';
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

  return template({
    testName: report.testName,
    status,
    statusClass,
    statusIcon,
    statusText,
    date,
    duration,
    baseUrl: report.baseUrl,
    dataRow: report.dataRow,
    tags: report.tags,
    totalSteps: report.totalSteps,
    passedSteps: report.passedSteps,
    failedSteps: report.failedSteps,
    totalSubActions: report.totalSubActions,
    tokensUsed,
    inputTokens,
    outputTokens,
    stepsHtml: new Handlebars.SafeString(stepsHtml),
  });
}

function renderSteps(steps: StepResult[]): string {
  return steps.map((step) => renderStep(step)).join('\n');
}

function renderStep(step: StepResult): string {
  const statusClass = step.status === 'passed' ? 'badge-pass' : step.status === 'failed' ? 'badge-fail' : 'badge-skip';
  const statusIcon = step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : '—';
  const duration = formatDuration(step.durationMs);
  const retryBadge = step.retried ? '<span class="badge badge-skip">Retried</span>' : '';

  const subActionsHtml = step.subActions.length > 0
    ? `<div class="sub-actions">${step.subActions.map(renderSubAction).join('\n')}</div>`
    : '';

  const assertionHtml = step.assertion
    ? renderAssertion(step.assertion)
    : '';

  const aiResponsesHtml = step.aiResponses && step.aiResponses.length > 0
    ? renderAiResponses(step.aiResponses)
    : '';

  const failureHtml = step.status === 'failed'
    ? `<div class="failure-block">
        <div class="failure-title">✗ Step Failed</div>
        <div class="failure-message">${escapeHtml(step.error ?? 'Unknown error')}</div>
        ${step.aiExplanation ? `<div class="reasoning-block">${escapeHtml(step.aiExplanation)}</div>` : ''}
       </div>`
    : '';

  const screenshotHtml = step.screenshotBase64
    ? `<div class="screenshot-container">
        <div class="screenshot-label">Page state at step start</div>
        <img class="screenshot-img" src="${toDataUri(step.screenshotBase64)}" alt="Step screenshot" loading="lazy">
       </div>`
    : '';

  const domHtml = step.domSnapshot
    ? `<details class="dom-snapshot">
        <summary>DOM Snapshot</summary>
        <pre>${escapeHtml(step.domSnapshot.substring(0, 5000))}</pre>
       </details>`
    : '';

  return `<div class="step">
  <div class="step-header">
    <span class="step-number">Step ${step.index}</span>
    <span class="step-instruction">${escapeHtml(step.instruction)}</span>
    ${retryBadge}
    <span class="step-duration">${duration}</span>
    <span class="badge ${statusClass}">${statusIcon} ${step.status.toUpperCase()}</span>
    <span class="step-chevron">▼</span>
  </div>
  <div class="step-body">
    ${screenshotHtml}
    ${domHtml}
    ${subActionsHtml}
    ${assertionHtml}
    ${aiResponsesHtml}
    ${failureHtml}
  </div>
</div>`;
}

function renderSubAction(sub: SubActionResult): string {
  const actionName = sub.action.action;
  const description = sub.action.description;
  const hasBody = sub.screenshotBase64 || sub.domSnapshot || sub.aiReasoning || sub.error || sub.apiCallData;

  const screenshotHtml = sub.screenshotBase64
    ? `<div class="screenshot-container">
        <div class="screenshot-label">After action</div>
        <img class="screenshot-img" src="${toDataUri(sub.screenshotBase64)}" alt="Sub-action screenshot" loading="lazy">
       </div>`
    : '';

  const domHtml = sub.domSnapshot
    ? `<details class="dom-snapshot">
        <summary>DOM after action</summary>
        <pre>${escapeHtml(sub.domSnapshot.substring(0, 3000))}</pre>
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

function renderAssertion(
  assertion: NonNullable<StepResult['assertion']>,
): string {
  const cls = assertion.pass ? 'pass' : 'fail';
  const icon = assertion.pass ? '✓' : '✗';
  const label = assertion.pass ? 'PASSED' : 'FAILED';

  return `<div class="assertion-block ${cls}">
  <div class="assertion-title">${icon} Assertion ${label}</div>
  <div class="assertion-row">
    <span class="assertion-key">Expected:</span>
    <span>${escapeHtml(assertion.expected)}</span>
  </div>
  <div class="assertion-row">
    <span class="assertion-key">Actual:</span>
    <span>${escapeHtml(assertion.actual)}</span>
  </div>
  <div class="assertion-row">
    <span class="assertion-key">Explanation:</span>
    <span>${escapeHtml(assertion.explanation)}</span>
  </div>
</div>`;
}

function renderAiResponses(responses: AiInteraction[]): string {
  const items = responses.map((r) => {
    const label = escapeHtml(r.purpose);
    const pretty = formatJson(tryParseJson(r.response));

    const requestHtml = r.requestMessages && r.requestMessages.length > 0
      ? r.requestMessages.map((m) =>
          `<div class="ai-request-message">
            <div class="ai-request-role">${escapeHtml(m.role)}</div>
            <pre class="ai-request-content">${escapeHtml(m.content)}</pre>
          </div>`,
        ).join('')
      : '';

    const requestSection = requestHtml
      ? `<details class="ai-request">
          <summary>Request (${r.requestMessages!.length} message${r.requestMessages!.length !== 1 ? 's' : ''})</summary>
          <div class="ai-request-body">${requestHtml}</div>
        </details>`
      : '';

    const attemptLabel = r.attemptNumber && r.attemptNumber > 1
      ? ` <span class="badge badge-skip">Attempt ${r.attemptNumber}</span>`
      : '';
    return `<details class="ai-response">
      <summary>AI response — ${label}${attemptLabel}</summary>
      ${requestSection}
      <pre class="json-block">${highlightJson(pretty)}</pre>
    </details>`;
  }).join('\n');

  return `<div class="ai-responses">
  <div class="ai-responses-title">AI Responses (${responses.length})</div>
  ${items}
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
