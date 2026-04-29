import type { Page } from 'playwright';
import type { AiClient } from './client.js';
import type { ChatMessage, MessageContentBlock } from './types.js';
import type { StepResult, TestReport, FailureDiagnosis, AiInteraction } from '../report/types.js';
import { captureScreenshot } from '../browser/screenshot.js';
import { captureDomSnapshot, type CaptureDomOptions } from '../browser/dom-cleaner.js';
import { contentBlocksToText } from './prompts.js';
import { logger } from '../utils/logger.js';

const FAULT_CATEGORIES = ['test-spec', 'application', 'flake', 'environment', 'unknown'] as const;
const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;

/** Raw JSON shape the AI is asked to return */
interface DiagnosisResponse {
  rootCause?: unknown;
  faultCategory?: unknown;
  evidence?: unknown;
  suggestedFix?: unknown;
  confidence?: unknown;
}

/**
 * Run a post-failure root-cause analysis pass.
 * Feeds the AI the full test context (spec, step results, final page state) and asks
 * it to diagnose why the test failed. Returns null if diagnosis itself fails — it is
 * never allowed to throw into the test pipeline.
 */
export async function diagnoseFailure(
  report: TestReport,
  page: Page,
  aiClient: AiClient,
  contextContent: string,
  opts: CaptureDomOptions = {},
): Promise<FailureDiagnosis | null> {
  try {
    const failingStep = report.steps.find((s) => s.status === 'failed');
    const lastStep = report.steps[report.steps.length - 1];
    const subject = failingStep ?? lastStep;
    if (!subject) {
      logger.warn('Diagnose: no step results available; skipping');
      return null;
    }

    // Grab a fresh snapshot of where the test ended up. Best-effort — if the browser
    // is already closed or unresponsive we fall back to what the step captured.
    const [screenshot, domSnapshot] = await Promise.all([
      captureScreenshot(page).catch(() => null),
      captureDomSnapshot(page, opts).catch(() => ''),
    ]);

    const finalScreenshot = screenshot?.base64 ?? subject.screenshotBase64;
    const finalDom = domSnapshot || subject.domSnapshot || '';
    const pageUrl = safeUrl(page) ?? subject.pageUrl;

    const systemPrompt = buildDiagnoseSystemPrompt(contextContent);
    const userContent = buildDiagnoseUserContent(report, subject, finalDom, pageUrl, finalScreenshot);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ];

    const requestStartedAt = new Date().toISOString();
    const completion = await aiClient.complete(messages);
    const responseText = completion.text;

    const parsed = parseDiagnosis(responseText);
    if (!parsed) {
      logger.warn('Diagnose: AI response did not parse into a valid diagnosis');
      return null;
    }

    const aiInteraction: AiInteraction = {
      purpose: 'failure-diagnosis',
      // Flatten the cacheable block structure for the human-readable report; cache hints
      // only matter on the wire to aiapi, not in the saved interaction log.
      requestMessages: [
        { role: 'system', content: contentBlocksToText(systemPrompt) },
        { role: 'user', content: contentBlocksToText(userContent) },
      ],
      response: responseText,
      model: completion.model,
      timestamp: requestStartedAt,
      ...(finalScreenshot !== undefined && { screenshotBase64: finalScreenshot }),
      ...(pageUrl !== undefined && { pageUrl }),
    };

    return { ...parsed, aiInteraction };
  } catch (err) {
    logger.warn(`Diagnose failed: ${String(err)}`);
    return null;
  }
}

function buildDiagnoseSystemPrompt(contextContent: string): MessageContentBlock[] {
  const blocks: MessageContentBlock[] = [
    {
      type: 'text',
      text: `You are an expert QA engineer performing post-mortem root-cause analysis on a failed UI test.

You are given:
- The test specification (steps authored in a markdown file)
- The per-step execution results (URLs, pass/fail, error messages, AI reasoning)
- A screenshot and DOM snapshot of the page when the test stopped

Your job: determine *why* the test failed and tell the human how to fix it.

Key signals to look for:
- URL deltas between steps — a step marked "passed" but where the URL did not change may indicate the action did not actually take effect (e.g. a typed query that never submitted)
- Assertion error messages — they often cite exactly what was missing on the page
- The final screenshot and DOM — what state did the page actually end up in versus what the step expected?
- Ambiguous step wording — does the failing step combine multiple intents into one sentence that the agent might have mis-ordered?

## Response format
Return ONLY a JSON object (no markdown, no prose) with these fields:
{
  "rootCause": "one paragraph explaining what actually went wrong (be specific, cite evidence)",
  "faultCategory": "test-spec" | "application" | "flake" | "environment" | "unknown",
  "evidence": ["short observation 1", "short observation 2", "..."],
  "suggestedFix": "concrete advice — if test-spec, prefer a rewritten list of steps in plain text",
  "confidence": "high" | "medium" | "low"
}

Fault category guidance:
- test-spec: wording/logic issue in the test .md (ambiguous, missing wait, combined actions)
- application: a real app defect the test correctly surfaced
- flake: timing, selector fragility, or network instability
- environment: config, credentials, or infrastructure outside the test
- unknown: genuinely insufficient evidence`,
      cache: true,
    },
  ];

  if (contextContent) {
    blocks.push({
      type: 'text',
      text: `## Application Context\n${contextContent}`,
      cache: true,
    });
  }

  return blocks;
}

function buildDiagnoseUserContent(
  report: TestReport,
  subject: StepResult,
  finalDom: string,
  pageUrl: string | undefined,
  finalScreenshot: string | undefined,
): string | MessageContentBlock[] {
  const summary = formatReportSummary(report, subject, pageUrl);
  const stepsSection = formatStepResults(report.steps);
  const failingDetails = formatFailingStepDetails(subject);
  const domSection = finalDom
    ? `\n## Final DOM snapshot\n\n\`\`\`html\n${truncate(finalDom, 8000)}\n\`\`\`\n`
    : '';

  const textBody = `${summary}\n\n${stepsSection}\n\n${failingDetails}${domSection}\n## Task\nProduce the diagnosis JSON now.`;

  if (finalScreenshot) {
    return [
      { type: 'text', text: textBody },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${finalScreenshot}` } },
    ];
  }
  return textBody;
}

function formatReportSummary(report: TestReport, subject: StepResult, pageUrl: string | undefined): string {
  const lines = [
    `## Test`,
    `- Name: ${report.testName}`,
    ...(report.baseUrl ? [`- Base URL: ${report.baseUrl}`] : []),
    `- Overall status: ${report.status}`,
    `- Failing step: ${subject.index} of ${report.totalSteps}`,
    ...(pageUrl ? [`- Final URL: ${pageUrl}`] : []),
  ];
  return lines.join('\n');
}

function formatStepResults(steps: StepResult[]): string {
  const rows = steps.map((s) => {
    const statusIcon = s.status === 'passed' ? '✓' : s.status === 'failed' ? '✗' : '·';
    const url = s.pageUrl ? ` [url: ${s.pageUrl}]` : '';
    return `${statusIcon} Step ${s.index}: ${s.instruction}${url}`;
  });
  return `## Step-by-step results\n${rows.join('\n')}`;
}

function formatFailingStepDetails(step: StepResult): string {
  const parts: string[] = [`## Failing step details`, `Instruction: ${step.instruction}`];

  if (step.error) parts.push(`Error: ${step.error}`);
  if (step.aiExplanation) parts.push(`AI explanation: ${step.aiExplanation}`);

  if (step.assertions && step.assertions.length > 0) {
    for (const a of step.assertions) {
      parts.push(
        `Assertion: ${a.description}`,
        `  Expected: "${a.expected}"`,
        `  Actual: "${a.actual}"`,
        `  Result: ${a.pass ? 'pass' : 'fail'} — ${a.explanation}`,
      );
    }
  }

  if (step.turns.length > 0) {
    const actions = step.turns.flatMap((t) => t.subActions).map((sa) => {
      const err = sa.error ? ` [ERROR: ${sa.error}]` : '';
      return `- ${sa.action.action}: ${sa.action.description}${err}`;
    });
    if (actions.length > 0) {
      parts.push(`Actions the AI attempted during this step:\n${actions.join('\n')}`);
    }
  }

  return parts.join('\n');
}

function parseDiagnosis(text: string): Omit<FailureDiagnosis, 'aiInteraction'> | null {
  const raw = extractJsonObject(text);
  if (!raw) return null;

  let parsed: DiagnosisResponse;
  try {
    parsed = JSON.parse(raw) as DiagnosisResponse;
  } catch {
    return null;
  }

  const rootCause = typeof parsed.rootCause === 'string' ? parsed.rootCause.trim() : '';
  const suggestedFix = typeof parsed.suggestedFix === 'string' ? parsed.suggestedFix.trim() : '';
  if (!rootCause || !suggestedFix) return null;

  const faultCategory = FAULT_CATEGORIES.includes(parsed.faultCategory as (typeof FAULT_CATEGORIES)[number])
    ? (parsed.faultCategory as FailureDiagnosis['faultCategory'])
    : 'unknown';

  const confidence = CONFIDENCE_LEVELS.includes(parsed.confidence as (typeof CONFIDENCE_LEVELS)[number])
    ? (parsed.confidence as FailureDiagnosis['confidence'])
    : 'low';

  const evidence = Array.isArray(parsed.evidence)
    ? parsed.evidence.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
    : [];

  return { rootCause, faultCategory, evidence, suggestedFix, confidence };
}

/** Extract the first balanced JSON object from a string — tolerates leading/trailing prose */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n<!-- truncated at ${max} chars for diagnosis -->`;
}

function safeUrl(page: Page): string | undefined {
  try {
    return page.url();
  } catch {
    return undefined;
  }
}
