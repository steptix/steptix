import type { Page, BrowserContext, Browser } from 'playwright';
import { interpolate } from '../parser/parameters.js';
import { envDataRefsIn, interpolateEnvData, resolveEnvDataRef, type EnvDataContext } from '../parser/interpolate-env-data.js';
import { createCapturingLog, type CapturedLog } from '../tools/step-api.js';
import type { CodeBehindBinding, CodeBehindVarScope } from './loader.js';
import { unavailableBrowserApi, unavailableTabApi } from './tabs.js';
import {
  resolveUploadPathSync,
  nonRetryable,
  isNonRetryable,
  type UploadPathContext,
} from '../browser/upload-paths.js';
import type {
  CodeBehindBrowserApi,
  CodeBehindContext,
  CodeBehindStepApi,
  CodeBehindTabApi,
  StepCodeEntry,
} from './types.js';

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
  /**
   * Tab and browser control (stories/codebehind-framework-actions.md), built
   * over the run's own trackers so a switch here is the switch the following
   * natural-language steps see.
   *
   * Omitted by a caller with no tracker, and replaced with an API whose every
   * method throws — never left undefined, because an entry destructuring
   * `{ tabs }` would then get `undefined` and fail with a TypeError that says
   * nothing about why.
   */
  tabs?: CodeBehindTabApi | undefined;
  browsers?: CodeBehindBrowserApi | undefined;
  /**
   * The run's env/data context, when it has one — what `${data.url}` was
   * resolved against in the step text, and what `step.getVar('data.url')`
   * reads from the entry (stories/codebehind-env-data.md).
   */
  envData?: EnvDataContext | undefined;
  baseUrl?: string | undefined;
  /**
   * Code-behind step-into (stories/codebehind-debugging.md) — hit a
   * `debugger;` immediately before `entry.run(ctx)`. Set only after the
   * session manager's awaiting-debugger/ack round-trip, so an inspector is
   * attached by the time it fires. No-op when none is (a plain `debugger;`
   * without an inspector does nothing).
   */
  pauseBeforeRun?: boolean | undefined;
  /** Step label used in log lines, e.g. `codebehind:12`. */
  label: string;
  /** Where a path passed to `step.filePath` resolves from: the test file's
   *  folder, fenced by the project root. Absent on a run with no test file,
   *  where `step.filePath` accepts only absolute paths. */
  uploadPaths?: UploadPathContext | undefined;
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
  /**
   * True when the failure is a fact about the world rather than broken code —
   * today, a `step.filePath` whose file is missing, is a folder, or sits
   * outside the project. The runner must NOT heal these: the entry is fine, so
   * re-running the step under AI would spend a turn and discard a working
   * entry for a failure no re-planning can fix.
   */
  nonRetryable?: boolean;
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
    step: makeStepApi(
      options.binding.scope,
      options.resolvedParameters,
      outputs,
      options.envData,
      options.uploadPaths,
    ),
    log: createCapturingLog(options.label, logs),
    tabs: options.tabs ?? unavailableTabApi(),
    browsers: options.browsers ?? unavailableBrowserApi(),
    ...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
  };

  try {
    if (options.pauseBeforeRun) {
      // Cooperative pause point for code-behind step-into. The session
      // manager has already emitted `codebehind:awaiting-debugger` and
      // waited for the client's ack, so a debugger is attached. Stepping
      // past this line lands the user inside `entry.run` — the author's
      // `.steps.ts`, via the bundle's inline sourcemap.
      // eslint-disable-next-line no-debugger
      debugger;
    }
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
      ...(isNonRetryable(err) && { nonRetryable: true }),
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
 *  3. the bare name,
 *  4. the environment: `data.url`, `env.BASE_URL`, `<source>.path`,
 *     `envName` — the name inside a `${...}` placeholder, resolved against
 *     the run's context the way the parser resolved the placeholder
 *     (stories/codebehind-env-data.md). Parameters win, as they would in
 *     the markdown; a run with no environment answers `undefined`.
 *
 * Steps at the top level or in a plain section have an empty scope, so the
 * first three collapse to "the bare name" and this behaves exactly like the
 * tool executor's `step`.
 */
function makeStepApi(
  scope: CodeBehindVarScope,
  resolvedParameters: Record<string, string>,
  outputs: Record<string, string>,
  envData?: EnvDataContext | undefined,
  uploadPaths?: UploadPathContext | undefined,
): CodeBehindStepApi {
  return {
    getVar(name) {
      const renamed = scope.renames[name];
      if (renamed !== undefined) return resolvedParameters[renamed];
      const input = scope.inputs[name];
      // A caller may have passed `{{outer}}` through as the argument, which
      // the expander interpolates into the body text at run time rather than
      // at expansion time. Resolve it the same way here — and then resolve
      // `${env.X}` / `${data.X}` the way the parser resolved the step text,
      // because the expander captured the argument RAW (env-data
      // interpolation runs after expansion and never walks frame inputs).
      // Fail fast on a reference this run cannot answer: silently handing
      // generated code the literal "${data.x}" text is the same failure with
      // no error message.
      if (input !== undefined) {
        const value = interpolate(input, resolvedParameters);
        const refs = envDataRefsIn(value);
        if (refs.length === 0) return value;
        if (!envData) {
          throw new Error(
            `skill argument "${name}" references \${${refs[0]}} and the run has no environment context to resolve it`,
          );
        }
        return interpolateEnvData(value, envData);
      }
      const bare = resolvedParameters[name];
      if (bare !== undefined) return bare;
      return envData ? resolveEnvDataRef(name, envData) : undefined;
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
    filePath(relative) {
      // `step.filePath(step.getVar('x'))` is the parameterised form, and
      // `getVar` answers `undefined` for a name this run has no value for —
      // say so, rather than letting "undefined" become a path segment.
      if (typeof relative !== 'string' || relative.trim() === '') {
        throw nonRetryable(
          'step.filePath needs a path; it was given '
          + (relative === undefined
            ? 'nothing (step.getVar returned undefined?)'
            : JSON.stringify(relative))
          + '. Pass the path as written in the step',
        );
      }
      return resolveUploadPathSync(relative, uploadPaths ?? {});
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
