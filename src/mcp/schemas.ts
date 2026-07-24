/**
 * Tool input and output schemas.
 *
 * Output schemas are not documentation — the SDK validates against them, and
 * the failure mode is nasty: `validateToolOutput` throws when
 * `structuredContent` is missing or does not match, and the SDK's own handler
 * catches that and returns `{content, isError:true}` *with no structured
 * content at all*. So a fold bug would silently produce exactly the shape we
 * promise never to produce for a run that reached the server, and the agent
 * would lose `sessionId`, `steps` and `reportPath` at the worst moment.
 *
 * Two consequences run through every schema here:
 *  - every nullable field is spelled `.nullable()`, because a MISSING key is
 *    fatal where an unexpected one is merely stripped;
 *  - handlers `safeParse` their own result before returning it (see
 *    `tools.ts`), so a mismatch degrades to a valid error result instead of
 *    the SDK's silent rewrite.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared input fragments
// ---------------------------------------------------------------------------

const projectRoot = z
  .string()
  .optional()
  .describe(
    'Absolute path of the project (the directory containing aiui.config.json). ' +
      'Optional when the server was started inside the project, or when ' +
      'AIUI_MCP_ROOTS names exactly one directory.',
  );

const sessionId = z
  .string()
  .optional()
  .describe(
    'Reuse an existing browser session. Calls sharing a session id run one at ' +
      'a time, and share page state and captured variables. Ids not starting ' +
      '"mcp:" belong to other clients and are refused unless ' +
      'allow_foreign_session is set.',
  );

const envName = z
  .string()
  .optional()
  .describe(
    'Environment name, selecting .env.<name> beside aiui.config.json. Drives ' +
      '${env.X} and ${data.X} substitution.',
  );

const parameters = z
  .record(z.string(), z.string())
  .optional()
  .describe('Values for the test\'s ## Parameters, overriding those declared in the file.');

const toolConfig = z
  .object({
    baseUrl: z.string().optional(),
    timeout: z.string().optional(),
  })
  .optional()
  .describe(
    'Overrides the test\'s ## Config. Applied only when the session is first ' +
      'created — the server refuses it on an existing session, so close the ' +
      'session first to change it.',
  );

const allowForeignSession = z
  .boolean()
  .optional()
  .describe(
    'Permit a session id not starting "mcp:". Such a session may belong to a ' +
      "developer's open editor, and running steps in it drives their browser.",
  );

const includeScreenshot = z
  .boolean()
  .optional()
  .describe(
    'Attach a screenshot of the failing page. Off by default: it is a picture ' +
      'of whatever was on screen, which for a logged-in test is a live session.',
  );

export const runStepsInput = {
  steps: z
    .array(z.string())
    .min(1)
    .describe(
      'Natural-language steps, one per entry. Supports the same syntax as a ' +
        'test file: `[skill: name]`, `[tool: name]`, `[input: ...]`, section ' +
        'calls, and ${env.X} substitution.',
    ),
  session_id: sessionId,
  project_root: projectRoot,
  env_name: envName,
  parameters,
  config: toolConfig,
  allow_foreign_session: allowForeignSession,
  include_screenshot: includeScreenshot,
};

export const runTestFileInput = {
  path: z.string().describe('Absolute path of the .md test file to run.'),
  session_id: sessionId,
  project_root: projectRoot,
  env_name: envName,
  parameters,
  config: toolConfig,
  allow_foreign_session: allowForeignSession,
  include_screenshot: includeScreenshot,
};

export const listTestFilesInput = { project_root: projectRoot };
export const listSessionsInput = { project_root: projectRoot };
export const serverStatusInput = { project_root: projectRoot };

export const closeSessionInput = {
  session_id: z.string().describe('Session to close. Closing an unknown session succeeds.'),
  project_root: projectRoot,
  allow_foreign_session: allowForeignSession,
};

export const getLastRunInput = {
  session_id: z.string().describe('Session whose last finished run to report on.'),
  project_root: projectRoot,
};

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

const foldedStep = z.object({
  index: z.number(),
  sentIndex: z.number().nullable(),
  line: z.number(),
  uri: z.string(),
  frameKind: z.enum(['test', 'skill', 'section']),
  frameName: z.string().nullable(),
  text: z.string().nullable(),
  status: z.enum(['passed', 'failed', 'skipped', 'not-run', 'unknown']),
  output: z.string().nullable(),
  error: z.string().nullable(),
  fromCache: z.boolean(),
  durationMs: z.number().nullable(),
});

const tokens = z.object({
  total: z.number(),
  input: z.number(),
  output: z.number(),
});

export const runResultOutput = {
  status: z.enum(['passed', 'failed', 'error', 'aborted']),
  streamDropped: z.boolean(),
  sessionId: z.string(),
  projectRoot: z.string(),
  sessionCreated: z.boolean(),
  configApplied: z.boolean(),
  queuedForMs: z.number(),
  steps: z.array(foldedStep),
  captures: z.record(z.string(), z.string()),
  messages: z.array(z.object({ level: z.enum(['error', 'warn']), text: z.string() })),
  warnings: z.array(z.string()),
  reportPath: z.string().nullable(),
  tokens: tokens.nullable(),
  error: z.string().nullable(),
};

export const listTestFilesOutput = {
  // Wrapped rather than a bare array: `structuredContent` must be a JSON
  // object.
  files: z.array(z.string()),
  projectRoot: z.string(),
};

export const listSessionsOutput = {
  sessions: z.array(
    z.object({
      sessionId: z.string(),
      owner: z.enum(['mcp', 'other']),
      status: z.string().nullable(),
      currentUrl: z.string().nullable(),
      pageTitle: z.string().nullable(),
      totalStepsExecuted: z.number().nullable(),
    }),
  ),
};

export const closeSessionOutput = {
  sessionId: z.string(),
  closed: z.boolean(),
};

export const getLastRunOutput = {
  finalized: z.boolean(),
  reportPath: z.string().nullable(),
  tokens: tokens.nullable(),
};

export const serverStatusOutput = {
  baseUrl: z.string(),
  running: z.boolean(),
  detail: z.string().nullable(),
  version: z.string().nullable(),
  pid: z.number().nullable(),
  startedAt: z.string().nullable(),
  openSessions: z.number().nullable(),
  runsInFlight: z.number().nullable(),
  inspector: z.string().nullable(),
  idleTimeoutMinutes: z.number().nullable(),
};

// ---------------------------------------------------------------------------
// Object forms, for the `safeParse` every handler runs before returning.
//
// The SDK would validate these itself, but its failure path turns a mismatch
// into `isError:true` with no structured content — so we check first and
// degrade to something still usable.
// ---------------------------------------------------------------------------

export const runResultSchema = z.object(runResultOutput);
export const listTestFilesSchema = z.object(listTestFilesOutput);
export const listSessionsSchema = z.object(listSessionsOutput);
export const closeSessionSchema = z.object(closeSessionOutput);
export const getLastRunSchema = z.object(getLastRunOutput);
export const serverStatusSchema = z.object(serverStatusOutput);

export type RunResult = z.infer<typeof runResultSchema>;
