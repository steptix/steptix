/**
 * Which project an MCP call runs against, and everything that project says
 * about itself: its `steptix.config.json`, its skills/tools directories, its
 * composed environment, and the Sessions API it talks to.
 *
 * Confinement (§4a of stories/mcp-server.md) is the security boundary of this
 * server, and it lives here because every path the framework later touches is
 * derived from a decision made in this file. An agent — or a page that
 * prompt-injects one — can name any path on the machine; without confinement
 * the next request would load tool code from it and ship its `.env` to
 * whatever is listening on `STEPTIX_SERVER_URL`.
 *
 * The rules are deliberately paranoid in ways a `startsWith` check is not:
 * symlinks are followed before comparing, comparison happens on segment
 * boundaries, win32 folds case, the config walk stops at the allowed root
 * rather than the filesystem root, and config-derived paths are re-checked
 * because a project's own JSON is as untrusted as a tool argument.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import { readDefaultEnvVars, readEnvFileVars } from '../env/loader.js';
import { readMachineKey, readUserRootEnv, userRootDir } from '../env/user-root.js';
import {
  badEnvName,
  badProjectConfig,
  badRootEntry,
  envFileMissing,
  noProjectConfig,
  noServerUrl,
  pathMustBeAbsolute,
  pathOutsideProjectRoot,
  pathOutsideRoots,
  projectRootUnresolvable,
  testFileMissing,
  testsNeedProject,
  type McpToolError,
} from './errors.js';
import { PreflightFailure, type ProjectContext, type ResolveProjectArgs } from './types.js';

const CONFIG_FILENAME = 'steptix.config.json';

/**
 * Where a project-less call looks for its Sessions API server when neither the
 * user root's `.env` nor the process environment names one
 * (stories/mcp-no-project.md).
 *
 * Loopback because it must be — auto-start only ever spawns on a loopback host
 * (§5 arm 4) — and a port that is distinctive rather than 3100 because people
 * already run the *project* server there: a project-less call colliding with it
 * would find a server whose key it may not hold, and auto-start would refuse a
 * port that answers with someone else's service.
 */
export const USER_SCOPE_SERVER_URL = 'http://127.0.0.1:3141';

/**
 * §4a rule 6. No separators and no `..`, because `readEnvFileVars` does
 * `path.resolve(projectRoot, '.env.' + envName)` — `../../../secrets` would
 * read an off-root file whose contents we then ship as the request's `env`
 * field, straight into the step interpolation scope.
 */
const ENV_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Every refusal in this module and in `assemble.ts` goes through here, so a
 *  pre-flight failure is always a `PreflightFailure` carrying a §7 message. */
export function fail(error: McpToolError): never {
  throw new PreflightFailure(error);
}

// ---------------------------------------------------------------------------
// Roots confinement (§4a)
// ---------------------------------------------------------------------------

/**
 * The roots a *project* may be selected from, canonicalised.
 *
 * `STEPTIX_MCP_ROOTS` split on `path.delimiter`, else the process cwd. The env
 * var is required for the machine-global hosts (Codex CLI, Copilot CLI),
 * whose spawn cwd is not the project — for them the host config's `env` block
 * is the only per-server configuration surface there is.
 *
 * Read on every call rather than cached at import: it is not hot, and a
 * cached copy would make the value untestable without module resets.
 *
 * Deliberately does NOT include the user root, and the split against
 * `allowedRoots` is the answer to a question stories/mcp-no-project.md left
 * open: a `STEPTIX_MCP_ROOTS` naming exactly one directory keeps implying
 * "that's the project" (the machine-global hosts depend on it), because the
 * user root joins the *allow-list*, never the candidate list. It is the
 * fallback when the configured world has no config, not a project that
 * competes with them.
 */
export function configuredRoots(): string[] {
  const configured = process.env['STEPTIX_MCP_ROOTS'];
  const entries =
    configured !== undefined && configured.trim() !== ''
      ? configured
          .split(path.delimiter)
          .map((entry) => entry.trim())
          .filter((entry) => entry !== '')
      : [process.cwd()];

  return entries.map((entry) => {
    try {
      const real = fs.realpathSync.native(path.resolve(entry));
      // A file-valued entry would make the boundary meaningless: nothing can
      // live *inside* a file, so the first path checked against it fails,
      // `deepestContainingRoot` returns null, and the config walk's bound
      // degrades to the start directory — outside the allow-list.
      if (!fs.statSync(real).isDirectory()) {
        fail(badRootEntry(entry, 'it is not a directory'));
      }
      return real;
    } catch (err) {
      if (err instanceof PreflightFailure) throw err;
      // A root that does not exist cannot be an allow-list entry: silently
      // dropping it would quietly widen or narrow the boundary depending on
      // which other entries survived.
      fail(badRootEntry(entry, (err as Error).message));
    }
  });
}

/** The user root, canonicalised the missing-tolerant way. `canonicalize`
 *  rather than the realpath+stat the configured entries get: the directory is
 *  created on first use, and a machine that has never made a project-less
 *  call must not fail every *project* call over its absence. */
function canonicalUserRoot(): string {
  return canonicalize(userRootDir());
}

/**
 * The directories this server may touch: the configured roots plus —
 * implicitly, always — the user root.
 *
 * The implicit entry is not optional plumbing (stories/mcp-no-project.md):
 * `confinePath` is the security boundary of this server, and a user root
 * outside the allowed set would be refused by the very next call after any
 * user-scope resolution.
 */
export function allowedRoots(): string[] {
  const configured = configuredRoots();
  const userRoot = canonicalUserRoot();
  if (configured.some((root) => comparable(root) === comparable(userRoot))) {
    return configured;
  }
  return [...configured, userRoot];
}

/** win32 compares case-insensitively; every other platform does not. */
function comparable(target: string): string {
  return process.platform === 'win32' ? target.toLowerCase() : target;
}

/**
 * True when `target` is `root` or lives underneath it.
 *
 * The separator is not decoration: a bare `startsWith` accepts `C:\proj-evil`
 * for an allow-list of `C:\proj`.
 */
export function isInsideRoot(target: string, root: string): boolean {
  const t = comparable(target);
  const r = comparable(root);
  if (t === r) return true;
  return t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/**
 * `fs.realpathSync.native` for a path that may not exist yet.
 *
 * Canonicalises the deepest existing ancestor and re-joins the missing tail.
 * Falling back to a plain `path.resolve` would let `<root>/link/missing.json`
 * compare as inside the root purely because its leaf is absent, even though
 * `link` points at `/etc` — the symlink one level up is exactly the hole rule
 * 1 exists to close. `.native` additionally folds win32 case and 8.3 short
 * names (`C:\PROJ~1`).
 */
export function canonicalize(target: string): string {
  let current = path.resolve(target);
  const missingTail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...missingTail);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...missingTail);
      missingTail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Canonicalise and assert the result sits inside one of `roots`. Missing
 *  paths are allowed through (the caller decides whether absence is fatal);
 *  an escape is refused whether the target exists or not. */
export function confinePath(
  target: string,
  roots: readonly string[],
  displayPath = target,
): string {
  const real = canonicalize(target);
  if (!roots.some((root) => isInsideRoot(real, root))) {
    fail(pathOutsideRoots(displayPath, roots));
  }
  return real;
}

/**
 * §3 steps 1–2 for `run_test_file`: refuse a relative path, then canonicalise
 * it — which doubles as the missing-file detector and must run before any
 * read. Exported because `assemble.ts` needs the canonical path for
 * `parseTestContent`, the report name and every `frame.uri`, and there must be
 * exactly one place that maps `ENOENT` onto §7's wording.
 */
export function canonicalTestFilePath(target: string): string {
  if (!path.isAbsolute(target)) fail(pathMustBeAbsolute(target));
  try {
    return fs.realpathSync.native(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') fail(testFileMissing(target));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// steptix.config.json
// ---------------------------------------------------------------------------

/** The handful of fields the MCP reads. Everything is `unknown` because this
 *  is a user-authored file, not a validated `Config`. */
interface RawProjectConfig {
  tests?: { dir?: unknown; pattern?: unknown; skillsDir?: unknown; toolsDir?: unknown };
  mcp?: { cdp?: { allowUnowned?: unknown; ports?: unknown } };
  desktop?: { reportScreenshots?: unknown };
}

/**
 * Read `steptix.config.json` directly — never `loadConfig`.
 *
 * `loadConfig` folds `process.env` (`AI_API_KEY`, `AI_MODEL`,
 * `STEPTIX_SERVER_API_KEY`) into its result and always materialises relative
 * `tests.skillsDir`/`toolsDir`, so "the project's config" would silently
 * include the MCP host process's environment. The ban is on the loader, not
 * on its default literals — those are reused below.
 */
function readProjectConfig(configPath: string): RawProjectConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err) {
    fail(badProjectConfig(configPath, (err as Error).message));
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(badProjectConfig(configPath, 'the file does not contain a JSON object'));
    }
    return parsed as RawProjectConfig;
  } catch (err) {
    if (err instanceof PreflightFailure) throw err;
    fail(badProjectConfig(configPath, (err as Error).message));
  }
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Walk up from `startDir` looking for `steptix.config.json`, stopping at `bound`.
 *
 * The bound is §4a rule 4 and it is load-bearing: the server's own
 * `resolveProjectRoot` walks 50 levels to the filesystem root, which here
 * would land *outside* confinement and pull `skillsDir`, `toolsDir` and `.env`
 * from there — a straight bypass of everything above.
 */
function findConfigUpward(
  startDir: string,
  bound: string,
): { configPath: string | null; searched: string[] } {
  const searched: string[] = [];
  let dir = startDir;
  for (;;) {
    searched.push(dir);
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) return { configPath: candidate, searched };
    if (comparable(dir) === comparable(bound)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { configPath: null, searched };
}

/**
 * `skillsDir` / `toolsDir`: the declared value, else the `defaults.ts`
 * literal, resolved absolute, re-confined, and returned only when it exists.
 *
 * The literal fallback is required rather than tidy. A project that omits
 * `tests.skillsDir` but *has* `./skills` would otherwise be sent no skills
 * directory at all, and every `[skill: x]` line would ship to the AI as prose
 * — a silent, expensive wrong answer. (This repo's own config declares both,
 * so a live smoke test would never catch it.)
 *
 * The confinement check runs even when the directory is absent: a config
 * saying `"toolsDir": "../../../x"` is a refusal, not a shrug, whether or not
 * `x` happens to exist today.
 */
function resolveProjectDir(
  declared: unknown,
  fallback: string,
  projectRoot: string,
  roots: readonly string[],
): string | null {
  const value = stringField(declared) ?? fallback;
  const resolved = confinePath(path.resolve(projectRoot, value), roots);
  return fs.existsSync(resolved) ? resolved : null;
}

/**
 * `tests.dir` + `tests.pattern` for `list_test_files`, with `tests.dir`
 * confined per §4a rule 5.
 *
 * Not part of `ProjectContext` because nothing on the run path needs it, but
 * it belongs here: this is the only module that knows how to read the config
 * and where the allowed roots are.
 */
/**
 * `mcp.cdp` from `steptix.config.json` — the §6 gate's only input.
 *
 * A config file rather than a tool argument on purpose. The existing
 * `allow_foreign_session` precedent has the right shape but is the wrong gate
 * here: an agent sets its own boolean, so it stops accidents, not a page that
 * talks the agent into setting one — and behind this gate sits a browser
 * holding live logged-in sessions. `steptix.config.json` is the only gate a human
 * actually holds, and an agent cannot write it.
 *
 * Read here rather than through `loadConfig` for the same reason everything
 * else in this module is: the loader folds `process.env` in, so "the project's
 * config" would silently include the MCP host's environment.
 *
 * Absent, malformed or wrongly-typed values all read as "not permitted".
 * Widening reach is an explicit act, so anything ambiguous stays closed.
 */
function readMcpCdpConfig(config: RawProjectConfig): {
  allowUnowned: boolean;
  ports: number[] | null;
} {
  const cdp = config.mcp?.cdp;
  const ports = Array.isArray(cdp?.ports)
    ? cdp.ports.filter(
        (p): p is number => typeof p === 'number' && Number.isInteger(p) && p > 0 && p <= 65535,
      )
    : null;
  return {
    allowUnowned: cdp?.allowUnowned === true,
    ports: ports && ports.length > 0 ? ports : null,
  };
}

/**
 * `desktop.reportScreenshots` from `steptix.config.json` — whether a computer-mode
 * capture may leave the run (docs/specs/SPEC-use-computer.md §10.1).
 *
 * The switch is written for the report, and this module applies it to the one
 * other place a capture can go: back to the agent as an image. A desktop
 * capture is the whole screen — whatever else is open on it — and the tool
 * result puts it in a conversation transcript, so the author who kept it out
 * of the report has kept it out of here too.
 *
 * Only the JSON boolean `true` or an absent key allows it. Anything else —
 * `false`, or a value of the wrong type, which the server's loader refuses
 * outright — withholds it: this is a privacy switch, and the ambiguous reading
 * is the closed one.
 */
function readDesktopScreenshots(config: RawProjectConfig): boolean {
  const value = config.desktop?.reportScreenshots;
  return value === undefined || value === true;
}

export function resolveTestsGlob(project: ProjectContext): { dir: string; pattern: string } {
  const config = readProjectConfig(project.configPath);
  const declaredDir = stringField(config.tests?.dir) ?? DEFAULT_CONFIG.tests.dir;
  const pattern = stringField(config.tests?.pattern) ?? DEFAULT_CONFIG.tests.pattern;
  return {
    // Confined against the CONFIGURED roots, not `allowedRoots()`: this only
    // runs for `list_test_files`, which requires a project, and a project's
    // `tests.dir` must not be allowed to point into the user root that joined
    // the addressing allow-list.
    dir: confinePath(path.resolve(project.projectRoot, declaredDir), configuredRoots()),
    pattern,
  };
}

// ---------------------------------------------------------------------------
// Environment composition (§4)
// ---------------------------------------------------------------------------

/**
 * Everything about a project except which server it talks to.
 *
 * The split exists so `STEPTIX_SERVER_URL` and `STEPTIX_SERVER_API_KEY` are read exactly once,
 * *after* any `.env.<name>` overlay: an overlay may name a different server
 * than the base `.env` does, and checking before it lands would both refuse a
 * project whose URL lives only in the overlay and report the wrong file in the
 * message.
 */
type ProjectDraft = Omit<ProjectContext, 'serverUrl' | 'apiKey'>;

function firstNonEmpty(...values: (string | undefined)[]): string | null {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * Derive `serverUrl` / `apiKey` from a composed map and package the result.
 *
 * `process.env` is **not** a baseline for the map — following
 * `resolveEnvBundle`, which seeds itself with the whole environment, would
 * ship the MCP host's entire environment to the server as the request's `env`
 * field and into any child we spawn. But these two keys specifically do fall
 * back to `process.env`, at lowest precedence and without ever entering the
 * map: for Codex CLI and Copilot CLI the host config's `env` block is the only
 * per-server configuration surface a user has, and `STEPTIX_MCP_ROOTS` is already
 * read from exactly that channel.
 *
 * User scope gets one extra rung: a missing `STEPTIX_SERVER_URL` defaults to
 * {@link USER_SCOPE_SERVER_URL} instead of failing. A project must say which
 * server it means — its `.env` is a file someone wrote — but project-less mode
 * exists precisely for the directory with no files in it, so "nothing
 * configured" has to resolve to something startable.
 */
function withServerDiscovery(fields: ProjectDraft): ProjectContext {
  const serverUrl =
    firstNonEmpty(fields.env['STEPTIX_SERVER_URL'], process.env['STEPTIX_SERVER_URL']) ??
    (fields.scope === 'user' ? USER_SCOPE_SERVER_URL : null);
  if (serverUrl === null) fail(noServerUrl(fields.envFilesConsulted));

  // The client chain of stories/machine-key.md: project `.env` → environment
  // → the machine key. A miss on all three is NOT failed here — only
  // `server-start.ts` can decide what it means, because the answer depends on
  // the server's state: down + loopback may generate a key and spawn with it,
  // while a running server means a refusal naming the file to write.
  const apiKey = firstNonEmpty(
    fields.env['STEPTIX_SERVER_API_KEY'],
    process.env['STEPTIX_SERVER_API_KEY'],
    readMachineKey() ?? undefined,
  );

  return { ...fields, serverUrl, apiKey };
}

/**
 * §3 step 10: layer `.env.<envName>` over the base map.
 *
 * A separate step because the name may come from the test file's frontmatter,
 * which is not known until the parse — resolving the env any earlier would
 * silently ignore `env: uat` and run the test against the base `.env`: wrong
 * `STEPTIX_SERVER_URL`, wrong AI key, wrong interpolation, and rule 6 never applied.
 * Both `serverUrl` and `apiKey` are re-derived, because `.env.uat` may name a
 * different server than `.env` does.
 */
export async function applyEnvName(
  project: ProjectContext,
  envName: string,
  // Defaults to the project confinement boundary. This is reached only for a
  // frontmatter-declared env on a test file, which is always project scope —
  // the user root, on the addressing allow-list, is deliberately not here.
  roots: readonly string[] = configuredRoots(),
): Promise<ProjectContext> {
  return withServerDiscovery(await layerEnvFile(project, envName, roots));
}

async function layerEnvFile(
  project: ProjectDraft,
  envName: string,
  roots: readonly string[],
): Promise<ProjectDraft> {
  if (!ENV_NAME_PATTERN.test(envName)) fail(badEnvName(envName));

  const envFilePath = path.resolve(project.projectRoot, `.env.${envName}`);
  // The name is charset-checked above, so this cannot escape by construction —
  // but a *symlinked* `.env.uat` still can, and its parsed contents would be
  // shipped as the request's `env`. Rule 6 says confine the resolved file too.
  const real = canonicalize(envFilePath);
  if (!fs.existsSync(real)) {
    // `readEnvFileVars`'s own wording, verbatim, so §7's row and the loader
    // never drift apart.
    fail(envFileMissing(`Environment file not found: ${envFilePath}`));
  }
  confinePath(real, roots, envFilePath);

  const overlay = await readEnvFileVars(envName, project.projectRoot);
  return {
    ...project,
    env: { ...project.env, ...overlay },
    envName,
    envFilesConsulted: [...project.envFilesConsulted, envFilePath],
  };
}

// ---------------------------------------------------------------------------
// User scope (stories/mcp-no-project.md)
// ---------------------------------------------------------------------------

/**
 * Resolve against the user root instead of a project.
 *
 * The user root is a real root, not a special case: same config filename, same
 * malformed-config refusal, same `.env.<name>` overlay mechanics. The
 * deliberate differences are exactly the story's locked decisions:
 *
 *  - `skillsDir`/`toolsDir` are null even if directories by those names exist
 *    there. A machine-global tools directory would mean any conversation, in
 *    any directory, can execute code from a path no repo owns and no review
 *    covers — so it is never consulted, not merely defaulted away.
 *  - The `.env` is read directly (`readUserRootEnv`), never by the project
 *    walk-up read: walking up from `%LOCALAPPDATA%\steptix` would adopt stray
 *    `.env` files in `%LOCALAPPDATA%` or the home directory as ours.
 *  - An absent `steptix.config.json` reads as all-defaults, because nothing may
 *    create it. The resolved path is still recorded: it is the file a human
 *    would have to write to set `mcp.cdp.allowUnowned`, and refusals name it.
 */
async function resolveUserScope(
  args: ResolveProjectArgs,
  searched: readonly string[],
): Promise<ProjectContext> {
  const userRoot = canonicalUserRoot();
  const configPath = path.join(userRoot, CONFIG_FILENAME);
  const config = fs.existsSync(configPath) ? readProjectConfig(configPath) : {};

  let draft: ProjectDraft = {
    scope: 'user',
    configSearch: searched,
    projectRoot: userRoot,
    configPath,
    env: readUserRootEnv(),
    envName: null,
    skillsDir: null,
    toolsDir: null,
    envFilesConsulted: [path.join(userRoot, '.env')],
    cdpPermissions: readMcpCdpConfig(config),
    desktopScreenshots: readDesktopScreenshots(config),
  };

  if (args.envName !== undefined && args.envName !== '') {
    // Confined against the user root alone. A user-scope `.env.<name>` lives
    // under the user root by definition, and confining against anything wider
    // would let a symlinked overlay reach off it.
    draft = await layerEnvFile(draft, args.envName, [userRoot]);
  }
  return withServerDiscovery(draft);
}

// ---------------------------------------------------------------------------
// project_root selection + resolution
// ---------------------------------------------------------------------------

/** The most specific allowed root containing `target`, or null. Deepest wins
 *  so nested roots bound the config walk as tightly as possible. */
function deepestContainingRoot(target: string, roots: readonly string[]): string | null {
  let best: string | null = null;
  for (const root of roots) {
    if (isInsideRoot(target, root) && (best === null || root.length > best.length)) {
      best = root;
    }
  }
  return best;
}

/**
 * §4a's `project_root` selection, which is a different question from the
 * allow-list: *which* project are we in, given that the answer may be a
 * subdirectory of an allowed root. Four branches in order, then failure.
 *
 * `run_test_file` always takes the first: the file's own directory anchors the
 * walk, so naming a file in project B while sitting in project A does the
 * obvious thing rather than running B's test with A's environment.
 */
function selectStartDirectory(
  testFile: string | null,
  explicitRoot: string | null,
  roots: readonly string[],
): string | null {
  if (testFile !== null) return path.dirname(testFile);
  if (explicitRoot !== null) return explicitRoot;
  const cwd = canonicalize(process.cwd());
  if (deepestContainingRoot(cwd, roots) !== null) return cwd;
  return roots.length === 1 ? roots[0]! : null;
}

/**
 * §3 steps 1–7 (plus step 10 when the tool supplied `env_name`).
 *
 * Order is pinned by the spec and is not cosmetic: the naive version reads
 * files before it is allowed to, and resolves the environment before it knows
 * which environment to use.
 *
 * Two root lists are in play and they answer different questions.
 * `allowedRoots()` — which includes the user root — is what every path is
 * confined against. `configuredRoots()` is what a *project* may be selected
 * from: the user root never implies a project, it is where resolution lands
 * when no project does (stories/mcp-no-project.md). Selecting from the wider
 * list would break the machine-global hosts, whose single `STEPTIX_MCP_ROOTS`
 * entry must keep meaning "that's the project".
 */
export async function resolveProject(args: ResolveProjectArgs): Promise<ProjectContext> {
  const roots = allowedRoots();
  const selection = configuredRoots();

  // Steps 1–3. `canonicalTestFilePath` refuses a relative path and turns a
  // missing one into §7's row before anything reads a byte.
  const testFile =
    args.testFilePath !== undefined ? canonicalTestFilePath(args.testFilePath) : null;
  if (testFile !== null) confinePath(testFile, roots, args.testFilePath!);

  // `''` is an absent argument, not the current directory — `path.resolve('')`
  // would silently adopt cwd as the project.
  const explicitRootArg = args.projectRoot?.trim() || undefined;
  const explicitRoot =
    explicitRootArg !== undefined ? confinePath(explicitRootArg, roots) : null;
  if (testFile !== null && explicitRoot !== null && !isInsideRoot(testFile, explicitRoot)) {
    fail(pathOutsideProjectRoot(args.testFilePath!, explicitRoot));
  }

  const startDir = selectStartDirectory(testFile, explicitRoot, selection);
  if (startDir === null) {
    // Several configured roots and nothing to choose between them. A tool that
    // *needs* a project keeps today's refusal; everything else resolves
    // project-less — the caller was not talking about any of those projects,
    // which is exactly the situation the user root exists for. The result
    // carries `scope: 'user'`, so the landing is reported, never silent.
    if (args.requireProject === true) fail(projectRootUnresolvable(selection));
    return resolveUserScope(args, []);
  }

  // Step 4. An explicit `project_root` bounds the walk itself: the caller said
  // where their project is, and quietly adopting a *different* root one level
  // up would be a worse answer than the "no config here" error.
  const bound = explicitRoot ?? deepestContainingRoot(startDir, selection) ?? startDir;
  const { configPath, searched } = findConfigUpward(startDir, bound);
  if (configPath === null) {
    // No project. For the project-shaped tools that is still a refusal —
    // test files, skills and tools have no user-scope meaning. For everything
    // else it is the fallback the story exists for, with `searched` carried so
    // messages can say why there was no project.
    if (args.requireProject === true) fail(noProjectConfig(searched));
    return resolveUserScope(args, searched);
  }

  // Where the config sits, canonicalised — `fs.existsSync` follows symlinks,
  // so a symlinked `steptix.config.json` inside a root can name a directory
  // outside it, and everything below (skills, tools, `.env`) is resolved
  // relative to this.
  const projectRootReal = canonicalize(path.dirname(configPath));

  // The walk can legitimately land ON the user root — the host's cwd may be
  // inside it, or the caller may pass it as `project_root` (which is how
  // `scope: "user"` addressing arrives here). It then takes the user-scope
  // path REGARDLESS of what the directory contains: someone dropping a
  // `skills/` directory into the user root must not turn every project-less
  // conversation into one that executes it. Checked BEFORE the project
  // confinement below, because the user root is on the addressing allow-list
  // but not among the configured roots that project files load from.
  if (comparable(projectRootReal) === comparable(canonicalUserRoot())) {
    if (args.requireProject === true) fail(testsNeedProject(projectRootReal));
    return resolveUserScope(args, []);
  }

  // A real project. Confine — and load every project file — against the
  // CONFIGURED roots, NOT `allowedRoots()`. The user root joined the
  // addressing allow-list so `project_root: <userRoot>` could route to user
  // scope (above); letting it also widen where a project's own untrusted
  // `steptix.config.json`, `.env` symlink or `dataSources` may reach would hand
  // that config a path into `%LOCALAPPDATA%\steptix` — the machine key, and a
  // skills/tools directory no repo owns. `selection` restores the pre-story
  // boundary exactly. A planted config in a user-root SUBDIRECTORY named via
  // `project_root` fails here rather than loading as a project.
  const projectRoot = confinePath(path.dirname(configPath), selection);
  const config = readProjectConfig(configPath);
  const skillsDir = resolveProjectDir(
    config.tests?.skillsDir,
    DEFAULT_CONFIG.tests.skillsDir,
    projectRoot,
    selection,
  );
  const toolsDir = resolveProjectDir(
    config.tests?.toolsDir,
    DEFAULT_CONFIG.tests.toolsDir,
    projectRoot,
    selection,
  );

  // Step 7 — the base `.env` only.
  //
  // Confined like `.env.<name>` is. The earlier reasoning — "no caller-supplied
  // component in this path" — looked at the wrong thing: the attacker-supplied
  // part is the *symlink*, not the path string. Anyone able to write inside an
  // allowed root (which a prompt-injected agent in a workspace is) could point
  // `.env` at `~/.aws/credentials`; it would be parsed as KEY=VALUE, sent as
  // the request's `env`, interpolated into step text, and written into the
  // report. Only checked when it exists — an absent `.env` is legal.
  const baseEnvPath = path.join(projectRoot, '.env');
  if (fs.existsSync(baseEnvPath)) confinePath(baseEnvPath, selection);
  const draft: ProjectDraft = {
    scope: 'project',
    configSearch: [],
    projectRoot,
    configPath,
    env: await readDefaultEnvVars(projectRoot),
    envName: null,
    skillsDir,
    toolsDir,
    envFilesConsulted: [baseEnvPath],
    cdpPermissions: readMcpCdpConfig(config),
    desktopScreenshots: readDesktopScreenshots(config),
  };

  // Step 10 for a tool-supplied name — before the server URL is read, so an
  // overlay that names its own server wins. A frontmatter-derived name is not
  // known until the parse, so `assemble.ts` applies that one afterwards
  // through `applyEnvName`.
  return withServerDiscovery(
    args.envName !== undefined && args.envName !== ''
      ? await layerEnvFile(draft, args.envName, selection)
      : draft,
  );
}
