/**
 * Which project an MCP call runs against, and everything that project says
 * about itself: its `aiui.config.json`, its skills/tools directories, its
 * composed environment, and the Sessions API it talks to.
 *
 * Confinement (§4a of stories/mcp-server.md) is the security boundary of this
 * server, and it lives here because every path the framework later touches is
 * derived from a decision made in this file. An agent — or a page that
 * prompt-injects one — can name any path on the machine; without confinement
 * the next request would load tool code from it and ship its `.env` to
 * whatever is listening on `SERVER_URL`.
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
import {
  badEnvName,
  badProjectConfig,
  badRootEntry,
  envFileMissing,
  noProjectConfig,
  noServerApiKey,
  noServerUrl,
  pathMustBeAbsolute,
  pathOutsideProjectRoot,
  pathOutsideRoots,
  projectRootUnresolvable,
  testFileMissing,
  type McpToolError,
} from './errors.js';
import { PreflightFailure, type ProjectContext, type ResolveProjectArgs } from './types.js';

const CONFIG_FILENAME = 'aiui.config.json';

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
 * The directories this server may touch, canonicalised.
 *
 * `AIUI_MCP_ROOTS` split on `path.delimiter`, else the process cwd. The env
 * var is required for the machine-global hosts (Codex CLI, Copilot CLI),
 * whose spawn cwd is not the project — for them the host config's `env` block
 * is the only per-server configuration surface there is.
 *
 * Read on every call rather than cached at import: `resolveProject` is the
 * only consumer, it is not hot, and a cached copy would make the value
 * untestable without module resets.
 */
export function allowedRoots(): string[] {
  const configured = process.env['AIUI_MCP_ROOTS'];
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
// aiui.config.json
// ---------------------------------------------------------------------------

/** The handful of fields the MCP reads. Everything is `unknown` because this
 *  is a user-authored file, not a validated `Config`. */
interface RawProjectConfig {
  tests?: { dir?: unknown; pattern?: unknown; skillsDir?: unknown; toolsDir?: unknown };
  cache?: { enabled?: unknown };
  mcp?: { cdp?: { allowUnowned?: unknown; ports?: unknown } };
}

/**
 * Read `aiui.config.json` directly — never `loadConfig`.
 *
 * `loadConfig` folds `process.env` (`AI_API_KEY`, `AI_MODEL`,
 * `SERVER_API_KEY`) into its result and always materialises relative
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
 * Walk up from `startDir` looking for `aiui.config.json`, stopping at `bound`.
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
 * `mcp.cdp` from `aiui.config.json` — the §6 gate's only input.
 *
 * A config file rather than a tool argument on purpose. The existing
 * `allow_foreign_session` precedent has the right shape but is the wrong gate
 * here: an agent sets its own boolean, so it stops accidents, not a page that
 * talks the agent into setting one — and behind this gate sits a browser
 * holding live logged-in sessions. `aiui.config.json` is the only gate a human
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

export function resolveTestsGlob(project: ProjectContext): { dir: string; pattern: string } {
  const config = readProjectConfig(project.configPath);
  const declaredDir = stringField(config.tests?.dir) ?? DEFAULT_CONFIG.tests.dir;
  const pattern = stringField(config.tests?.pattern) ?? DEFAULT_CONFIG.tests.pattern;
  return {
    dir: confinePath(path.resolve(project.projectRoot, declaredDir), allowedRoots()),
    pattern,
  };
}

// ---------------------------------------------------------------------------
// Environment composition (§4)
// ---------------------------------------------------------------------------

/**
 * Everything about a project except which server it talks to.
 *
 * The split exists so `SERVER_URL` and `SERVER_API_KEY` are read exactly once,
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
 * per-server configuration surface a user has, and `AIUI_MCP_ROOTS` is already
 * read from exactly that channel.
 */
function withServerDiscovery(fields: ProjectDraft): ProjectContext {
  const serverUrl = firstNonEmpty(fields.env['SERVER_URL'], process.env['SERVER_URL']);
  if (serverUrl === null) fail(noServerUrl(fields.envFilesConsulted));

  // Its own error rather than a generic one: `serve` hard-exits before binding
  // without a key, so a missing key would otherwise cost a full 20 s
  // auto-start poll and report "the server never became healthy" — which is
  // true, and useless.
  const apiKey = firstNonEmpty(fields.env['SERVER_API_KEY'], process.env['SERVER_API_KEY']);
  if (apiKey === null) fail(noServerApiKey(fields.envFilesConsulted));

  return { ...fields, serverUrl, apiKey };
}

/**
 * §3 step 10: layer `.env.<envName>` over the base map.
 *
 * A separate step because the name may come from the test file's frontmatter,
 * which is not known until the parse — resolving the env any earlier would
 * silently ignore `env: uat` and run the test against the base `.env`: wrong
 * `SERVER_URL`, wrong AI key, wrong interpolation, and rule 6 never applied.
 * Both `serverUrl` and `apiKey` are re-derived, because `.env.uat` may name a
 * different server than `.env` does.
 */
export async function applyEnvName(
  project: ProjectContext,
  envName: string,
  roots: readonly string[] = allowedRoots(),
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
 */
export async function resolveProject(args: ResolveProjectArgs): Promise<ProjectContext> {
  const roots = allowedRoots();

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

  const startDir = selectStartDirectory(testFile, explicitRoot, roots);
  if (startDir === null) fail(projectRootUnresolvable(roots));

  // Step 4. An explicit `project_root` bounds the walk itself: the caller said
  // where their project is, and quietly adopting a *different* root one level
  // up would be a worse answer than the "no config here" error.
  const bound = explicitRoot ?? deepestContainingRoot(startDir, roots) ?? startDir;
  const { configPath, searched } = findConfigUpward(startDir, bound);
  if (configPath === null) fail(noProjectConfig(searched));

  // Steps 5–6. Confined even though the walk was bounded: `fs.existsSync`
  // follows symlinks, so a symlinked `aiui.config.json` inside a root can name
  // a project directory outside it — and everything below (skills, tools,
  // `.env`) is resolved relative to that directory.
  const projectRoot = confinePath(path.dirname(configPath), roots);
  const config = readProjectConfig(configPath);
  const skillsDir = resolveProjectDir(
    config.tests?.skillsDir,
    DEFAULT_CONFIG.tests.skillsDir,
    projectRoot,
    roots,
  );
  const toolsDir = resolveProjectDir(
    config.tests?.toolsDir,
    DEFAULT_CONFIG.tests.toolsDir,
    projectRoot,
    roots,
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
  if (fs.existsSync(baseEnvPath)) confinePath(baseEnvPath, roots);
  const draft: ProjectDraft = {
    projectRoot,
    configPath,
    env: await readDefaultEnvVars(projectRoot),
    envName: null,
    skillsDir,
    toolsDir,
    cacheEnabled: config.cache?.enabled === true,
    envFilesConsulted: [baseEnvPath],
    cdpPermissions: readMcpCdpConfig(config),
  };

  // Step 10 for a tool-supplied name — before the server URL is read, so an
  // overlay that names its own server wins. A frontmatter-derived name is not
  // known until the parse, so `assemble.ts` applies that one afterwards
  // through `applyEnvName`.
  return withServerDiscovery(
    args.envName !== undefined && args.envName !== ''
      ? await layerEnvFile(draft, args.envName, roots)
      : draft,
  );
}
