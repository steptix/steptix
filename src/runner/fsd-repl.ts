import readline from 'node:readline/promises';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import type { Page } from 'playwright';
import type { StepResult } from '../report/types.js';
import type { StepExecutorOptions } from './step-executor.js';
import { executeStep } from './step-executor.js';
import { captureScreenshot } from '../browser/screenshot.js';
import { logger } from '../utils/logger.js';

export type FsdResumeDecision =
  | { kind: 'resume'; fromStepIndex: number }
  | { kind: 'exit' };

/** Minimal line-reader interface so tests can script REPL input without stdio. */
export interface FsdLineReader {
  question(prompt: string): Promise<string>;
  close(): void;
}

export interface FsdReplContext {
  /** Live Playwright page — ad-hoc REPL steps and screenshots target this page. */
  page: Page;
  /** Ordered list of all step instructions in the test (for :list and resume menu). */
  testSteps: string[];
  /** 1-based index of the step whose failure triggered the handoff. */
  failedStepIndex: number;
  /** Options forwarded to `executeStep` for ad-hoc steps. */
  executorOptions: StepExecutorOptions;
  /**
   * Accumulator that collects StepResults produced inside the REPL
   * (ad-hoc steps and :screenshot captures). The caller merges these into
   * the run's full step list.
   */
  adHocResults: StepResult[];
  /** Optional custom reader (defaults to a readline bound to stdin/stdout). */
  reader?: FsdLineReader;
}

function defaultReader(): FsdLineReader {
  const rl = readline.createInterface({ input: defaultInput, output: defaultOutput });
  return {
    question: (prompt: string) => rl.question(prompt),
    close: () => rl.close(),
  };
}

const HELP_TEXT = [
  'FSD(Supervised) commands:',
  '  :help              show this message',
  '  :list              list all steps in this test',
  '  :screenshot        capture current page and attach to report',
  '  :resume            pick a step to continue from',
  '  :exit              abort the run (equivalent to :quit)',
  '',
  'Any other input is executed as a single Flick step against the live page.',
].join('\n');

function printStepList(testSteps: string[], failedStepIndex: number, write: (s: string) => void): void {
  write('Steps in this test:');
  for (let i = 0; i < testSteps.length; i++) {
    const marker = i + 1 === failedStepIndex ? ' (failed)' : '';
    write(`  ${i + 1}. ${testSteps[i]}${marker}`);
  }
}

/**
 * Prompt the user to pick a step to resume from.
 * Returns `null` if the user cancels (e.g. 'x'), or the 1-based step index.
 */
async function promptResumeMenu(
  testSteps: string[],
  failedStepIndex: number,
  reader: FsdLineReader,
  write: (s: string) => void,
): Promise<number | null> {
  printStepList(testSteps, failedStepIndex, write);
  const defaultIndex = Math.min(failedStepIndex + 1, testSteps.length);
  const answer = (
    await reader.question(
      `Resume from step [${defaultIndex}], or 'x' to cancel: `,
    )
  ).trim();

  if (answer === '') return defaultIndex;
  if (answer.toLowerCase() === 'x') return null;

  const parsed = Number.parseInt(answer, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > testSteps.length) {
    write(`Invalid choice "${answer}"; expected a number between 1 and ${testSteps.length}.`);
    return promptResumeMenu(testSteps, failedStepIndex, reader, write);
  }
  return parsed;
}

/**
 * Run the FSD(Supervised) REPL until the user either resumes or exits.
 * Ad-hoc step results are pushed into `ctx.adHocResults`; the caller is responsible
 * for merging them into the final report.
 */
export async function runFsdRepl(ctx: FsdReplContext): Promise<FsdResumeDecision> {
  const reader = ctx.reader ?? defaultReader();
  const write = (s: string): void => {
    console.log(s);
  };

  try {
    write('');
    write('🛑 Step failed. Dropping into Full Self Driving (Supervised) REPL.');
    write(`   Failed step: ${ctx.failedStepIndex}. ${ctx.testSteps[ctx.failedStepIndex - 1] ?? ''}`);
    write('   Type :help for commands, or type a Flick step to run it against the live page.');

    // Track a synthetic step index for ad-hoc REPL steps — bumps past the test length
    // so they don't collide with real step indices.
    let adHocCounter = 0;
    const adHocStepIndex = (): number => ctx.testSteps.length + (++adHocCounter);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const raw = await reader.question('fsd> ');
      const line = raw.trim();
      if (line === '') continue;

      if (line.startsWith(':')) {
        const cmd = line.toLowerCase();
        if (cmd === ':help') {
          write(HELP_TEXT);
          continue;
        }
        if (cmd === ':list') {
          printStepList(ctx.testSteps, ctx.failedStepIndex, write);
          continue;
        }
        if (cmd === ':screenshot') {
          const shot = await captureScreenshot(
            ctx.page,
            ctx.executorOptions.config.browser.fullPageScreenshots,
          );
          const entry: StepResult = {
            index: adHocStepIndex(),
            instruction: '[fsd: screenshot]',
            status: 'passed',
            turns: [],
            durationMs: 0,
            retried: false,
            fsdAdHoc: true,
            pageUrl: ctx.page.url(),
            ...(shot?.base64 !== undefined && { screenshotBase64: shot.base64 }),
          };
          ctx.adHocResults.push(entry);
          write(`📸 Screenshot captured (${shot?.base64 ? 'attached to report' : 'capture failed'}).`);
          continue;
        }
        if (cmd === ':resume' || cmd === ':continue') {
          const chosen = await promptResumeMenu(
            ctx.testSteps,
            ctx.failedStepIndex,
            reader,
            write,
          );
          if (chosen === null) {
            write('Resume cancelled. Back in REPL.');
            continue;
          }
          return { kind: 'resume', fromStepIndex: chosen };
        }
        if (cmd === ':exit' || cmd === ':quit') {
          return { kind: 'exit' };
        }
        write(`Unknown command "${line}". Type :help for a list.`);
        continue;
      }

      // Ad-hoc Flick step — execute against the live page.
      const index = adHocStepIndex();
      logger.info(`FSD ad-hoc step: ${line}`);
      const result = await executeStep(index, index, line, ctx.executorOptions);
      result.fsdAdHoc = true;
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
