/**
 * Turning a tool call into a `POST /sessions/:id/steps` body.
 *
 * Both run tools land here, and both assemble the *same* project fields —
 * `run_steps` is not a lesser path. Sending steps without `skillsDir`,
 * `toolsDir` or the composed `env` would make `[skill: x]` and `[tool: x]`
 * lines ship to the AI as prose and run against the *server process's* AI key
 * and model rather than the project's.
 *
 * Two things are worth knowing before editing this file:
 *
 * - **The call order is pinned** (§3 of stories/mcp-server.md). It reads
 *   oddly on purpose: the environment cannot be resolved before the parse,
 *   because the name may come from the file's own frontmatter, and the file
 *   cannot be read before it has been confined.
 * - **The wire body is an allow-list on the server side.** Widening a type
 *   here compiles cleanly and drops the field at runtime; `envName` was lost
 *   that way once already. Every field below maps to a branch in
 *   `api-server.ts`'s request builder.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { interpolateEnvData } from '../parser/interpolate-env-data.js';
import { isCodeStep as isInvocationStep } from '../parser/invocation-parser.js';
import { parseTestContent, resolveDataSourcePath } from '../parser/markdown.js';
import type { ParsedSection, ParsedTest } from '../parser/types.js';
import {
  badCdpPort,
  emptySteps,
  interpolationFailed,
  notATestFile,
  parseFailed,
  projectlessCodeSteps,
} from './errors.js';
import {
  applyEnvName,
  canonicalTestFilePath,
  configuredRoots,
  confinePath,
  fail,
} from './project.js';
import type {
  AssembledRun,
  CdpTarget,
  McpStepRequest,
  ProjectContext,
  ResolveProject,
  RunSettings,
} from './types.js';

/**
 * `run_steps` has no file, but the server derives the project root, the
 * env/data bundle, the report directory and the cache anchor entirely from
 * `testFilePath` — so it gets a synthetic one. It is never realpath'd and
 * never existence-checked: it does not exist, and running it through the
 * missing-file detector would refuse every `run_steps` call.
 */
const SYNTHETIC_STEPS_BASENAME = '.aiui-mcp-steps.md';

/** `[input:]` / `[interactive]` as the server matches them — steps it will
 *  decline to run unattended. */
const INPUT_STEP_PATTERN = /^\[input:\s*\w+\]/i;
const INTERACTIVE_STEP_PATTERN = /^\[interactive\]/i;

/**
 * Does this step invoke a skill or a tool? Re-exported here because
 * `run_errand` and the project-less `run_steps` guard both refuse such steps,
 * and this is where "what counts as a code step" used to be defined.
 *
 * It is the PARSER, not a look-alike pattern. That matters for the property
 * `session-manager.ts`'s project-less no-tools guarantee leans on: the scan
 * must claim every line the runner would dispatch. As a regex it did not —
 * a hand-added `/i` refused `Verify the button reads [Tool Settings]` as a
 * "code step" the runner ran as prose, and no pattern can express the
 * grammar's markdown-link and colon-less-leniency rules at all.
 * `tests/invocation-mirror-parity.test.ts` pins the equivalence.
 */
export const isCodeStep = isInvocationStep;

/** Any `${...}` reference, for the "nothing will interpolate this" warning. */
const ANY_PLACEHOLDER = /\$\{[^}]*\}/g;

/** A `${<namespace>.<path>}` reference that survived client-side
 *  interpolation — necessarily a `data`/named-source one, since `${env.X}`
 *  either resolves or throws. */
const NAMESPACE_PLACEHOLDER = /\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z0-9_.\-]+)\s*\}/g;

/** TestBench's whole-value `$VAR` form. Deliberately anchored so `${env.X}`
 *  and `${data.X}` cannot match — they have their own resolution path, and
 *  reporting them as unresolvable `$VAR`s would be noise on top of a real
 *  diagnostic. */
const WHOLE_VALUE_VAR = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

/** Runtime parameter placeholder, matching `src/parser/parameters.ts` and the
 *  skill expander. */
const PARAM_PLACEHOLDER = /\{\{(\w+)\}\}/g;

export interface AssembleArgs {
  /** The same `deps.resolveProject` the tools hold, injected so the seam
   *  tests can assemble against a fake project. */
  resolveProject: ResolveProject;
  projectRoot?: string | undefined;
  /** Tool argument only. A frontmatter `env:` is applied later (§3 step 10). */
  envName?: string | undefined;
  parameters?: Record<string, string> | undefined;
  /**
   * `cdp` **is** accepted here now, and it is the one config key that attaches
   * this framework to an already-open, already-logged-in browser. The rule
   * that replaced "an agent may never pick a browser" is:
   *
   *   **file config is trusted; tool config is gated.**
   *
   * A `## Config: cdp:` line in a test file is human-authored and goes through
   * untouched, exactly as before. A `cdp` arriving as a *tool argument* is a
   * model's choice, and is only honoured for a browser this project launched —
   * `assertPortAttachable` in `cdp.ts` enforces that before any run starts,
   * driven by the `cdpSource` this module reports.
   *
   * The two sources stay physically separate in the code rather than being
   * merged into one map and sorted out later: `cdp` is deliberately kept out
   * of `mergeDefined`'s string merge, so there is no arrangement of keys that
   * lets a tool-supplied value be mistaken for a file-declared one.
   */
  config?:
    | {
        baseUrl?: string | undefined;
        timeout?: string | undefined;
        /** Raw `## Config: viewport:` spec (stories/per-test-viewport.md §7).
         *  A plain string, so it rides the same per-key merge as `baseUrl` —
         *  an agent can run a file at a different size without editing it, and
         *  supplying only `viewport` leaves the file's `baseUrl` alone. */
        viewport?: string | undefined;
        // Unresolved: this may address a browser by `profile` instead of
        // `port`, and only `tools.ts` has the client to turn one into the
        // other.
        cdp?: CdpTarget | undefined;
      }
    | undefined;
  /**
   * Per-session run settings from the tool arguments
   * (stories/run-settings.md §1).
   *
   * A NEW wire field, deliberately outside the `## Config` string merge above.
   * Two reasons, both structural rather than stylistic: that merge is typed
   * `Record<string, string|undefined>` and these are enums, booleans and nulls;
   * and `## Config` values are per-run text from a test file, while these are
   * retained on the session and have their own clearing semantics. A test file
   * cannot declare them and a tool argument cannot be mistaken for one.
   */
  runSettings?: RunSettings | undefined;
}

export interface AssembleTestFileArgs extends AssembleArgs {
  path: string;
}

export interface AssembleStepsArgs extends AssembleArgs {
  steps: string[];
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** §3 steps 1–12 for `run_test_file`. */
export async function assembleTestFile(args: AssembleTestFileArgs): Promise<AssembledRun> {
  const warnings: string[] = [];

  // Steps 1–2, before anything reads a byte.
  const absPath = canonicalTestFilePath(args.path);
  // Normalised once, and used for both the layering below and the frontmatter
  // fallback. Without this an `env_name: ""` — which `z.string().optional()`
  // accepts and models emit freely for an unset optional — falls between two
  // guards: `resolveProject` treats it as absent and layers nothing, while the
  // frontmatter fallback skips because it is not `undefined`. The run then
  // proceeds against the wrong environment entirely.
  const toolEnvName = args.envName?.trim() || undefined;
  // Steps 3–7, plus step 10 when the tool supplied `env_name`. A test file
  // has no user-scope meaning — tests are project-shaped — so this is one of
  // the two tools that refuses rather than falling back to the user root
  // (stories/mcp-no-project.md).
  let project = await args.resolveProject({
    testFilePath: absPath,
    projectRoot: args.projectRoot,
    envName: toolEnvName,
    requireProject: true,
  });

  // Step 8.
  const raw = await fs.readFile(absPath, 'utf-8');

  // Step 9. Every throw is a pre-flight failure — there is no run yet.
  // `parseTestContent` throws on duplicate/reserved/empty section names and on
  // marked-vs-scanner drift, which a numbered line inside a code fence hits.
  let parsed: ParsedTest;
  try {
    parsed = parseTestContent(raw, absPath);
  } catch (err) {
    fail(parseFailed(absPath, (err as Error).message));
  }

  if (parsed.frontmatter.type === 'skill') {
    fail(
      notATestFile(
        absPath,
        'its frontmatter says `type: skill`. Skills are step macros — invoke ' +
          'one from a test with `[skill: <name>]` rather than running it directly.',
      ),
    );
  }
  if (parsed.steps.length === 0) {
    fail(notATestFile(absPath, 'it declares no steps under a `## Steps` heading.'));
  }

  // Step 10 for a frontmatter-declared environment. The tool argument wins
  // when both are present, and has already been applied.
  const frontmatterEnv = parsed.frontmatter.env?.trim();
  if (toolEnvName === undefined && frontmatterEnv !== undefined && frontmatterEnv !== '') {
    project = await applyEnvName(project, frontmatterEnv);
  }

  // Step 11. The values go on the wire verbatim — the server resolves them
  // against `dirname(testFilePath)` — so we confine what *it* will resolve.
  const dataSources = confineDataSources(
    parsed.frontmatter.dataSources,
    path.dirname(absPath),
  );

  // Step 12.
  // The tool argument overrides `## Config` per key — never wholesale, or
  // passing `timeout` alone would drop the test's own `baseUrl`.
  const fileConfig = parsed.config as Record<string, string | undefined>;
  // `cdp` is destructured out before the string merge, not filtered out inside
  // it: the merge is typed `Record<string, string|undefined>` and `cdp` is an
  // object, so keeping them apart is enforced by the compiler rather than by
  // remembering to.
  const { cdp: toolCdp, ...toolStringConfig } = args.config ?? {};
  const { config, cdpSource } = projectConfig(
    mergeDefined(fileConfig, toolStringConfig),
    fileConfig,
    toolCdp,
    project,
    absPath,
    warnings,
  );
  const parameters = interpolateValues(
    { ...parsed.parameters, ...args.parameters },
    project,
    absPath,
    warnings,
  );

  const sections = sectionsPayload(parsed.sections);
  const sourceLines = usableSourceLines(parsed.stepLines, parsed.steps.length, warnings);

  // `run_test_file` alone can tell declared parameters from undeclared ones,
  // and alone has `## Steps` text to scan for placeholders that will stay
  // literal.
  for (const name of Object.keys(args.parameters ?? {})) {
    // `hasOwn`, not `in`: `in` walks the prototype chain, so a parameter named
    // `valueOf` or `toString` would read as already-declared and skip the
    // warning.
    if (!Object.hasOwn(parsed.parameters, name)) {
      warnings.push(
        `Parameter "${name}" is not declared in this test's \`## Parameters\` ` +
          'section. It is sent anyway, but nothing will read it unless a step ' +
          `references {{${name}}}.`,
      );
    }
  }
  const sectionSteps = Object.values(parsed.sections).flatMap((section) => section.steps);
  const unresolvedParams = missingParameters([...parsed.steps, ...sectionSteps], parameters);
  if (unresolvedParams.length > 0) {
    warnings.push(
      `These placeholders have no value and will reach the AI literally: ` +
        `${unresolvedParams.map((n) => `{{${n}}}`).join(', ')}. ` +
        '(Only this file\'s own steps and sections were scanned — skill bodies ' +
        'expand server-side and are not visible from here.)',
    );
  }

  const unattended = parsed.steps.filter(
    (step) => INPUT_STEP_PATTERN.test(step.trim()) || INTERACTIVE_STEP_PATTERN.test(step.trim()),
  );
  if (unattended.length > 0) {
    warnings.push(
      `${unattended.length} step(s) need a human at a terminal ` +
        `([input:] / [interactive]) and will be reported as "skipped": ` +
        `${unattended.map((s) => JSON.stringify(s)).join(', ')}.`,
    );
  }

  warnUnresolvablePlaceholders(
    project,
    [...parsed.steps, ...sectionSteps],
    { ...config, ...parameters },
    warnings,
  );
  if (dataSources !== null && project.envName === null) {
    warnings.push(
      'This test declares `dataSources`, but the server ignores them unless an ' +
        'environment name is in play. Pass env_name, or add `env:` to the ' +
        `test's frontmatter, or \`\${<source>.X}\` references will stay literal.`,
    );
  }

  const request: McpStepRequest = {
    steps: parsed.steps,
    ...(sourceLines !== null && { sourceLines }),
    ...(sections !== null && { sections }),
    ...(dataSources !== null && { dataSources }),
    ...(Object.keys(config).length > 0 && { config }),
    ...(Object.keys(parameters).length > 0 && { parameters }),
    // Omitted when the caller set nothing, so a plain run does not look like a
    // request to clear the session's retained settings.
    ...(args.runSettings !== undefined &&
      Object.keys(args.runSettings).length > 0 && { runSettings: args.runSettings }),
    ...projectFields(project, absPath, cacheEnabled(parsed, project)),
  };

  return {
    request,
    project,
    sentSteps: parsed.steps,
    warnings,
    cdpSource,
    cdpTarget: cdpSource === 'tool' ? (toolCdp ?? null) : null,
  };
}

/** §3 steps 4–7 and 12 for `run_steps`; the file-only steps are skipped and
 *  the test path is synthesised. */
export async function assembleSteps(args: AssembleStepsArgs): Promise<AssembledRun> {
  const warnings: string[] = [];
  if (args.steps.length === 0) fail(emptySteps());

  // Same normalisation as `assembleTestFile`: `""` is an absent argument, not
  // an environment named the empty string.
  const project = await args.resolveProject({
    projectRoot: args.projectRoot,
    envName: args.envName?.trim() || undefined,
  });
  const testFilePath = path.join(project.projectRoot, SYNTHETIC_STEPS_BASENAME);

  // Rule 6 of stories/mcp-no-project.md. In user scope `skillsDir`/`toolsDir`
  // are null by construction, and the server's behaviour for a `[skill:]` or
  // `[tool:]` line with no directory on the wire is to hand it to the AI as
  // prose — a silent, expensive wrong answer three layers down. Refused here,
  // before any session exists, with the reason and the fix.
  if (project.scope === 'user') {
    const offending = args.steps.filter((step) => isCodeStep(step));
    if (offending.length > 0) {
      fail(projectlessCodeSteps(offending, project.configSearch));
    }
  }

  // No file, so no file-declared `cdp` — any `cdp` on a `run_steps` call is a
  // tool argument by construction, and therefore always gated.
  const { cdp: toolCdp, ...toolStringConfig } = args.config ?? {};
  const { config, cdpSource } = projectConfig(
    mergeDefined({}, toolStringConfig),
    {},
    toolCdp,
    project,
    testFilePath,
    warnings,
  );
  const parameters = interpolateValues(
    { ...args.parameters },
    project,
    testFilePath,
    warnings,
  );
  warnUnresolvablePlaceholders(project, args.steps, { ...config, ...parameters }, warnings);

  // The *undeclared*-parameter warning is `run_test_file`-only (there is no
  // `## Parameters` block to compare against), but a placeholder left literal
  // is just as wrong in an agent's own steps — it reaches the AI as the text
  // `{{who}}`.
  const unresolved = missingParameters(args.steps, parameters);
  if (unresolved.length > 0) {
    warnings.push(
      'These placeholders have no value and will reach the AI literally: ' +
        `${unresolved.map((name) => `{{${name}}}`).join(', ')}. Pass them in \`parameters\`.`,
    );
  }

  const request: McpStepRequest = {
    steps: args.steps,
    // Synthetic 1..n. The fold recovers `sentIndex` from a root event's line,
    // so omitting these would cost per-step attribution the moment anything
    // expands.
    sourceLines: args.steps.map((_step, index) => index + 1),
    ...(Object.keys(config).length > 0 && { config }),
    ...(Object.keys(parameters).length > 0 && { parameters }),
    // See the note in `assembleTestFile`: absent means "leave the session's
    // settings alone", so an empty object must not be sent.
    ...(args.runSettings !== undefined &&
      Object.keys(args.runSettings).length > 0 && { runSettings: args.runSettings }),
    ...projectFields(project, testFilePath, project.cacheEnabled),
  };

  return {
    request,
    project,
    sentSteps: args.steps,
    warnings,
    cdpSource,
    cdpTarget: cdpSource === 'tool' ? (toolCdp ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// Shared field construction
// ---------------------------------------------------------------------------

/** The fields both entry points send identically. */
function projectFields(
  project: ProjectContext,
  testFilePath: string,
  cache: boolean,
): Pick<
  McpStepRequest,
  'env' | 'envName' | 'skillsDir' | 'toolsDir' | 'cacheEnabled' | 'testFilePath'
> {
  return {
    env: project.env,
    ...(project.envName !== null && { envName: project.envName }),
    ...(project.skillsDir !== null && { skillsDir: project.skillsDir }),
    ...(project.toolsDir !== null && { toolsDir: project.toolsDir }),
    // Omitted when off: caching is opt-in server-side, so an absent flag and an
    // explicit `false` mean the same thing.
    ...(cache && { cacheEnabled: true }),
    testFilePath,
  };
}

/**
 * `stepLines` → `sourceLines`, with the server's own usability rule applied
 * here so we can say something about it.
 *
 * The route drops the array unless the arity matches and every element is
 * finite and greater than zero — and the parser legitimately emits `0` for a
 * step it could not locate in the raw text. Sending it anyway would have the
 * server discard it silently; omitting it costs `sentIndex` recovery for every
 * expanded row, which is worth a warning.
 */
function usableSourceLines(
  stepLines: number[],
  stepCount: number,
  warnings: string[],
): number[] | null {
  const usable =
    stepLines.length === stepCount &&
    stepLines.every((line) => Number.isFinite(line) && line > 0);
  if (usable) return stepLines;
  warnings.push(
    'Source line numbers were unusable for this file, so per-step results may ' +
      'not be traceable back to the step that produced them (steps that expand ' +
      'a skill or a section will report no index or text).',
  );
  return null;
}

/**
 * `ParsedSection` minus `rawSteps`.
 *
 * The extra key is not an error — `validateSectionEntry` does not reject
 * unknown ones — but it is the match side for nested bare-name calls, which
 * the server re-derives itself, so it is pure payload weight.
 *
 * The map is null-prototype for the same reason the parser's and the server's
 * are: a section may legally be named `__proto__`, and on a normal object
 * literal that assignment hits the prototype setter, the entry vanishes, and
 * the bare name reaches the AI as a literal instruction.
 */
function sectionsPayload(
  sections: Record<string, ParsedSection>,
): NonNullable<McpStepRequest['sections']> | null {
  const keys = Object.keys(sections);
  if (keys.length === 0) return null;
  const out = Object.create(null) as NonNullable<McpStepRequest['sections']>;
  for (const key of keys) {
    const section = sections[key]!;
    out[key] = {
      name: section.name,
      headingLine: section.headingLine,
      steps: section.steps,
      stepLines: section.stepLines,
    };
  }
  return out;
}

/**
 * §4a rule 5 for frontmatter `dataSources`.
 *
 * The declared strings go on the wire untouched — the server resolves them
 * against the test file's directory, with no confinement of its own — so this
 * replicates `resolveDataSourcePath` (including its `~` expansion) purely to
 * check where they land.
 */
function confineDataSources(
  declared: Record<string, string> | undefined,
  testDir: string,
): Record<string, string> | null {
  if (declared === undefined || Object.keys(declared).length === 0) return null;
  // Confined against the CONFIGURED roots, not `allowedRoots()`. This only
  // runs for `run_test_file` (project scope), and a project's frontmatter
  // `dataSources` — with `~` expansion, so no symlink even needed — must not
  // be allowed to read out of the user root that joined the addressing
  // allow-list. `~/AppData/Local/aiui/...` is refused here rather than shipped
  // to the server, which confines nothing of its own.
  const roots = configuredRoots();
  for (const [name, declaredPath] of Object.entries(declared)) {
    confinePath(resolveDataSourcePath(declaredPath, testDir), roots, `${name}: ${declaredPath}`);
  }
  return declared;
}

// ---------------------------------------------------------------------------
// `config` projection + interpolation (§3)
// ---------------------------------------------------------------------------

type WireConfig = NonNullable<McpStepRequest['config']>;

/** Where the `cdp` on the wire came from, or `null` when there is none.
 *  `'tool'` is the only value that obliges a caller to run §6's gate. */
type CdpSource = 'file' | 'tool' | null;

/** Per-key override that ignores explicit `undefined`s. A plain spread would
 *  let `{ baseUrl: undefined }` — which is what an omitted optional tool
 *  argument looks like once it has been read off an object — erase the value
 *  the test file declared. */
function mergeDefined(
  base: Record<string, string | undefined>,
  override: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * `## Config` is projected onto the wire shape, never passed through.
 *
 * The parser's `TestConfig` carries `cdp` as a *string*; the wire wants
 * `{ port, tab? }`. `api-server.ts` casts with no validation and
 * `launchBrowser` branches on bare truthiness, so forwarding the parsed shape
 * makes `## Config: cdp: 9222` take the CDP branch with `port === undefined`
 * — a browser that attaches to nothing. Values are interpolated *before* the
 * projection so `cdp: ${env.CDP_PORT}` works and the error names the resolved
 * value.
 */
function projectConfig(
  merged: Record<string, string | undefined>,
  /** The test file's own `## Config`, before the tool argument was merged in.
   *  A file-declared `cdp` is read only from here — see below. */
  fileOnly: Record<string, string | undefined>,
  /** A `cdp` supplied as a TOOL ARGUMENT. Deliberately a separate parameter,
   *  not a key in `merged` — see below. */
  toolCdp: CdpTarget | undefined,
  project: ProjectContext,
  filePath: string,
  warnings: string[],
): { config: WireConfig; cdpSource: CdpSource } {
  const raw: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === 'string') raw[key] = value;
  }
  const resolved = interpolateValues(raw, project, filePath, warnings);

  const out: WireConfig = {};
  if (resolved['baseUrl'] !== undefined) out.baseUrl = resolved['baseUrl'];
  if (resolved['timeout'] !== undefined) out.timeout = resolved['timeout'];
  // The raw spec, unvalidated (stories/per-test-viewport.md §7). This whitelist
  // is a real projection — a key absent from here never reaches the wire, so an
  // MCP-run test would silently lose its `viewport:` and pass at the wrong size.
  // Not resolved here on purpose: §3 puts the one validator on the server, so
  // `run_test_file` and a Run in TestBench refuse `390` with the same words.
  if (resolved['viewport'] !== undefined) out.viewport = resolved['viewport'];

  // A file-declared `cdp` is read from the FILE's config, never the merged
  // map, and that separation is now doing MORE work than when it was written,
  // not less.
  //
  // It used to mean "an agent can never supply one" — zod stripped `cdp` from
  // the tool schema, and reading `fileOnly` made sure a future schema change
  // could not quietly admit one. The rule has changed: an agent may now name a
  // browser, but only one this project launched, and only after
  // `assertPortAttachable` has checked it against the live registry.
  //
  // So the two sources must stay *distinguishable*, which is exactly what this
  // split gives us. `cdpSource` below is what tells the caller whether a gate
  // check is owed — and because a tool-supplied `cdp` never enters `merged`,
  // there is no key arrangement, interpolation result or schema change that
  // can make one arrive wearing the other's clothes.
  const declaredCdp = typeof fileOnly['cdp'] === 'string' ? fileOnly['cdp'].trim() : '';
  const cdp = declaredCdp === '' ? '' : (resolved['cdp']?.trim() ?? declaredCdp);
  let cdpSource: CdpSource = null;
  if (cdp !== '') {
    const port = Number(cdp);
    // The DECLARED text in the message, not the resolved value: `cdp:
    // ${env.AI_API_KEY}` would otherwise print the key into a tool result.
    if (!Number.isInteger(port) || port <= 0 || port > 65535) fail(badCdpPort(declaredCdp));
    const tab = resolved['cdpTab']?.trim();
    // `cdpTab` without `cdp` is meaningless and dropped in silence — it selects
    // a tab in a browser we are not attaching to.
    out.cdp = tab !== undefined && tab !== '' ? { port, tab } : { port };
    cdpSource = 'file';
  } else if (toolCdp !== undefined) {
    // The file wins when both are present. A test file that names its own
    // browser was written by a human who knew which one they meant, and an
    // agent's argument should not silently redirect it somewhere else.
    //
    // Deliberately NOT resolved to a port here. A tool-supplied target may name
    // a *profile*, and turning that into a port takes a live round-trip to the
    // registry that this module has no client for. So the raw target rides out
    // on `cdpTarget` and `tools.ts` resolves it, gates it, and writes
    // `config.cdp` itself — one path for both address forms, so a port cannot
    // reach the browser by a different route than a profile does.
    cdpSource = 'tool';
  }

  // `logging` is a process-global `setLogLevel` on the server, so sending one
  // would quieten a concurrent TestBench run's output too (§2). These two keys
  // therefore go nowhere, which is worth saying out loud to an author who set
  // them.
  const ignored = ['consoleLogLevel', 'serverFileLogLevel'].filter(
    (key) => resolved[key] !== undefined,
  );
  if (ignored.length > 0) {
    warnings.push(
      `\`## Config\` ${ignored.join(' and ')} ${ignored.length === 1 ? 'is' : 'are'} ` +
        'not applied to MCP runs: log levels are process-global on the server, ' +
        'so changing them would also change a concurrent run\'s output.',
    );
  }

  return { config: out, cdpSource };
}

/**
 * Whether the step cache is on for this run.
 *
 * Mirrors TestBench's `resolveCacheOverride` **including its full value set** —
 * `on|true|yes|enabled` / `off|false|no|disabled`. Accepting only `on|off`
 * would let a test that says `cache: false` be served from cache.
 */
function cacheEnabled(parsed: ParsedTest, project: ProjectContext): boolean {
  const declared = (parsed.config as Record<string, string | undefined>)['cache'];
  const value = (declared ?? '').trim().toLowerCase();
  if (value === 'on' || value === 'true' || value === 'yes' || value === 'enabled') return true;
  if (value === 'off' || value === 'false' || value === 'no' || value === 'disabled') return false;
  return project.cacheEnabled;
}

/**
 * Interpolate a map of `config` / `parameters` values client-side.
 *
 * The server interpolates *steps* only — `baseUrl` goes straight to
 * `page.goto` and `parameters` are merged verbatim — so `- baseUrl: $BASE_URL`
 * would otherwise navigate to the literal string. Two syntaxes, deliberately:
 * `${env.X}` as the CLI resolves it, and TestBench's whole-value `$VAR`. They
 * fail differently, and that asymmetry is intentional: `${env.FOO}` is
 * unambiguously a reference, so an unknown one is fatal (CLI fail-fast),
 * whereas a bare `$FOO` is indistinguishable from prose and is left alone.
 */
function interpolateValues(
  values: Record<string, string | undefined>,
  project: ProjectContext,
  filePath: string,
  warnings: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string') continue;
    let resolved: string;
    try {
      resolved = interpolateEnvData(value, {
        env: project.env,
        envName: project.envName,
        filePath,
      });
    } catch (err) {
      fail(interpolationFailed((err as Error).message));
    }

    const wholeValue = WHOLE_VALUE_VAR.exec(resolved);
    if (wholeValue !== null) {
      const name = wholeValue[1]!;
      const fromEnv = project.env[name];
      if (fromEnv !== undefined) {
        resolved = fromEnv;
      } else {
        warnings.push(
          `"${key}" is "${resolved}" and $${name} is not set in ` +
            `${project.envFilesConsulted.join(' or ')}, so it stays literal.`,
        );
      }
    }

    // `${data.X}` / `${<source>.X}` cannot be resolved here: the pattern only
    // matches when the data trees are loaded, and we forward `dataSources` for
    // the server to resolve instead. Anything left is a value the server will
    // *not* revisit — `config` and `parameters` are consumed verbatim there.
    for (const match of resolved.matchAll(NAMESPACE_PLACEHOLDER)) {
      warnings.push(
        `"${key}" still contains ${match[0]} — data placeholders in \`config\` ` +
          'and `## Parameters` are not resolved for MCP runs (only steps are, ' +
          'and only server-side).',
      );
    }
    out[key] = resolved;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Warnings that need the finished payload
// ---------------------------------------------------------------------------

/**
 * With no environment name the server builds no interpolation context at all,
 * so `${env.PASSWORD}` in a step reaches the AI as six literal characters and
 * a variable name. Nothing here can fix that — the point is that the agent
 * should be told rather than left reading a transcript full of placeholders.
 */
function warnUnresolvablePlaceholders(
  project: ProjectContext,
  steps: readonly string[],
  values: Record<string, unknown>,
  warnings: string[],
): void {
  if (project.envName !== null) return;
  const texts = [
    ...steps,
    ...Object.values(values).filter((value): value is string => typeof value === 'string'),
  ];
  const warning = unresolvablePlaceholderWarning(texts);
  if (warning !== null) warnings.push(warning);
}

/**
 * The warning itself, over any collection of text.
 *
 * Exported because `run_errand` has exactly this problem for exactly this
 * reason — the server builds no env bundle without an `env_name`
 * (`if (envName)` in the session manager), so `${env.PASSWORD}` reaches the AI
 * as literal text — and two wordings of one diagnostic teach an agent that
 * they are two different problems.
 *
 * Returns null when there is nothing to say.
 */
export function unresolvablePlaceholderWarning(texts: readonly string[]): string | null {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(ANY_PLACEHOLDER)) found.add(match[0]);
  }
  if (found.size === 0) return null;
  return (
    `No environment name is in play, so the server will not interpolate ` +
    `${[...found].join(', ')} — they will be sent as literal text. Pass ` +
    'env_name to resolve them.'
  );
}

/** `{{name}}` placeholders with no value in the merged parameter map. */
function missingParameters(
  steps: readonly string[],
  parameters: Record<string, string>,
): string[] {
  const missing = new Set<string>();
  for (const step of steps) {
    for (const match of step.matchAll(PARAM_PLACEHOLDER)) {
      const name = match[1]!;
      // `hasOwn` for the same reason as above: `{{toString}}` would otherwise
      // look resolved and never be reported as left-literal.
      if (!Object.hasOwn(parameters, name)) missing.add(name);
    }
  }
  return [...missing];
}
