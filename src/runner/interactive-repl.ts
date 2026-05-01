import readline from 'node:readline/promises';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import type { Page } from 'playwright';
import type { StepResult } from '../report/types.js';
import type { StepExecutorOptions } from './step-executor.js';
import { executeStep } from './step-executor.js';
import { captureScreenshot } from '../browser/screenshot.js';
import { logger } from '../utils/logger.js';

/**
 * Decision returned to the test-runner when the REPL loop ends.
 *
 *  - `continue`  → fall through to the next step in the flattened list.
 *  - `resume`    → jump the outer loop to `fromStepIndex` (1-based).
 *  - `exit`      → abort the entire run.
 */
export type InteractiveDecision =
  | { kind: 'continue' }
  | { kind: 'resume'; fromStepIndex: number }
  | { kind: 'exit' };

/** Minimal line-reader interface so tests can script REPL input without stdio. */
export interface InteractiveReader {
  question(prompt: string): Promise<string>;
  close(): void;
}

export interface InteractiveReplContext {
  /** Live Playwright page — ad-hoc REPL steps and screenshots target this page. */
  page: Page;
  /** Ordered list of all step instructions in the test (for /list and /resume menu). */
  testSteps: string[];
  /**
   * 1-based step index that triggered the REPL.
   *  - `entryReason: 'planned'`        → the index of the `[interactive]` step.
   *  - `entryReason: 'failure'`        → the index of the failed step.
   *  - `entryReason: 'clarification'`  → the index of the step the AI asked about.
   *
   * Drives the /list marker and the /resume default.
   */
  currentStepIndex: number;
  /**
   * What opened the REPL.
   *  - 'planned'        → an [interactive] marker in the test
   *  - 'failure'        → post-failure handoff (`INTERACTIVE_ON_FAILURE=true`)
   *  - 'clarification'  → user typed /repl from an AI clarification prompt
   */
  entryReason: 'planned' | 'failure' | 'clarification';
  /** Optional hint shown in the planned-entry banner. */
  hint?: string;
  /** AI's question — only set (and only used) when entryReason === 'clarification'. */
  clarificationQuestion?: string;
  /** Options forwarded to executeStep for ad-hoc Flick steps. */
  executorOptions: StepExecutorOptions;
  /** Accumulator for StepResults produced inside the REPL (caller merges into the run). */
  adHocResults: StepResult[];
  /** Optional custom reader (defaults to readline against stdin/stdout). */
  reader?: InteractiveReader;
  /** Optional output sink (defaults to console.log). Used by tests to capture banner / messages. */
  write?: (line: string) => void;
}

function defaultReader(): InteractiveReader {
  const rl = readline.createInterface({ input: defaultInput, output: defaultOutput });
  return {
    question: (prompt: string) => rl.question(prompt),
    close: () => rl.close(),
  };
}

const HELP_TEXT = [
  'Interactive REPL commands:',
  '  /help              show this message',
  '  /list              list all steps in this test',
  '  /screenshot        capture current page and attach to report',
  '  /resume            pick a step to continue from',
  '  /continue          leave the REPL and run the next step',
  '  /exit              abort the run (alias: /quit)',
  '',
  'Any other input is executed as a single Flick step against the live page.',
].join('\n');

/** Slash-prefixed command names recognised by the REPL. */
const KNOWN_COMMANDS = new Set([
  '/help',
  '/list',
  '/screenshot',
  '/resume',
  '/continue',
  '/exit',
  '/quit',
]);

/** Bare-word inputs that used to mean something — we now reject them with a hint. */
const DEPRECATED_HINTS: Record<string, string> = {
  done: '"done" is no longer recognised — use /continue to advance, /exit to abort.',
  exit: '"exit" is no longer recognised as a bare word — use /exit to abort, /continue to advance.',
  quit: '"quit" is no longer recognised as a bare word — use /quit (or /exit) to abort.',
  ':continue': 'Commands are now /-prefixed — use /continue.',
  ':exit': 'Commands are now /-prefixed — use /exit.',
  ':quit': 'Commands are now /-prefixed — use /quit.',
  ':resume': 'Commands are now /-prefixed — use /resume.',
  ':screenshot': 'Commands are now /-prefixed — use /screenshot.',
  ':list': 'Commands are now /-prefixed — use /list.',
  ':help': 'Commands are now /-prefixed — use /help.',
};

function printStepList(testSteps: string[], currentStepIndex: number, marker: string, write: (s: string) => void): void {
  write('Steps in this test:');
  for (let i = 0; i < testSteps.length; i++) {
    const tag = i + 1 === currentStepIndex ? ` (${marker})` : '';
    write(`  ${i + 1}. ${testSteps[i]}${tag}`);
  }
}

/**
 * Prompt the user to pick a step to resume from.
 * Returns null if the user cancels (e.g. 'x'), or the 1-based step index.
 */
async function promptResumeMenu(
  testSteps: string[],
  currentStepIndex: number,
  marker: string,
  reader: InteractiveReader,
  write: (s: string) => void,
): Promise<number | null> {
  printStepList(testSteps, currentStepIndex, marker, write);
  const defaultIndex = Math.min(currentStepIndex + 1, testSteps.length);
  const answer = (
    await reader.question(`Resume from step [${defaultIndex}], or 'x' to cancel: `)
  ).trim();

  if (answer === '') return defaultIndex;
  if (answer.toLowerCase() === 'x') return null;

  const parsed = Number.parseInt(answer, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > testSteps.length) {
    write(`Invalid choice "${answer}"; expected a number between 1 and ${testSteps.length}.`);
    return promptResumeMenu(testSteps, currentStepIndex, marker, reader, write);
  }
  return parsed;
}

/** First whitespace-delimited token (lowercase), or '' for blank input. */
function firstToken(line: string): string {
  const m = line.trim().match(/^\S+/);
  return m ? m[0]!.toLowerCase() : '';
}

/**
 * Run the unified interactive REPL until the user picks `/continue`,
 * `/resume`, or `/exit`. Ad-hoc step results are pushed into
 * `ctx.adHocResults`; the caller is responsible for merging them
 * into the final report.
 */
export async function runInteractiveRepl(ctx: InteractiveReplContext): Promise<InteractiveDecision> {
  const reader = ctx.reader ?? defaultReader();
  const write = ctx.write ?? ((s: string): void => { console.log(s); });
  const marker = ctx.entryReason === 'failure' ? 'failed' : 'current';

  try {
    write('');
    if (ctx.entryReason === 'failure') {
      write('🛑 Step failed. Dropping into interactive REPL.');
      write(`   Failed step: ${ctx.currentStepIndex}. ${ctx.testSteps[ctx.currentStepIndex - 1] ?? ''}`);
      write('   Type /help for commands, /resume to jump to a step, /exit to abort.');
    } else if (ctx.entryReason === 'clarification') {
      const question = ctx.clarificationQuestion?.trim() ?? '';
      write('🤔 AI asked a clarifying question:');
      if (question) write(`   ${question}`);
      write('   Type /help for commands, /continue to skip the question, /resume to jump elsewhere, /exit to abort.');
    } else {
      const hint = ctx.hint?.trim();
      const hintSuffix = hint ? ` — ${hint}` : '';
      write(`🎮 Interactive mode${hintSuffix}`);
      write('   Type /help for commands, /continue to advance, /exit to abort.');
    }

    // Synthetic indices for ad-hoc REPL steps — bumped past the test length so they
    // don't collide with real step indices.
    let adHocCounter = 0;
    const adHocStepIndex = (): number => ctx.testSteps.length + (++adHocCounter);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const raw = await reader.question('> ');
      const line = raw.trim();
      if (line === '') continue;

      const head = firstToken(line);

      // Deprecated bare-word / colon-prefix commands → hint and stay in REPL.
      const deprecatedMsg = DEPRECATED_HINTS[head];
      if (deprecatedMsg && head === line.toLowerCase()) {
        write(deprecatedMsg);
        continue;
      }

      // Slash-prefixed inputs are commands ONLY when the first token is a known
      // command name. This lets ad-hoc Flick steps that start with a path
      // (e.g. "/admin/users page should load") fall through normally.
      if (head.startsWith('/')) {
        if (!KNOWN_COMMANDS.has(head)) {
          // If it looks like an unknown command (single token, no space), tell the user.
          // Multi-token inputs starting with / fall through to executeStep.
          if (head === line.toLowerCase()) {
            write(`Unknown command "${line}". Type /help for a list.`);
            continue;
          }
        } else {
          if (head === '/help') {
            write(HELP_TEXT);
            continue;
          }
          if (head === '/list') {
            printStepList(ctx.testSteps, ctx.currentStepIndex, marker, write);
            continue;
          }
          if (head === '/screenshot') {
            const shot = await captureScreenshot(
              ctx.page,
              ctx.executorOptions.config.browser.fullPageScreenshots,
            );
            const entry: StepResult = {
              index: adHocStepIndex(),
              instruction: '[interactive: screenshot]',
              status: 'passed',
              turns: [],
              durationMs: 0,
              retried: false,
              interactiveAdHoc: true,
              pageUrl: ctx.page.url(),
              ...(shot?.base64 !== undefined && { screenshotBase64: shot.base64 }),
            };
            ctx.adHocResults.push(entry);
            write(`📸 Screenshot captured (${shot?.base64 ? 'attached to report' : 'capture failed'}).`);
            continue;
          }
          if (head === '/resume') {
            const chosen = await promptResumeMenu(
              ctx.testSteps,
              ctx.currentStepIndex,
              marker,
              reader,
              write,
            );
            if (chosen === null) {
              write('Resume cancelled. Back in REPL.');
              continue;
            }
            return { kind: 'resume', fromStepIndex: chosen };
          }
          if (head === '/continue') {
            return { kind: 'continue' };
          }
          if (head === '/exit' || head === '/quit') {
            return { kind: 'exit' };
          }
        }
      }

      // Ad-hoc Flick step — execute against the live page.
      const index = adHocStepIndex();
      logger.info(`Interactive ad-hoc step: ${line}`);
      const result = await executeStep(index, index, line, ctx.executorOptions);
      result.interactiveAdHoc = true;
      ctx.adHocResults.push(result);
      if (result.status === 'passed') {
        write(`✓ ad-hoc step passed`);
      } else {
        write(`✗ ad-hoc step failed: ${result.error ?? 'unknown error'} — still in REPL.`);
      }
    }
  } finally {
    if (!ctx.reader) {
      reader.close();
    }
  }
}
