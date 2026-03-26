import fs from 'node:fs/promises';
import path from 'node:path';
import Handlebars from 'handlebars';
import type { TestReport, StepResult, SubActionResult } from './types.js';
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
    ${failureHtml}
  </div>
</div>`;
}

function renderSubAction(sub: SubActionResult): string {
  const actionName = sub.action.action;
  const description = sub.action.description;
  const hasBody = sub.screenshotBase64 || sub.domSnapshot || sub.aiReasoning || sub.error;

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

  return `<div class="sub-action">
  <div class="sub-action-header">
    <span class="sub-action-index">${sub.index}</span>
    <span class="action-badge">${escapeHtml(actionName)}</span>
    <span class="sub-action-desc">${escapeHtml(description)}</span>
  </div>
  ${hasBody ? `<div class="sub-action-body">${screenshotHtml}${domHtml}${reasoningHtml}${errorHtml}</div>` : ''}
</div>`;
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
