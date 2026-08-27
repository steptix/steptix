import fs from 'node:fs/promises';
import path from 'node:path';
import Handlebars from 'handlebars';
import type { TestReport, StepResult, SubActionResult, AiInteraction, TurnResult, ApiCallData, FailureDiagnosis, AssertionResult } from './types.js';
import { getAllAiInteractions, isHealedStep } from './types.js';
import { getReportTemplate } from './template.js';
import { toDataUri } from '../browser/screenshot.js';
import { logger } from '../utils/logger.js';

/**
 * The code-behind mark — `</>` — the same drawing TestBench paints in the
 * gutter and on its Compile button. Inline SVG in `currentColor`, so it takes
 * the badge's or title's colour; `.cb-mark` in template.ts sets the baseline.
 */
export const CODE_BEHIND_MARK =
  '<svg class="cb-mark" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
  '<path d="M5.4 4.3L1.9 8l3.5 3.7M10.6 4.3L14.1 8l-3.5 3.7M9.4 2.6L6.6 13.4" fill="none" stroke="currentColor" ' +
  'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';

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

/**
 * Build the stable base name (no extension) shared by a run's report HTML and
 * its session video: `<timestamp>-<safeTestName>[-row<n>]`. Exported so the
 * teardown paths can name the `.webm` to match the `.html` (so the report's
 * relative `<video src>` resolves to a sibling file).
 */
export function buildReportBaseName(report: TestReport): string {
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
  return `${timestamp}-${safeName}${rowSuffix}`;
}

function buildFileName(report: TestReport): string {
  return `${buildReportBaseName(report)}.html`;
}

/** Render a TestReport to its full HTML string. Exported for unit-test use. */
export function renderReport(report: TestReport): string {
  const template = Handlebars.compile(getReportTemplate());

  const status = report.status;
  const origins = countStepOrigins(report.steps);
  // A run that passed only because broken code-behind entries healed under AI
  // is not a clean pass (stories/codebehind-selector-ambiguity.md §"A healed
  // run stops reporting as a clean pass"). It borrows `aborted`'s amber badge
  // — the precedent for "a display state `status` cannot express".
  //
  // `healedSteps` when the producer set it, otherwise the count taken off the
  // steps themselves: a report assembled by a path that predates the field
  // still renders the banner, it just has no token figure to name.
  const healedSteps = report.healedSteps ?? origins.stale;
  const healed = !report.aborted && status === 'passed' && healedSteps > 0;
  const statusClass = report.aborted || healed
    ? 'badge-aborted'
    : status === 'passed' ? 'badge-pass' : status === 'failed' ? 'badge-fail' : 'badge-skip';
  const statusIcon = report.aborted
    ? '■'
    : healed ? '⚠'
    : status === 'passed' ? '✓' : status === 'failed' ? '✗' : '—';
  const statusText = report.aborted
    ? 'ABORTED'
    : healed ? healedBannerText(healedSteps, report.healedTokens)
    : status.toUpperCase();

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
    codeBehindSteps: origins.code,
    aiSteps: origins.ai,
    staleSteps: origins.stale,
    // The row is noise on a test with no code-behind at all, which is most of
    // them — shown only once there is something to say.
    showOrigins: origins.code > 0 || origins.stale > 0,
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
    videoRelPath: report.videoRelPath,
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
    tabTimelineHtml: new Handlebars.SafeString(renderTabTimeline(report.steps)),
    scriptText,
  });
}

/**
 * How each step got done: as code-behind, under AI, or under AI *because* its
 * code-behind broke (stories/codebehind-compile.md — "9 steps: 7 code-behind,
 * 1 AI, 1 stale").
 *
 * Counted over real steps only: hook rows and interactive ad-hoc rows are not
 * steps of the test, and including them would make the three numbers fail to
 * add up to the step count.
 */
export function countStepOrigins(steps: StepResult[]): {
  code: number;
  ai: number;
  stale: number;
} {
  let code = 0;
  let ai = 0;
  let stale = 0;
  for (const step of steps) {
    if (step.hookScope || step.interactiveAdHoc || step.interactiveChild) continue;
    // `isHealedStep`, not the bare flag: a step whose entry threw AND whose AI
    // attempt then failed carries the flag but healed nothing, and the "Stale"
    // stat is read as "these recovered". It ran under AI, so it counts as AI.
    if (isHealedStep(step)) stale++;
    else if (step.fromCodeBehind) code++;
    else ai++;
  }
  return { code, ai, stale };
}

/**
 * `18234` → `18.2k`. Compact because the banner sits inside a badge, and the
 * figure is there to be *felt* — the reader needs the order of magnitude, not
 * the units digit.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const k = tokens / 1000;
  return `${k >= 100 ? Math.round(k) : Number(k.toFixed(1))}k`;
}

/**
 * The amber banner a healed run wears in place of a plain green PASSED
 * (stories/codebehind-selector-ambiguity.md): "PASSED — 4 steps healed,
 * 18.2k tokens".
 *
 * The token figure is the point — it is what the author pays again on every
 * run until the entries are repaired — so it is named whenever it was
 * attributed. When it wasn't, the banner says the count and stops rather than
 * printing a number nobody measured.
 *
 * Exported so the CLI summary and the tests can read the same sentence the
 * report renders.
 */
export function healedBannerText(healedSteps: number, healedTokens?: number): string {
  const steps = `${healedSteps} step${healedSteps === 1 ? '' : 's'} healed`;
  return healedTokens !== undefined && healedTokens > 0
    ? `PASSED — ${steps}, ${formatTokenCount(healedTokens)} tokens`
    : `PASSED — ${steps}`;
}

/**
 * Which tabs this run touched, when each first appeared, and how.
 *
 * Rendered only when there is more than one tab, or when one was adopted
 * unexpectedly — a single-tab run has nothing to explain, and a section that
 * says "this run used one tab" on every report trains the reader to skip it.
 *
 * The point of the table is the target id column. Several tests can share one
 * CDP browser and every tab any of them opens is visible to all of them, so
 * "which `page:2`?" is a real question with a real answer, and the answer is
 * not the label (stories/mcp-cdp-browser.md §11).
 */
function renderTabTimeline(steps: StepResult[]): string {
  interface TabRow {
    label: string;
    targetId: string | null;
    url: string;
    title: string;
    unexpected: boolean;
    firstStep: number;
  }
  const byKey = new Map<string, TabRow>();
  for (const step of steps) {
    if (!step.tab) continue;
    // Keyed on the target id where there is one: two labels can name one tab
    // across a relabel, and two sessions' labels can collide.
    const key = step.tab.targetId ?? `label:${step.tab.label}`;
    const existing = byKey.get(key);
    if (existing) {
      // Last-seen URL and title: a tab that navigated is more usefully
      // described by where it ended up.
      existing.url = step.tab.url || existing.url;
      existing.title = step.tab.title || existing.title;
      existing.unexpected = existing.unexpected || step.tab.unexpected;
      continue;
    }
    byKey.set(key, {
      label: step.tab.label,
      targetId: step.tab.targetId,
      url: step.tab.url,
      title: step.tab.title,
      unexpected: step.tab.unexpected,
      firstStep: step.index,
    });
  }

  const rows = [...byKey.values()];
  if (rows.length === 0) return '';
  if (rows.length === 1 && !rows[0]!.unexpected) return '';

  const anyUnexpected = rows.some((r) => r.unexpected);
  const body = rows
    .map(
      (r) => `      <tr class="${r.unexpected ? 'tab-row-unexpected' : ''}">
        <td>${r.unexpected ? '⚠ ' : ''}${escapeHtml(r.label)}</td>
        <td class="tab-id">${escapeHtml(r.targetId ?? '—')}</td>
        <td>${r.firstStep === 0 ? 'attached at start' : `first used at step ${r.firstStep}`}${
          r.unexpected ? ' — <strong>not opened by this test</strong>' : ''
        }</td>
        <td>${escapeHtml(r.title || '(untitled)')}</td>
        <td class="tab-url">${escapeHtml(r.url)}</td>
      </tr>`,
    )
    .join('\n');

  return `<div class="tab-timeline">
    <h2>Tabs</h2>
    <p class="tab-timeline-note">${
      anyUnexpected
        ? 'A tab marked ⚠ was adopted mid-run with nothing in this test accounting for it — ' +
          'most often another test running against the same browser. Tests sharing a browser ' +
          'see each other’s tabs; this is advisory and changed no step’s result.'
        : 'Tabs this run drove. The target id is what distinguishes tabs across tests sharing one browser.'
    }</p>
    <table>
      <thead><tr><th>Tab</th><th>Target id</th><th>Appeared</th><th>Title</th><th>URL</th></tr></thead>
      <tbody>
${body}
      </tbody>
    </table>
  </div>`;
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
  // The interrupted step (run stopped here — issue 021) is its own state, not a
  // failure: amber "ABORTED" badge, no red failure block. Checked first so it
  // overrides the underlying 'failed' status it carries for back-compat.
  const statusClass = step.interrupted
    ? 'badge-aborted'
    : step.status === 'passed' ? 'badge-pass' : step.status === 'failed' ? 'badge-fail' : 'badge-skip';
  const statusIcon = step.interrupted
    ? '■'
    : step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : '—';
  const statusLabel = step.interrupted ? 'ABORTED' : step.status.toUpperCase();
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

  // Interrupted step: an amber "stopped here" note instead of the red failure
  // block (issue 021).
  const failureHtml = step.interrupted
    ? `<div class="aborted-block">
        <div class="aborted-title">■ Run stopped here</div>
        <div class="aborted-message">${escapeHtml(step.aiExplanation ?? 'Stopped by user (run aborted).')}</div>
       </div>`
    : step.status === 'failed'
    ? `<div class="failure-block">
        <div class="failure-title">✗ Step Failed</div>
        <div class="failure-message">${escapeHtml(step.error ?? 'Unknown error')}</div>
        ${step.aiExplanation ? `<div class="reasoning-block">${escapeHtml(step.aiExplanation)}</div>` : ''}
       </div>`
    : '';

  const toolHtml = step.toolStep ? renderToolStep(step.toolStep) : '';
  const codeBehindHtml = step.codeBehind ? renderCodeBehind(step.codeBehind) : '';
  const staleHtml = step.codeBehindStale
    ? renderCodeBehindStale(step.codeBehindStale, isHealedStep(step))
    : '';

  // Skip when this is a tool step: a `[tool: ... out.x="y"]` binding is
  // already shown in the purple Outputs section above via `toolStep.outputs`
  // — the only way a tool step's `outputs` is ever non-empty is the same
  // value reaching resolvedParameters under an `[output:]` alias, so a
  // second, green, identically-valued box would be pure duplication.
  const captureRows = step.toolStep ? [] : Object.entries(step.outputs ?? {});
  const capturesHtml = captureRows.length === 0 ? '' : `<div class="captures-block">
        <div class="captures-title">◆ Captured</div>
        <div class="tool-kv">${captureRows
          .map(([k, v]) => `<div class="tool-kv-row"><span class="tool-kv-key">${escapeHtml(k)}</span><span class="tool-kv-value">${escapeHtml(v)}</span></div>`)
          .join('')}</div>
       </div>`;

  const domHtml = step.domSnapshot
    ? `<details class="dom-snapshot">
        <summary>DOM Snapshot<button class="copy-btn" type="button" title="Copy DOM"><span class="copy-btn-label">Copy</span></button></summary>
        <pre>${escapeHtml(step.domSnapshot)}</pre>
       </details>`
    : '';

  const endScreenshotLabel = step.interrupted
    ? 'Page state when stopped'
    : step.status === 'failed' ? 'Page state at failure' : 'Page state at step end';
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

  // The code mark for code-behind, ⚡ for the action cache — two different
  // ways a step avoided the model, and which one it was is the first thing
  // you want to know when the step did something surprising.
  // ⚠ outranks both: the step ran under AI *because* its committed code broke,
  // and that is the one thing about the step's origin worth acting on.
  //
  // Two ⚠ wordings, because `codeBehindStale` only says the ENTRY broke. When
  // the step then passed, the AI covered for it — "ran under AI". When the AI
  // attempt failed too, the step is red and claiming it ran under AI would
  // contradict the ✗ Step Failed block rendered right below it.
  const originBadge = step.codeBehindStale
    ? isHealedStep(step)
      ? '<span class="badge badge-codebehind-stale" title="Its code-behind entry failed and the step healed under AI — recompile">⚠ ran under AI — code-behind failed</span>'
      : '<span class="badge badge-codebehind-stale" title="Its code-behind entry failed, and the AI attempt that took over failed too — recompile">⚠ code-behind failed</span>'
    : step.fromCodeBehind
      ? `<span class="badge badge-codebehind" title="Ran this step's code-behind — no AI call">${CODE_BEHIND_MARK} code</span>`
      : step.fromCache
        ? '<span class="badge badge-cached" title="Replayed from the action cache — no AI call">⚡ cached</span>'
        : '';

  // Alongside the skill chip, not instead of it: a skill invoked from inside
  // a section carries both.
  const sourceSectionBadge = step.sourceSection
    ? `<span class="badge badge-section" title="Step expanded from inline section ${escapeHtml(step.sourceSection)}">${escapeHtml(step.sourceSection)}</span>`
    : '';

  // Which tab this step drove (§11). Shown on every step, not only multi-tab
  // runs: the question "which tab was this?" is asked *after* something has
  // gone wrong, and a badge that appears only sometimes is one the reader has
  // to know to look for. The short target id is what distinguishes two
  // sessions' identically-labelled tabs; the full id is in the tooltip.
  const tabBadge = step.tab
    ? `<span class="badge badge-tab${step.tab.unexpected ? ' badge-tab-unexpected' : ''}" title="${escapeHtml(
        `${step.tab.title || '(untitled)'}\n${step.tab.url}\ntargetId: ${step.tab.targetId ?? '(unavailable)'}` +
          (step.tab.unexpected
            ? '\n\nThis tab was adopted mid-run with nothing in this test accounting for it — ' +
              'most often another test running against the same browser. Advisory only.'
            : ''),
      )}">${step.tab.unexpected ? '⚠ ' : ''}${escapeHtml(step.tab.label)}${
        step.tab.targetId ? ` · ${escapeHtml(step.tab.targetId.slice(0, 6))}` : ''
      }</span>`
    : '';

  return `<div class="step${childStepClass}">
  <div class="step-header">
    <span class="step-number">${escapeHtml(stepNumberLabel)}</span>
    <span class="step-instruction">${escapeHtml(displayedInstruction)}</span>
    ${sourceSectionBadge}
    ${sourceSkillBadge}
    ${originBadge}
    ${tabBadge}
    ${retryBadge}
    <span class="step-duration">${duration}</span>
    <span class="badge ${statusClass}">${statusIcon} ${statusLabel}</span>
    <span class="step-chevron">▼</span>
  </div>
  <div class="step-body">
    ${domHtml}
    ${staleHtml}
    ${codeBehindHtml}
    ${toolHtml}
    ${turnsHtml}
    ${capturesHtml}
    ${assertionHtml}
    ${failureHtml}
    ${endScreenshotHtml}
  </div>
</div>`;
}

/** Exported for unit-test use; not part of the report's public API. */
export { renderStep };

/**
 * The code-behind block: which `.steps.ts` ran, the entry's code in a
 * collapsed `<details>` (same treatment `assertionCode` gets), and any `log`
 * output the entry emitted.
 *
 * Exported for unit-test use; not part of the report's public API.
 */
export function renderCodeBehind(cb: NonNullable<StepResult['codeBehind']>): string {
  const logsHtml = cb.logs.length === 0
    ? ''
    : `<div class="tool-section">
        <div class="tool-section-label">Logs</div>
        <div class="tool-logs">${cb.logs
          .map((l) => `<div class="tool-log-line tool-log-${l.level}">[${l.level}] ${escapeHtml(l.message)}</div>`)
          .join('')}</div>
       </div>`;

  return `<div class="tool-block codebehind-block">
  <div class="tool-header">
    <span class="tool-title">${CODE_BEHIND_MARK} Code-behind</span>
    <span class="tool-name">${escapeHtml(cb.file)}</span>
  </div>
  <details class="assertion-code">
    <summary>Step code</summary>
    <pre><code>${escapeHtml(cb.code)}</code></pre>
  </details>
  ${logsHtml}
</div>`;
}

/**
 * The ⚠ block: this step's committed code-behind broke, the AI carried the
 * step, and nothing was rewritten.
 *
 * Says what to do about it, because the whole point of flagging rather than
 * regenerating is that the author decides when files change
 * (stories/codebehind-compile.md).
 *
 * Exported for unit-test use; not part of the report's public API.
 */
export function renderCodeBehindStale(
  stale: NonNullable<StepResult['codeBehindStale']>,
  /** Did the AI cover for the broken entry? False when the AI attempt failed
   *  too — the recompile hint still applies, the "ran under AI" claim does
   *  not. Defaults true so an older caller reads as it always did. */
  healed: boolean = true,
): string {
  return `<div class="tool-block codebehind-stale-block">
  <div class="tool-header">
    <span class="tool-title">${
      healed ? '⚠ Code-behind failed — ran under AI' : '⚠ Code-behind failed'
    }</span>
    <span class="tool-name">${escapeHtml(stale.file)}</span>
  </div>
  <div class="failure-message">${escapeHtml(stale.error)}</div>
  <div class="tool-section">
    <div class="tool-section-label">Recompile</div>
    <div class="tool-logs"><div class="tool-log-line">aiui compile ${escapeHtml(
      stale.file.replace(/\.steps\.ts$/, '.md'),
    )} --only-stale</div></div>
  </div>
</div>`;
}

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
