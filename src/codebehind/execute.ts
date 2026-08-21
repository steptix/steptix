import type { Page, BrowserContext, Browser } from 'playwright';
import { interpolate } from '../parser/parameters.js';
import { createCapturingLog, type CapturedLog } from '../tools/step-api.js';
import type { CodeBehindBinding, CodeBehindVarScope } from './loader.js';
import type { CodeBehindContext, CodeBehindStepApi, StepCodeEntry } from './types.js';

/**
 * Running one code-behind entry (stories/step-codebehind.md, "Execution").
 *
 * The substrate is the tool layer's: the same live Playwright instances the
 * AI loop drives, and the same variable map `{{var}}` and `[as: x]` use. The
 * one thing tools don't need is frame-aware variables — see `makeStepApi`.
 */

/** A `step.expect` that failed. Distinct because it is a REAL step failure:
 *  broken code heals and falls through to AI, a failed assertion does not. */
export class CodeBehindExpectationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeBehindExpectationError';
  }
}

export interface RunCodeBehindOptions {
  binding: CodeBehindBinding;
  page: Page;
  context: BrowserContext;
  browser: Browser;
  /** Live parameter map — the same object `{{var}}` and `[as: x]` use. */
  resolvedParameters: Record<string, string>;
  baseUrl?: string | undefined;
  /** Step label used in log lines, e.g. `codebehind:12`. */
  label: string;
}

export interface CodeBehindOutcome {
  status: 'passed' | 'failed';
  /** True when the failure came from `step.expect` — fail the step, do not
   *  fall through to AI. */
  expectationFailed: boolean;
  durationMs: number;
  logs: CapturedLog[];
  /** Values the entry wrote, under their effective (post-rename) names. */
  outputs: Record<string, string>;
  error?: string;
}

/** Execute an entry's `run`. Never throws — the caller decides what a failure
 *  means (heal-and-fall-through, or fail the step). */
export async function runCodeBehindEntry(
  options: RunCodeBehindOptions,
): Promise<CodeBehindOutcome> {
  const start = Date.now();
  const logs: CapturedLog[] = [];
  const outputs: Record<string, string> = {};
  const entry = options.binding.entry;

  if (!entry?.run) {
    return {
      status: 'failed',
      expectationFailed: false,
      durationMs: 0,
      logs,
      outputs,
      error: 'Code-behind entry has no `run` function',
    };
  }

  const ctx: CodeBehindContext = {
    page: options.page,
    context: options.context,
    browser: options.browser,
    step: makeStepApi(options.binding.scope, options.resolvedParameters, outputs),
    log: createCapturingLog(options.label, logs),
    ...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
  };

  try {
    await Promise.resolve(entry.run(ctx));
    return {
      status: 'passed',
      expectationFailed: false,
      durationMs: Date.now() - start,
      logs,
      outputs,
    };
  } catch (err) {
    return {
      status: 'failed',
      expectationFailed: err instanceof CodeBehindExpectationError,
      durationMs: Date.now() - start,
      logs,
      outputs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The frame-aware variable view.
 *
 * Generated code is written **once per skill**, not per invocation, so it uses
 * the name the author wrote (`username`). The expander rewrote *this*
 * invocation's step text to `__skill<N>_username` — or to a caller's output
 * alias — and it interpolated declared parameters straight into the text,
 * where they exist under no runtime name at all. So a read resolves in three
 * steps and a write in one:
 *
 *  1. the frame's rename table (internal names + output aliases),
 *  2. the frame's captured inputs (declared parameters),
 *  3. the bare name.
 *
 * Steps at the top level or in a plain section have an empty scope, so all
 * three collapse to "the bare name" and this behaves exactly like the tool
 * executor's `step`.
 */
function makeStepApi(
  scope: CodeBehindVarScope,
  resolvedParameters: Record<string, string>,
  outputs: Record<string, string>,
): CodeBehindStepApi {
  return {
    getVar(name) {
      const renamed = scope.renames[name];
      if (renamed !== undefined) return resolvedParameters[renamed];
      const input = scope.inputs[name];
      // A caller may have passed `{{outer}}` through as the argument, which
      // the expander interpolates into the body text at run time rather than
      // at expansion time. Resolve it the same way here.
      if (input !== undefined) return interpolate(input, resolvedParameters);
      return resolvedParameters[name];
    },
    setVar(name, value) {
      const effective = scope.renames[name] ?? name;
      const stored = Array.isArray(value)
        ? JSON.stringify(value)
        : typeof value === 'string' ? value : String(value);
      resolvedParameters[effective] = stored;
      outputs[effective] = stored;
    },
    expect(condition, message) {
      if (!condition) {
        throw new CodeBehindExpectationError(message ?? 'Code-behind expectation failed');
      }
    },
  };
}

/**
 * The entry's source text, for the report's collapsed code block.
 *
 * Read off the imported function rather than re-reading the file: the entry
 * that ran is the one shown, even when the file has since been edited.
 */
export function entrySourceText(entry: StepCodeEntry): string {
  return entry.run ? String(entry.run) : '(no run function)';
}
