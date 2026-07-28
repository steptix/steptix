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
 *
 * Every schema reaches the SDK through `toolSchema`, which is what keeps the
 * emitted JSON Schema acceptable to a modern client — see the note there.
 */
import { z } from 'zod';

/**
 * Wrap a field shape into the object schema `registerTool` receives, and make
 * it claim no JSON Schema dialect at all.
 *
 * `McpServer.registerTool` converts these schemas with a hardcoded draft-07
 * target — `mapMiniTarget` in the SDK's `server/zod-json-schema-compat.js`
 * defaults to `'draft-7'` and `registerTool` never passes a target, unchanged
 * through SDK 1.30. The client bundled in opencode-ai >= 1.18.8 then validates
 * `structuredContent` with Ajv2020 and throws "JSON Schema declares an
 * unsupported dialect" for any `$schema` that is not 2020-12. Between those
 * two, every tool call against this server failed on the dialect label alone —
 * nothing about the schemas themselves was wrong.
 *
 * We drop the key rather than correcting it. That client's gate is
 * `"$schema" in schema && !accepted.has(...)`: an absent key skips the check
 * entirely and falls through to whatever meta-schema the client already
 * defaults to. Declaring 2020-12 also works against opencode specifically, but
 * it is a claim, and a claim can collide with the next client that defaults to
 * something else. Omission asserts nothing, so there is nothing to disagree
 * with.
 *
 * This is only honest because these bodies are dialect-neutral — no
 * `definitions`, `$ref`, tuple `items` or boolean `exclusiveMinimum`, so the
 * draft-07 and 2020-12 renderings are byte-identical. `mcp-schema-dialect.
 * test.ts` asserts that per schema, so a future draft-07-only construct fails
 * loudly instead of silently shipping a body that reads differently depending
 * on who parses it.
 *
 * `.meta()` is the one hook the SDK's conversion honours. An explicit
 * `undefined` *deletes* the key (`.meta({})` leaves the SDK's draft-07 standing,
 * and `null` would emit `null` and fail the gate outright).
 *
 * The object form — rather than the bare shape the SDK also accepts — is what
 * gives us somewhere to hang `.meta()` at all; otherwise the SDK builds the
 * object itself and we never see it. It doubles as the `safeParse` handle the
 * handlers use on their own results.
 */
function toolSchema<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).meta({ $schema: undefined });
}

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

export const runStepsInput = toolSchema({
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
});

export const runTestFileInput = toolSchema({
  path: z.string().describe('Absolute path of the .md test file to run.'),
  session_id: sessionId,
  project_root: projectRoot,
  env_name: envName,
  parameters,
  config: toolConfig,
  allow_foreign_session: allowForeignSession,
  include_screenshot: includeScreenshot,
});

export const listTestFilesInput = toolSchema({ project_root: projectRoot });
export const listSessionsInput = toolSchema({ project_root: projectRoot });
export const serverStatusInput = toolSchema({ project_root: projectRoot });

export const closeSessionInput = toolSchema({
  session_id: z.string().describe('Session to close. Closing an unknown session succeeds.'),
  project_root: projectRoot,
  allow_foreign_session: allowForeignSession,
});

export const getLastRunInput = toolSchema({
  session_id: z.string().describe('Session whose last finished run to report on.'),
  project_root: projectRoot,
});

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

export const runResultOutput = toolSchema({
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
});

export const listTestFilesOutput = toolSchema({
  // Wrapped rather than a bare array: `structuredContent` must be a JSON
  // object.
  files: z.array(z.string()),
  projectRoot: z.string(),
});

export const listSessionsOutput = toolSchema({
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
});

export const closeSessionOutput = toolSchema({
  sessionId: z.string(),
  closed: z.boolean(),
});

export const getLastRunOutput = toolSchema({
  finalized: z.boolean(),
  reportPath: z.string().nullable(),
  tokens: tokens.nullable(),
});

export const serverStatusOutput = toolSchema({
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
});

// The `*Output` schemas above are also the `safeParse` handles the handlers use
// on their own results before returning them. The SDK would validate them
// itself, but its failure path turns a mismatch into `isError:true` with no
// structured content — so `validated()` in `tools.ts` checks first and degrades
// to something still usable.

export type RunResult = z.infer<typeof runResultOutput>;
