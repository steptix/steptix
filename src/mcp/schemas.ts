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
      '**Omit this unless you have a real project path — do NOT pass a guess ' +
      'like the current working directory or a home folder.** A path outside ' +
      'the allowed roots is refused outright, and you rarely need it: it is ' +
      'optional when the server was started inside the project, or when ' +
      'AIUI_MCP_ROOTS names exactly one directory. With no project anywhere, ' +
      'most tools fall back to the machine-wide user root and say so via ' +
      'scope: "user" in their results — for your own machine-wide browsers, ' +
      'omit project_root entirely and use scope: "user" instead.',
  );

/** The two roots a browser or run can belong to (stories/mcp-no-project.md). */
const rootScope = z.enum(['project', 'user']);

const cdpScopeArg = rootScope
  .optional()
  .describe(
    'Which root the profile name refers to: "project" — this project\'s browser; ' +
      '"user" — the machine-wide one, reachable from any directory. Needed only ' +
      'when the same profile name exists in both and nothing else settles it — ' +
      'an agreeing `port` beside `profile` also settles the tie. With both ' +
      '`profile` and `scope` given, `port` must agree with THAT browser. ' +
      'Ignored when addressing by `port` alone.',
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
    scope: cdpScopeArg,
    port: z
      .number()
      .int()
      .optional()
      .describe(
        'Port of a CDP browser from list_cdp_browsers `running`, or from ' +
          'start_cdp_browser. Ports are assigned by the browser and change on ' +
          'every launch, so read one rather than assuming 9222. Prefer ' +
          '`profile`; giving both is accepted only when they name the same ' +
          'browser (one list_cdp_browsers row) — a pair that disagrees is ' +
          'refused.',
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
      'one. Address it by `profile` (preferred) or `port`; both together ' +
      'must name the same browser. Only browsers this project started are ' +
      'permitted; anything else is refused unless a human sets ' +
      'mcp.cdp.allowUnowned in aiui.config.json.',
  );

const toolConfig = z
  .object({
    baseUrl: z.string().optional(),
    timeout: z.string().optional(),
    viewport: z
      .string()
      .optional()
      .describe(
        'Render the pages at exactly this size, headed or headless: a preset ' +
          '(`mobile` 390x844, `tablet` 768x1024, `desktop` 1440x900) or ' +
          '`<width>x<height>` such as `390x844`. Use it to see a site\'s ' +
          'breakpoint layout without editing the test. CSS breakpoints only — ' +
          'no touch events, no mobile user agent. Cannot be combined with ' +
          '`cdp`: the attached browser is the user\'s own and cannot be resized.',
      ),
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

// ---------------------------------------------------------------------------
// Run settings (stories/run-settings.md §1, §4)
//
// Five flat arguments rather than one nested object: these are the words a model
// has to get right at the moment of the call, and a nested `run_settings: {...}`
// buys nothing but a level of indirection to mis-key.
//
// `capture` and `return` are deliberately separate settings. Capturing every
// step into the HTML report is cheap; returning every step's screenshot into the
// conversation is 30 PNGs on a 30-step run. Conflating them would make
// "screenshot every step" quietly mean "fill my context with images".
// ---------------------------------------------------------------------------

const settingsNote =
  'Sticks to this session until changed — you do not need to re-send it on the ' +
  'next call. Pass "default" to stop overriding and go back to the project config.';

const model = z
  .string()
  .min(1)
  .nullable()
  .optional()
  .describe(
    'Model for this run onward, e.g. "aibroker/google/gemini-3-flash". Takes ' +
      'effect on the very next run with no browser restart — same page, same ' +
      'captured variables. Passed through as given; the gateway decides what ' +
      'exists. null clears the override and goes back to the project/server ' +
      'model. Note that the step cache does NOT key on the model, so with caching ' +
      'on a switched model can be served the previous one\'s cached plans — turn ' +
      'the cache off if you are comparing models.',
  );

const capture = z
  .enum(['every-step', 'on-failure', 'none', 'default'])
  .optional()
  .describe(
    'What gets photographed into the HTML report. `every-step` — a screenshot ' +
      'per step, which is what you want while debugging. `on-failure` — only ' +
      'the step that broke. `none` — nothing. This is cheap: the images go to ' +
      'the report on disk, not into this conversation. **Read this before ' +
      'setting screenshots_return**: you cannot be handed a picture nobody took, ' +
      `so \`return: "final"\` needs \`capture: "every-step"\`. ${settingsNote}`,
  );

const fullPage = z
  .boolean()
  .nullable()
  .optional()
  .describe(
    'Capture the whole scrollable page instead of just the viewport. Makes ' +
      'every screenshot much larger — a long page can exceed the size cap for ' +
      `returning one to you, which drops the image and keeps the run. ${settingsNote}`,
  );

const sendScreenshots = z
  .boolean()
  .nullable()
  .optional()
  .describe(
    'Whether the model driving the steps sees a screenshot on each of its ' +
      'turns. **This is the main cost lever on a run** — leaving it off is much ' +
      'cheaper, and most steps do not need it. Turning it ON also forces a ' +
      'capture per turn regardless of `capture`, because the model\'s request ' +
      `needs the image. ${settingsNote}`,
  );

const aiMode = z
  .enum(['on', 'off', 'default'])
  .optional()
  .describe(
    'Whether this run may use AI at all. `off` makes the run behave exactly ' +
      'like a keyless one no matter which keys are configured: compiled steps ' +
      'replay, and anything needing a model — an uncompiled step, mid-run ' +
      'healing of a broken entry — is skipped or refused with a typed error ' +
      'naming the policy. Use it to guarantee a run spends nothing, and to get ' +
      '"this run made zero AI calls, by policy" on the result. Compiling and ' +
      `repairing a step are NOT gated by it — those are requests for AI. ${settingsNote}`,
  );

const screenshotsReturn = z
  .enum(['none', 'on-failure', 'final', 'default'])
  .optional()
  .describe(
    'Which screenshot comes back to YOU as an image. `on-failure` is the ' +
      'DEFAULT (and what `default` means): if a step fails you get a picture of ' +
      'the page as it broke, and nothing at all on a passing run. `none` — no ' +
      'image ever; pass this when you are running a suite and only need the ' +
      'verdict, or when the page holds something you would rather not put in ' +
      'this conversation. `final` — the page as the run left it, pass or fail, ' +
      'which needs `capture: "every-step"` on a passing run. There is ' +
      'deliberately no every-step option. Bear in mind an image costs real ' +
      'context and is a photograph of a live signed-in session. Per call — ' +
      'unlike the settings above, this one is not retained.',
  );

export const runStepsInput = toolSchema({
  steps: z
    .array(z.string())
    .min(1)
    .describe(
      'Natural-language steps, one per entry. Supports the same syntax as a ' +
        'test file: `[skill: name]` (`sub/name` for a skill in a subfolder), ' +
        '`[tool: name]`, `[input: ...]`, section calls, and ${env.X} ' +
        'substitution.',
    ),
  session_id: sessionId,
  project_root: projectRoot,
  env_name: envName,
  parameters,
  config: toolConfig,
  allow_foreign_session: allowForeignSession,
  model,
  capture,
  full_page: fullPage,
  send_screenshots: sendScreenshots,
  ai: aiMode,
  screenshots_return: screenshotsReturn,
});

export const runTestFileInput = toolSchema({
  path: z.string().describe('Absolute path of the .md test file to run.'),
  session_id: sessionId,
  project_root: projectRoot,
  env_name: envName,
  parameters,
  config: toolConfig,
  allow_foreign_session: allowForeignSession,
  model,
  capture,
  full_page: fullPage,
  send_screenshots: sendScreenshots,
  ai: aiMode,
  screenshots_return: screenshotsReturn,
});

// ---------------------------------------------------------------------------
// Errands (stories/errands.md §Tool surface)
//
// Deliberately absent, and each absence is a decision: `config` (an errand
// inherits the project's baseUrl/timeout), report-path plumbing (the receipt IS
// the report — no file is written), `parameters` (steps are literal; the caller
// inlines values), and the five run-settings overrides `run_steps` carries (an
// errand has no session to hold an override, so the project/server chain
// decides).
// ---------------------------------------------------------------------------

export const runErrandInput = toolSchema({
  tab: z
    .string()
    .min(1)
    .describe(
      'Which open tab to borrow. `targetId:<id>` from list_cdp_browsers is the ' +
        'exact form and the one to prefer. Otherwise `title~<substring>`, ' +
        '`url~<substring>`, or a bare string — matched case-insensitively as a ' +
        'substring of the tab\'s title AND of its url. Plain substrings only: no ' +
        'globs, no regex. Matching a tab that does not exist, or several tabs, is ' +
        'refused with the candidates named — so a rough name is safe to try. ' +
        'There is no `new`: an errand borrows a tab that is already open.',
    ),
  profile: z
    .string()
    .optional()
    .describe(
      'Profile name of the CDP browser holding the tab. Defaults to "default", ' +
        'which is the one start_cdp_browser makes unless told otherwise. Call ' +
        'list_cdp_browsers if unsure which exist.',
    ),
  engine: z
    .enum(['chrome', 'edge'])
    .optional()
    .describe(
      'Disambiguates `profile` when Chrome and Edge are both running the ' +
        'same profile name. Only meaningful alongside `profile`.',
    ),
  scope: cdpScopeArg,
  project_root: projectRoot,
  env_name: envName,
  steps: z
    .array(z.string())
    .min(1)
    .describe(
      'Natural-language steps, one per entry — the same step language as ' +
        'run_steps, and `store as` captures come back in the receipt. ' +
        '`[skill: ...]` and `[tool: ...]` are refused: an errand carries no ' +
        'project skills or tools directory, so those need run_steps.',
    ),
  keep_open: z
    .boolean()
    .optional()
    .describe(
      'Leave behind any tabs the errand itself opened (default false — an ' +
        'errand takes its coat when it leaves). Never affects the borrowed tab, ' +
        'which is never closed either way, and never spares a whole browser a ' +
        'step opened.',
    ),
  session_id: z
    .string()
    .optional()
    .describe(
      'DO NOT PASS THIS — errands have no sessions, and a call carrying it is ' +
        'refused before anything touches the browser. It is declared only so ' +
        'this can be said: if you want state that persists across calls, that is ' +
        'run_steps with a session_id. An errand is one request that keeps ' +
        'nothing.',
    ),
});

// ---------------------------------------------------------------------------
// Tab peek (stories/tab-peek.md §Tool surface)
//
// Deliberately absent, each one a decision: `steps` (a peek cannot act —
// wanting both means run_errand, whose steps can capture), `keep_open`
// (nothing opens), `format: "screenshot"` (an open question, not a rider on
// v1), `port` (which is what makes the foreign-browser gate unreachable by
// construction), and any config bundle.
// ---------------------------------------------------------------------------

export const peekTabInput = toolSchema({
  tab: z
    .string()
    .min(1)
    .describe(
      'Which open tab to read. `targetId:<id>` from list_cdp_browsers is the ' +
        'exact form and the one to prefer. Otherwise `title~<substring>`, ' +
        '`url~<substring>`, or a bare string — matched case-insensitively as a ' +
        'substring of the tab\'s title AND of its url. Plain substrings only: no ' +
        'globs, no regex. Matching a tab that does not exist, or several tabs, is ' +
        'refused with the candidates named — so a rough name is safe to try.',
    ),
  format: z
    .enum(['text', 'dom', 'screenshot'])
    .optional()
    .describe(
      '`text` (default) — the page\'s visible text, for what it says. `dom` — ' +
        'the cleaned DOM, for picking a selector to act on. `text` is far ' +
        'smaller; reach for `dom` only when you need element structure. ' +
        '`screenshot` — a PNG of the tab, for when the ask is to SEE the page ' +
        '("show me", "what does it look like", "take a screenshot"). The picture ' +
        'is taken where the tab sits: it is never brought forward, and works ' +
        'with the window minimised. It costs real context and photographs a ' +
        'live signed-in browser, so ask for it when seeing is the point, not as ' +
        'a default.',
    ),
  full_page: z
    .boolean()
    .optional()
    .describe(
      'Screenshot only: capture the whole scrollable page instead of just the ' +
        'visible viewport (default). Much larger — a long page can exceed the ' +
        'size cap for returning an image, which is an error rather than a ' +
        'silent drop, so reach for it when what you need is below the fold.',
    ),
  selector: z
    .string()
    .min(1)
    .optional()
    .describe(
      'CSS selector to read instead of the whole page. **This is the right ' +
        'way to handle a truncated result** — narrowing beats raising ' +
        'max_chars. A selector matching nothing is an error, not empty text. ' +
        'Does not apply to `format: "screenshot"` and is refused alongside it, ' +
        'rather than ignored — a picture is of the whole viewport or the whole ' +
        'page, never of one element.',
    ),
  max_chars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Cap on returned characters (default 20000). Over-limit content comes ' +
        'back truncated and flagged, never silently clipped. Does not apply to ' +
        '`format: "screenshot"` — an image is bounded by the size cap, not by ' +
        'characters — and is refused alongside it rather than ignored.',
    ),
  profile: z
    .string()
    .optional()
    .describe(
      'Profile name of the CDP browser holding the tab. Defaults to "default", ' +
        'which is the one start_cdp_browser makes unless told otherwise. Call ' +
        'list_cdp_browsers if unsure which exist.',
    ),
  engine: z
    .enum(['chrome', 'edge'])
    .optional()
    .describe(
      'Disambiguates `profile` when Chrome and Edge are both running the ' +
        'same profile name. Only meaningful alongside `profile`.',
    ),
  scope: cdpScopeArg,
  project_root: projectRoot,
  session_id: z
    .string()
    .optional()
    .describe(
      'DO NOT PASS THIS — a peek reads a tab, not a session, and a call carrying ' +
        'it is refused before anything touches the browser. It is declared only ' +
        'so this can be said: to read the page a run_steps session is sitting on, ' +
        'that is get_page_content with the session_id.',
    ),
});

/**
 * A FRESH declaration, not `getPageContentOutput.omit(...).extend(...)`.
 *
 * Two reasons, both measured rather than stylistic. Derivation loses the
 * `.meta({$schema: undefined})` suppression `toolSchema` applies — the emitted
 * body would regain a draft-07 `$schema`, `mcp-schema-dialect.test.ts` would
 * fail, and the opencode client would reject every result. And it would drag
 * in field descriptions written for a tool that answers about a SESSION —
 * `sessionId`, `status` — on a tool that addresses a tab.
 *
 * Both reasons survive stories/cdp-tab-screenshot.md giving the peek its own
 * `"screenshot"` format: the two tools now answer the same three formats and
 * still describe them differently, because their size stories differ. A
 * session's over-cap image is one disappointing outcome of a run that still
 * happened; a peek's is the whole of the answer.
 */
export const peekTabOutput = toolSchema({
  targetId: z.string().describe('The tab that was read, exactly as list_cdp_browsers reports it.'),
  url: z.string(),
  title: z.string(),
  format: z.enum(['text', 'dom', 'screenshot']),
  selector: z.string().nullable(),
  content: z
    .string()
    .describe(
      'The page text or DOM, as it was at the moment of the read. An empty ' +
        'value never means "the read failed": that is an error instead. Empty ' +
        'for `format: "screenshot"`, where the payload is the image block — ' +
        '`format` tells you which half of this result to read.',
    ),
  truncated: z
    .boolean()
    .describe(
      'True when you did NOT receive the whole page — either it exceeded ' +
        'max_chars, or the capture itself hit the project\'s DOM size limit. ' +
        'Narrow with `selector` to see the rest. Always false for a ' +
        'screenshot: an image that did not fit is an error, never a partial ' +
        'picture.',
    ),
  width: z
    .number()
    .nullable()
    .describe('Screenshot only: captured pixel width. Null for text and DOM reads.'),
  height: z
    .number()
    .nullable()
    .describe(
      'Screenshot only: captured pixel height — well beyond the viewport when ' +
        '`full_page` was set. Null for text and DOM reads.',
    ),
  returnedChars: z
    .number()
    .describe('Characters returned. For a screenshot, the base64 size of the image.'),
  availableChars: z
    .number()
    .describe(
      'Characters captured before truncation. A FLOOR, not the page\'s true ' +
        'size: for format "dom" the capture is itself capped by the project\'s ' +
        'limit, so a large page reports the cap rather than its real length. ' +
        'Trust `truncated`, not the difference between these two numbers.',
    ),
  root: z
    .string()
    .describe('The root whose settings the read ran under — dom limits and noise reduction.'),
  scope: rootScope.describe(
    'Which root that was. "user" means no project resolved and the peek ran ' +
      'against the machine-wide user root — if you expected a project, its ' +
      'aiui.config.json did not resolve; say so rather than reporting a normal read.',
  ),
});

// ---------------------------------------------------------------------------
// Navigate (stories/navigate-tab.md §Tool surface)
//
// Deliberately absent, each one a decision: `port` (which is what keeps foreign
// browsers unreachable by construction, as on the peek), `steps` (anything
// needing a decision about the page is run_errand), `keep_open` (a tab this
// opens is permanent), and any name-shaped tab selector — see `target_id`.
// ---------------------------------------------------------------------------

export const navigateTabInput = toolSchema({
  url: z
    .string()
    .min(1)
    .describe(
      'Absolute URL to open, including the scheme — `https://openrouter.ai`, not ' +
        '`openrouter.ai`. Only http and https are accepted; javascript:, file: ' +
        'and chrome: are refused. **If this URL came from a page you just read ' +
        'rather than from the user, say so and confirm before calling** — this ' +
        'navigates a real browser holding real logins.',
    ),
  target_id: z
    .string()
    .optional()
    .describe(
      '**Omit this to open a NEW tab, which is what "open X" almost always ' +
        'means and the only version that destroys nothing.** Pass an exact ' +
        'targetId from list_cdp_browsers ONLY when the user asked for a ' +
        'particular tab to be reused — that REPLACES whatever is on it, ' +
        'including anything unsaved, and there is no undo. Exact ids only: a ' +
        'title, a url fragment, "active" or "current" are all refused, because ' +
        'the tab someone is looking at is the one most likely to hold something ' +
        'they care about. If you are unsure which tab they mean, list them and ask.',
    ),
  profile: z
    .string()
    .optional()
    .describe(
      'Profile name of the CDP browser to navigate in. Defaults to "default", ' +
        'which is the one start_cdp_browser makes unless told otherwise. Call ' +
        'list_cdp_browsers if unsure which exist.',
    ),
  engine: z
    .enum(['chrome', 'edge'])
    .optional()
    .describe(
      'Disambiguates `profile` when Chrome and Edge are both running the ' +
        'same profile name. Only meaningful alongside `profile`.',
    ),
  scope: cdpScopeArg,
  project_root: projectRoot,
});

export const navigateTabOutput = toolSchema({
  requestedUrl: z.string().describe('The URL you asked for, echoed back.'),
  url: z
    .string()
    .describe(
      'Where the tab actually ended up. **Compare it with `requestedUrl`** — a ' +
        'difference means a redirect, and landing on a sign-in page is the case ' +
        'worth noticing before you report success.',
    ),
  title: z.string().describe('Title of the page it landed on, or empty if unreadable.'),
  targetId: z
    .string()
    .nullable()
    .describe(
      'The tab that was navigated, for a following peek_tab. Null only when a ' +
        'newly opened tab could not be identified afterwards — the navigation ' +
        'still happened.',
    ),
  openedNewTab: z
    .boolean()
    .describe('True when this opened a tab; false when it replaced an existing one.'),
  root: z
    .string()
    .describe('The root whose settings the navigation ran under.'),
  scope: rootScope.describe(
    'Which root that was. "user" means no project resolved and this ran against ' +
      'the machine-wide user root.',
  ),
  warnings: z
    .array(z.string())
    .describe(
      'Empty on an ordinary navigation. Carries the notices that a SUCCESSFUL ' +
        'call still needs to make: the page had not finished loading, or it ' +
        'moved again while its address was being read.',
    ),
});

export const getRunSettingsInput = toolSchema({
  project_root: projectRoot,
  session_id: z
    .string()
    .optional()
    .describe(
      'Report this session\'s retained settings as well as the server-wide ' +
        'defaults. Omit for the defaults alone. An unknown session is an error, ' +
        'not a silent fall back to the defaults.',
    ),
});

const settingSource = z
  .enum(['server', 'project', 'session'])
  .describe(
    '`server` — the server\'s startup config. `project` — this project\'s ' +
      'aiui.config.json or .env. `session` — set on this session by a tool call.',
  );

export const getRunSettingsOutput = toolSchema({
  baseUrl: z.string(),
  running: z
    .boolean()
    .describe(
      'Whether a usable server answered. False means nothing was reachable — ' +
        'this tool never starts one to find out, so the settings fields are null ' +
        'rather than guessed.',
    ),
  detail: z.string().nullable().describe('Why `running` is false.'),
  projectRoot: z.string(),
  scope: z
    .enum(['project', 'user'])
    .describe('Which root resolved: a project, or the machine-wide user root.'),
  sessionId: z.string().nullable(),
  // What the next run on this session would use — the session's values when one
  // was named, the server defaults otherwise.
  model: z.string().nullable(),
  capture: z.enum(['every-step', 'on-failure', 'none', 'custom']).nullable(),
  fullPage: z.boolean().nullable(),
  sendScreenshots: z.boolean().nullable(),
  ai: z
    .enum(['on', 'off'])
    .nullable()
    .describe('Whether the next run on this session could use AI at all.'),
  aiOffReason: z
    .enum(['policy', 'no-key'])
    .nullable()
    .describe(
      'Why ai is "off": "policy" (a run that was asked to make no AI calls) ' +
        'or "no-key" (nothing configured on this machine). Null when ai is ' +
        'on. Policy is reported first when both hold, so "policy" says ' +
        'nothing either way about whether a key exists.',
    ),
  sources: z
    .object({
      model: settingSource,
      capture: settingSource,
      fullPage: settingSource,
      sendScreenshots: settingSource,
      ai: settingSource.nullable(),
    })
    .nullable(),
  overrides: z
    .object({
      model: z.string().nullable(),
      capture: z.enum(['every-step', 'on-failure', 'none']).nullable(),
      fullPage: z.boolean().nullable(),
      sendScreenshots: z.boolean().nullable(),
      ai: z.enum(['on', 'off']).nullable(),
    })
    .nullable()
    .describe(
      'Just the values set on this session, with null for anything not ' +
        'overridden. Null as a whole when no session was named.',
    ),
  serverDefaults: z
    .object({
      model: z.string(),
      capture: z.enum(['every-step', 'on-failure', 'none', 'custom']),
      fullPage: z.boolean(),
      sendScreenshots: z.boolean(),
      // Nullable where its neighbours are not, for the reason `sources.ai` is:
      // a server predating the AI switch reports the rest and omits this.
      ai: z.enum(['on', 'off']).nullable(),
    })
    .nullable()
    .describe('What a run with no project config and no overrides would use.'),
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
    .enum(['text', 'dom', 'screenshot'])
    .optional()
    .describe(
      '`text` (default) — the page\'s visible text, for what it says. `dom` — ' +
        'the cleaned DOM, for picking a selector to act on. `text` is far ' +
        'smaller; reach for `dom` only when you need element structure. ' +
        '`screenshot` — a PNG of the viewport right now, returned as an image; ' +
        'use it when the question is about layout or what something looks like, ' +
        'and remember it costs far more context than text.',
    ),
  selector: z
    .string()
    .min(1)
    .optional()
    .describe(
      'CSS selector to read instead of the whole page. **This is the right ' +
        'way to handle a truncated result** — narrowing beats raising ' +
        'max_chars. A selector matching nothing is an error, not empty text. ' +
        'Not available with `format: "screenshot"`, which always photographs ' +
        'the whole viewport.',
    ),
  max_chars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Cap on returned characters (default 20000). Over-limit content comes ' +
        'back truncated and flagged, never silently clipped. Does not apply to ' +
        '`format: "screenshot"`, which has its own size cap.',
    ),
  allow_foreign_session: allowForeignSession,
});

export const getPageContentOutput = toolSchema({
  sessionId: z.string(),
  url: z.string(),
  title: z.string(),
  status: z.enum(['active', 'executing']),
  format: z.enum(['text', 'dom', 'screenshot']),
  selector: z.string().nullable(),
  content: z
    .string()
    .describe(
      'The page text or DOM. EMPTY for `format: "screenshot"` — the picture is ' +
        'in the image block alongside this, not in here. An empty value never ' +
        'means "the read failed": that is an error instead.',
    ),
  truncated: z
    .boolean()
    .describe(
      'True when you did NOT receive the whole page — either it exceeded ' +
        'max_chars, or the capture itself hit the project\'s DOM size limit. ' +
        'Narrow with `selector` to see the rest.',
    ),
  returnedChars: z
    .number()
    .describe(
      'Characters returned. For `format: "screenshot"` this is the size of the ' +
        'base64 image, which is what the read actually cost you.',
    ),
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
  scope: rootScope
    .optional()
    .describe(
      'Where the browser lives. "project" (the default inside a project) — ' +
        'under this project, addressable only here. "user" — under the ' +
        'machine-wide user root, reachable from any directory forever; this ' +
        'is the default (and only option) when no project resolved. **For the ' +
        'user\'s own signed-in browser — the one with their real logins — pass ' +
        'scope: "user" and no project_root.** That reaches it from anywhere, ' +
        'in a project or not, with no path to guess. Requests like "open my ' +
        'Chrome / my personal browser" mean scope: "user".',
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
    // An empty id would otherwise reach the wire as `/tabs/?projectRoot=…`,
    // which matches no route and comes back as an unrelated error.
    .min(1)
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
        'this over `port`.',
    ),
  engine: z
    .enum(['chrome', 'edge'])
    .optional()
    .describe(
      'Disambiguates `profile` when Chrome and Edge are both running the ' +
        'same profile name. Only meaningful alongside `profile`.',
    ),
  scope: cdpScopeArg,
  port: z
    .number()
    .int()
    .optional()
    .describe(
      'Port of the browser holding the tab. Prefer `profile`; giving both is ' +
        'accepted only when they name the same browser (one list_cdp_browsers ' +
        'row) — a pair that disagrees is refused.',
    ),
  allow_browser_exit: z
    .boolean()
    .optional()
    .describe(
      'Permission to close the browser\'s **last** tab, which closes the ' +
        'browser itself — there is no browser with zero tabs. Without this, ' +
        'closing the last tab is refused. For a browser this project started ' +
        'nothing is lost: the profile keeps its logins on disk and ' +
        'start_cdp_browser brings it back still signed in. For a browser it ' +
        'did not start, nothing here can reopen it — ask the user before ' +
        'setting this.',
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
      'The browser itself closed, because this was its last tab. If `owned`, ' +
        'the profile is now dormant and appears under `available`.',
    ),
  owned: z
    .boolean()
    .describe(
      'Whether a root this call can see launched the browser. When false ' +
        '(only reachable with mcp.cdp.allowUnowned) nothing here can reopen ' +
        'it — say so rather than reassuring the user that the profile can be ' +
        'relaunched.',
    ),
  scope: rootScope
    .nullable()
    .describe(
      'Which root owned the browser — "project" or "user" (machine-wide). ' +
        'Null for a foreign browser, or when an older server did not say.',
    ),
  warnings: z.array(z.string()),
});

export const focusCdpTabInput = toolSchema({
  target_id: z
    .string()
    // Same reason as `close_cdp_tab`'s: an empty id would reach the wire as
    // `/tabs//focus`, which matches no route and comes back as an unrelated
    // error.
    .min(1)
    .describe(
      'Exact targetId of the tab to bring to the front, from ' +
        'list_cdp_browsers. There is no fuzzy matching — match the user\'s ' +
        'words against the tab titles and urls yourself, then pass the id of ' +
        'the one you picked.',
    ),
  profile: z
    .string()
    .optional()
    .describe(
      'Profile name of the browser holding the tab, e.g. "default". Prefer ' +
        'this over `port`.',
    ),
  engine: z
    .enum(['chrome', 'edge'])
    .optional()
    .describe(
      'Disambiguates `profile` when Chrome and Edge are both running the ' +
        'same profile name. Only meaningful alongside `profile`.',
    ),
  scope: cdpScopeArg,
  port: z
    .number()
    .int()
    .optional()
    .describe(
      'Port of the browser holding the tab. Prefer `profile`; giving both is ' +
        'accepted only when they name the same browser (one list_cdp_browsers ' +
        'row) — a pair that disagrees is refused.',
    ),
  project_root: projectRoot,
});

export const focusCdpTabOutput = toolSchema({
  focused: z
    .boolean()
    .describe(
      'The browser accepted the request. Deliberately weaker than ' +
        '`close_cdp_tab`\'s `closed`: a closed tab can be polled for, but ' +
        'whether a window actually came to the front is not readable, and an ' +
        'operating system may decline to raise a background application\'s ' +
        'window. If the host offers an OS-level window-focus tool, it should ' +
        'match the tab title to the Chrome window title and use that tool; ' +
        'otherwise, ask the user to click the browser in their taskbar.',
    ),
  targetId: z.string(),
  title: z.string().describe('Title of the tab brought forward — say this, not just that it worked.'),
  url: z.string(),
  engine: z.string(),
  profile: z.string(),
  port: z.number(),
  scope: rootScope
    .nullable()
    .describe(
      'Which root owned the browser — "project" or "user" (machine-wide). ' +
        'Null for a foreign browser, or when an older server did not say.',
    ),
  warnings: z.array(z.string()),
});

export const listCdpBrowsersOutput = toolSchema({
  // Which root this call resolved against — 'user' means no project was found
  // and the sweep covered only the user root (stories/mcp-no-project.md rule
  // 7). Without it, a typo'd config filename silently drops the project's
  // browsers from the listing with no trace: the exact "mysteriously absent"
  // failure the fallback-must-be-reported rule exists to prevent.
  scope: z
    .enum(['project', 'user'])
    .describe(
      'Which root this call resolved against. "user" means no project resolved ' +
        'and only the machine-wide user root was swept — if you expected a ' +
        "project's browsers and they are missing, its aiui.config.json did not " +
        'resolve.',
    ),
  running: z.array(
    z.object({
      engine: z.string(),
      profile: z.string(),
      port: z.number(),
      profileDir: z.string(),
      scope: rootScope.describe(
        '"project" — this project\'s browser. "user" — the machine-wide one, ' +
          'reachable from any directory.',
      ),
      tabs: z.array(ownedCdpTab),
    }),
  ),
  available: z.array(
    z.object({
      engine: z.string(),
      profile: z.string(),
      profileDir: z.string(),
      scope: rootScope,
    }),
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
  scope: rootScope.describe(
    'Which root the browser lives under. "user" means it is reachable from ' +
      'any directory on this machine, project or not.',
  ),
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

/**
 * What the run ran under (stories/run-settings.md §5).
 *
 * Every server-supplied field is `.nullable()` — an older Sessions API server
 * omits the whole object, and a missing key is fatal to `validateToolOutput`
 * where a null one is merely "not reported". `screenshotsReturn` is never null:
 * the MCP side always knows it, since the server never sees it.
 */
const effectiveSettings = z
  .object({
    model: z.string().nullable(),
    capture: z.enum(['every-step', 'on-failure', 'none', 'custom']).nullable(),
    fullPage: z.boolean().nullable(),
    sendScreenshots: z.boolean().nullable(),
    ai: z
      .enum(['on', 'off'])
      .nullable()
      .describe(
        'Whether this run could use AI. "off" means it made zero AI calls — ' +
          'read aiOffReason to see whether that was asked for or forced.',
      ),
    aiOffReason: z
      .enum(['policy', 'no-key'])
      .nullable()
      .describe(
        'Why ai is "off". "policy" — somebody asked for a run that spends ' +
          'nothing. "no-key" — nothing is configured on this machine, so no ' +
          'run here can use AI. Policy is reported first when both hold, so ' +
          '"policy" says nothing either way about whether a key exists. Null ' +
          'when ai is on.',
      ),
    sources: z
      .object({
        model: settingSource,
        capture: settingSource,
        fullPage: settingSource,
        sendScreenshots: settingSource,
        // Nullable where the other four are not: a Sessions API server that
        // predates the AI switch reports the four and omits this one.
        ai: settingSource.nullable(),
      })
      .nullable(),
    screenshotsReturn: z.enum(['none', 'on-failure', 'final']),
  })
  .nullable()
  .describe(
    'The settings this run actually used. Worth reading rather than assuming: a ' +
      'preference set earlier in a conversation is easy to lose track of, and ' +
      'these are the values that were really in force.',
  );

export const runResultOutput = toolSchema({
  status: z.enum(['passed', 'failed', 'error', 'aborted']),
  streamDropped: z.boolean(),
  sessionId: z.string(),
  projectRoot: z.string(),
  scope: z
    .enum(['project', 'user'])
    .describe(
      'Which root the run resolved against. "user" means no project was found ' +
        'and the run went project-less against the machine-wide user root — if ' +
        'you expected a project, its aiui.config.json did not resolve; say so ' +
        'rather than reporting a normal run.',
    ),
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
  effectiveSettings,
});

/** One tab an errand opened. `targetId` is nullable rather than optional for
 *  the schema's usual reason — a missing key is fatal to `validateToolOutput`
 *  where a null one is merely "the tracker never resolved one". */
const errandTab = z.object({
  targetId: z.string().nullable(),
  url: z.string(),
  title: z.string(),
});

/**
 * The receipt (stories/errands.md §Return).
 *
 * It is `runResultOutput`'s shape minus everything that is session state —
 * there is no `sessionId`, no `sessionCreated`/`configApplied`, no
 * `queuedForMs` (an errand takes no session lock) and no `reportPath` (no file
 * is written, ever) — plus what an errand alone can say: which tab it gave
 * back, and what it opened while it was there.
 */
export const runErrandOutput = toolSchema({
  status: z.enum(['passed', 'failed', 'error', 'aborted']),
  streamDropped: z.boolean(),
  errandId: z
    .string()
    .describe(
      'This errand, for the length of this request only. Nothing on the server ' +
        'answers to it afterwards — there is no close_errand, and nothing to close. ' +
        'Empty in one case only: the stream ended before the errand reported one, ' +
        'which status "error" and the error text describe.',
    ),
  root: z.string().describe('The root the errand resolved its project layer against.'),
  scope: rootScope.describe(
    'Which root that was. "user" means no project resolved and the errand ran ' +
      'against the machine-wide user root — if you expected a project, its ' +
      'aiui.config.json did not resolve; say so rather than reporting a normal run.',
  ),
  steps: z.array(foldedStep),
  captures: z
    .record(z.string(), z.string())
    .describe(
      'Every `store as` capture. This is where an errand\'s variables go — to ' +
        'you, because the server keeps no scope. A later errand starts empty, so ' +
        'anything you need again must be passed back in the step text.',
    ),
  finalUrl: z
    .string()
    .describe(
      'Where the borrowed tab ended up. An errand navigates it only when a step ' +
        'said to, and this is the only record of that.',
    ),
  finalTitle: z.string(),
  openedTabs: z
    .array(errandTab)
    .describe('Tabs the errand opened along the way, whether or not they survived it.'),
  keptOpen: z
    .array(errandTab)
    .describe(
      'The subset still open on return — normally the keep_open ones and nothing ' +
        'else, but a tab another errand took over is spared the close and is listed ' +
        'here too, because it really is still on screen.',
    ),
  messages: z.array(z.object({ level: z.enum(['error', 'warn']), text: z.string() })),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
  effectiveSettings,
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

// ---------------------------------------------------------------------------
// log_into_site (SPEC 29 — the credential broker)
//
// Note what is NOT here: no site, no domain, no username, no password. The
// page the session is on IS the site, and the broker reads that URL from the
// browser. That absence is the security design, not an omission — a `site`
// argument would let a page that says "log into the user's bank" choose which
// credential is fetched, which is precisely what this feature exists to
// prevent. Do not add one.
// ---------------------------------------------------------------------------

export const logIntoSiteInput = toolSchema({
  session_id: z.string().describe('Session whose current page holds the sign-in form.'),
  project_root: projectRoot,
  hint_username_selector: z
    .string()
    .min(1)
    .optional()
    .describe(
      'CSS selector for the username field, for the rare form this cannot read ' +
        'by itself. Only supply it after a call came back "stuck" — the ' +
        'built-in scan handles ordinary forms, including two-step and ' +
        'shadow-DOM ones.',
    ),
  hint_password_selector: z
    .string()
    .min(1)
    .optional()
    .describe(
      'CSS selector for the password field. Ignored unless it addresses a real ' +
        'password input on this page: the password is never typed anywhere else, ' +
        'whatever this says.',
    ),
  hint_otp_selector: z
    .string()
    .min(1)
    .optional()
    .describe('CSS selector for a one-time-code field.'),
  allow_foreign_session: allowForeignSession,
});

export const logIntoSiteOutput = toolSchema({
  outcome: z
    .enum([
      'logged-in',
      'username-entered-continue',
      'otp-entered-continue',
      'not-a-login-page',
      'no-credential-for-this-site',
      'multiple-matches',
      'denied',
      'vault-locked',
      'vault-unavailable',
      'stuck',
    ])
    .describe(
      'What happened. `logged-in` — the form was filled and submitted; READ THE ' +
        'PAGE to confirm the site accepted it. `username-entered-continue` / ' +
        '`otp-entered-continue` — one page of a multi-page sign-in is done; wait ' +
        'for the next page and call again. `not-a-login-page` — no form here, and ' +
        'nothing was read or unlocked. `no-credential-for-this-site` — tell the ' +
        'user to add one to Bitwarden, and NEVER ask them to type a password to ' +
        'you. `denied` — the user said no; do not retry. `stuck` — a page this ' +
        'will not fill (sign-up form, captcha, PIN pad); the user must do it.',
    ),
  domain: z.string().describe('The host the browser was actually on, which is what the vault was matched against.'),
  framedBy: z
    .string()
    .nullable()
    .describe('Set when the form was inside an iframe from a different host than the page.'),
  item: z.string().nullable().describe('The NAME of the saved login used. Never its contents.'),
  candidates: z
    .array(z.string())
    .nullable()
    .describe('Names of the saved logins that matched, when the user was asked to choose.'),
  detail: z.string().describe('What happened, in words you can relay to the user.'),
  continues: z
    .boolean()
    .describe('True when this sign-in has more pages — advance the page, then call this tool again.'),
});

// The `*Output` schemas above are also the `safeParse` handles the handlers use
// on their own results before returning them. The SDK would validate them
// itself, but its failure path turns a mismatch into `isError:true` with no
// structured content — so `validated()` in `tools.ts` checks first and degrades
// to something still usable.

export type RunResult = z.infer<typeof runResultOutput>;
