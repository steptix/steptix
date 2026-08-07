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

const cdpTarget = z
  .object({
    profile: z
      .string()
      .optional()
      .describe(
        'Profile name of a CDP browser for this project, e.g. "default". ' +
          '**Prefer this over `port`** — a profile is the same browser and the ' +
          'same logins tomorrow, while a port is reassigned on every launch. ' +
          'The browser must already be running; start it with ' +
          'start_cdp_browser first.',
      ),
    engine: z
      .enum(['chrome', 'edge'])
      .optional()
      .describe(
        'Disambiguates `profile` when Chrome and Edge are both running the ' +
          'same profile name. Only meaningful alongside `profile`.',
      ),
    port: z
      .number()
      .int()
      .optional()
      .describe(
        'Port of a CDP browser from list_cdp_browsers `running`, or from ' +
          'start_cdp_browser. Ports are assigned by the browser and change on ' +
          'every launch, so read one rather than assuming 9222. Pass this OR ' +
          '`profile`, not both.',
      ),
    tab: z
      .string()
      .optional()
      .describe(
        'Which tab to drive: `new` (default, and the safe choice), ' +
          '`targetId:<id>`, an integer index, `url~<substring>`, ' +
          '`title~<substring>`, or `active`. Prefer `targetId:` — it is the ' +
          'only identifier that stays stable as tabs open and close, and ' +
          'list_cdp_browsers hands them out.',
      ),
  })
  .optional()
  .describe(
    'Attach to an already-running CDP browser instead of launching a fresh ' +
      'one. Give exactly one of `profile` (preferred) or `port`. Only ' +
      'browsers this project started are permitted; anything else is refused ' +
      'unless a human sets mcp.cdp.allowUnowned in aiui.config.json.',
  );

const toolConfig = z
  .object({
    baseUrl: z.string().optional(),
    timeout: z.string().optional(),
    cdp: cdpTarget,
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

export const getPageContentInput = toolSchema({
  session_id: z.string().describe('Session whose current page to read.'),
  project_root: projectRoot,
  format: z
    .enum(['text', 'dom'])
    .optional()
    .describe(
      '`text` (default) — the page\'s visible text, for what it says. `dom` — ' +
        'the cleaned DOM, for picking a selector to act on. `text` is far ' +
        'smaller; reach for `dom` only when you need element structure.',
    ),
  selector: z
    .string()
    .min(1)
    .optional()
    .describe(
      'CSS selector to read instead of the whole page. **This is the right ' +
        'way to handle a truncated result** — narrowing beats raising ' +
        'max_chars. A selector matching nothing is an error, not empty text.',
    ),
  max_chars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Cap on returned characters (default 20000). Over-limit content comes ' +
        'back truncated and flagged, never silently clipped.',
    ),
  allow_foreign_session: allowForeignSession,
});

export const getPageContentOutput = toolSchema({
  sessionId: z.string(),
  url: z.string(),
  title: z.string(),
  status: z.enum(['active', 'executing']),
  format: z.enum(['text', 'dom']),
  selector: z.string().nullable(),
  content: z.string(),
  truncated: z
    .boolean()
    .describe(
      'True when you did NOT receive the whole page — either it exceeded ' +
        'max_chars, or the capture itself hit the project\'s DOM size limit. ' +
        'Narrow with `selector` to see the rest.',
    ),
  returnedChars: z.number(),
  availableChars: z
    .number()
    .describe(
      'Characters captured before truncation. A FLOOR, not the page\'s true ' +
        'size: for format "dom" the capture is itself capped by the project\'s ' +
        'limit, so a large page reports the cap rather than its real length. ' +
        'Trust `truncated`, not the difference between these two numbers.',
    ),
});

// ---------------------------------------------------------------------------
// CDP browsers
//
// Both names carry `cdp` deliberately. The framework has two kinds of browser
// — persistent CDP ones and per-session launch-mode ones — and a bare
// `start_browser`/`list_browsers` would claim authority over both while
// handling only the first. The prefix is wordier than a reader who knows the
// distinction needs, and exactly right for a model that does not.
// ---------------------------------------------------------------------------

export const listCdpBrowsersInput = toolSchema({ project_root: projectRoot });

export const startCdpBrowserInput = toolSchema({
  // No `port` argument: the caller cannot choose a port (the browser assigns
  // its own), a browser we own is found by reuse, and one we do not own is
  // reached via list_cdp_browsers rather than by launching.
  //
  // No `reuse` argument either: reuse is what `profile` selects. The same name
  // returns the running browser, a new name starts a new one.
  engine: z.enum(['chrome', 'edge']).describe('Which browser to launch.'),
  profile: z
    .string()
    .optional()
    .describe(
      'Named profile, default "default". **This is how you choose between ' +
        'browsers.** The same name returns the same browser and its saved ' +
        'logins; a new name starts a genuinely separate browser with its own ' +
        'window, port and cookies. Use names for the cases one profile cannot ' +
        'express: admin vs regular user, uat vs prod, or a deliberately ' +
        'signed-out profile for testing a sign-in flow. Letters, digits, dot, ' +
        'underscore and hyphen only.',
    ),
  reset: z
    .boolean()
    .optional()
    .describe(
      'Delete the profile before launching, so it starts genuinely signed ' +
        'out. **Destructive and not undoable** — every saved login in that ' +
        'profile is gone. This is the only way to test a sign-in flow twice, ' +
        'because a profile that has signed in once stays signed in. Refused ' +
        'while a browser is running on the profile.',
    ),
  project_root: projectRoot,
});

const cdpTab = z.object({
  targetId: z.string(),
  title: z.string(),
  url: z.string(),
});

/** A tab of a browser we own, which is the only case where we can say whether
 *  a session is driving it. Foreign tabs keep the plain shape — we have no
 *  sessions on a browser we did not start. */
const ownedCdpTab = cdpTab.extend({
  sessionId: z
    .string()
    .nullable()
    .describe(
      'The session currently driving this tab, or null. A tab with a session ' +
        'on it cannot be closed until that session is closed.',
    ),
});

export const closeCdpTabInput = toolSchema({
  target_id: z
    .string()
    .describe(
      'Exact targetId of the tab to close, from list_cdp_browsers. There is ' +
        'no fuzzy matching — match the user\'s words against the tab titles ' +
        'and urls yourself, then pass the id of the one you picked.',
    ),
  profile: z
    .string()
    .optional()
    .describe(
      'Profile name of the browser holding the tab, e.g. "default". Prefer ' +
        'this over `port`. Give exactly one of `profile` or `port`.',
    ),
  engine: z
    .enum(['chrome', 'edge'])
    .optional()
    .describe(
      'Disambiguates `profile` when Chrome and Edge are both running the ' +
        'same profile name. Only meaningful alongside `profile`.',
    ),
  port: z
    .number()
    .int()
    .optional()
    .describe('Port of the browser holding the tab. Pass this OR `profile`, not both.'),
  allow_browser_exit: z
    .boolean()
    .optional()
    .describe(
      'Permission to close the browser\'s **last** tab, which closes the ' +
        'browser itself — there is no browser with zero tabs. Without this, ' +
        'closing the last tab is refused. Nothing is lost either way: the ' +
        'profile keeps its logins on disk and start_cdp_browser brings the ' +
        'browser back still signed in.',
    ),
  project_root: projectRoot,
});

export const closeCdpTabOutput = toolSchema({
  closed: z.boolean().describe('True only once the tab has actually gone, never merely accepted.'),
  targetId: z.string(),
  title: z.string(),
  url: z.string(),
  engine: z.string(),
  profile: z.string(),
  port: z.number(),
  remainingTabs: z.number().describe('Page tabs left in the browser, counted after the close.'),
  browserExited: z
    .boolean()
    .describe(
      'The browser itself closed, because this was its last tab. The profile ' +
        'is now dormant and appears under `available`.',
    ),
  warnings: z.array(z.string()),
});

export const listCdpBrowsersOutput = toolSchema({
  running: z.array(
    z.object({
      engine: z.string(),
      profile: z.string(),
      port: z.number(),
      profileDir: z.string(),
      tabs: z.array(ownedCdpTab),
    }),
  ),
  available: z.array(
    z.object({ engine: z.string(), profile: z.string(), profileDir: z.string() }),
  ),
  foreign: z.array(
    z.object({
      engine: z.string(),
      port: z.number(),
      tabs: z.array(cdpTab).nullable(),
      tabsWithheld: z.boolean(),
      error: z.string().nullable(),
    }),
  ),
});

export const startCdpBrowserOutput = toolSchema({
  engine: z.string(),
  profile: z.string(),
  port: z.number(),
  profileDir: z.string(),
  binary: z.string(),
  tabs: z.array(cdpTab),
  outcome: z.enum([
    'reused_running_browser',
    'launched_into_existing_profile',
    'launched_into_new_profile',
    'launched_after_reset',
  ]),
  warnings: z.array(z.string()),
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
  // Which tab the step actually drove. `.nullable()` and not optional: a
  // missing required key is fatal to `validateToolOutput`, where a null is
  // simply "the server did not report one".
  tab: z
    .object({
      label: z.string(),
      targetId: z.string().nullable(),
      url: z.string(),
      title: z.string(),
      unexpected: z.boolean(),
    })
    .nullable(),
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
      // Which CDP browser this session is driving, or null for an ordinary
      // disposable one. `profile` is resolved by the server from its registry
      // at list time — it never travelled on the wire — so it is null when
      // that browser has since gone.
      cdp: z
        .object({ port: z.number(), profile: z.string().nullable() })
        .nullable(),
      // Which tab this session is on — the other half of the join
      // `list_cdp_browsers` reports per tab. Answers "which session is driving
      // my cart tab?" without replaying a previous run's step results.
      tab: z
        .object({ targetId: z.string().nullable(), url: z.string() })
        .nullable(),
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
