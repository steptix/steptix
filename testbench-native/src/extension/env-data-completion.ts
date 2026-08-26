/**
 * Completion provider for `${env.X}` / `${data.X.Y}` / `${<source>.X}` /
 * `${envName}` references in test and skill Markdown.
 *
 * Which files feed the suggestions mirrors what the SERVER — the component
 * that actually resolves these references — would load for a run:
 *
 *  - env name: the file's frontmatter `env:` pin when the key is present
 *    (even empty, which pins "no env" — batch-run semantics), else the
 *    workspace EnvSelector. No env → no suggestions at all: a run with no
 *    env selected interpolates nothing, so every offerable reference would
 *    reach the AI as literal text. Known divergence, documented: interactive
 *    single-file runs ignore the frontmatter pin today (only the batch
 *    test-controller forwards it), so a pinned file completes against its
 *    declared env while an interactive Run uses the selector's.
 *  - `env.*`: `<projectRoot>/.env` composed with `<projectRoot>/.env.<name>`
 *    — exactly the two files `resolveEnvBundle` reads on the server, which
 *    resolves them against the aiui.config.json directory with NO walk-up.
 *    (The test-adjacent walked-up `.env` feeds only the client-side `$VAR`
 *    parameter pass, and the server additionally layers its own process env
 *    — unknowable from the editor and not offered.)
 *  - `data.*`: `<dataDir>/<envName>.json` under the same project root,
 *    `dataDir` from `tests.dataDir` (default `data`).
 *  - `<source>.*`: the file's own `dataSources:` frontmatter, paths resolved
 *    against the file's directory (skills additionally interpolate
 *    `${env.X}` / `${envName}` in the path, tests take it literally).
 *
 * Everything is best-effort and silent: a missing or malformed file yields
 * fewer suggestions, never a toast — this runs on keystrokes. File reads are
 * mtime-cached (the `readProjectDirs` convention) since the same files are
 * re-consulted on every trigger while a reference is being typed.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { isTestFile, parseEnv, parseFrontmatter } from 'ai-ui-automation-runner-core';
import { EnvSelector } from './env-selector.js';
import { resolveProjectDirs } from './aiui-config.js';
import { DEFAULT_DATA_DIR } from './aiui-config-parse.js';
import {
  envVarCompletions,
  inFrontmatter,
  namespaceCompletions,
  refContextAt,
  resolveDataTree,
  treeCompletions,
  type DataObject,
  type PlainCompletion,
} from './env-data-completion-core.js';

const ITEM_KINDS: Record<PlainCompletion['kind'], vscode.CompletionItemKind> = {
  namespace: vscode.CompletionItemKind.Module,
  'env-var': vscode.CompletionItemKind.Variable,
  branch: vscode.CompletionItemKind.Struct,
  leaf: vscode.CompletionItemKind.Value,
  'env-name': vscode.CompletionItemKind.Constant,
};

export class EnvDataCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    // Line-local bail first: the provider fires on every '{' and '.' in any
    // markdown file, and almost none of those sit inside an open `${...`.
    // Nothing document-wide runs until this says the cursor does.
    const line = document.lineAt(position.line).text;
    const ref = refContextAt(line, position.character);
    if (!ref) return [];

    const text = document.getText();
    if (!isTestFile(text)) return [];

    const fm = parseFrontmatter(text);
    const isSkill = fm.type === 'skill';
    // In frontmatter, `${...}` only occurs inside a skill's dataSources path,
    // where the runtime accepts `${env.X}` and `${envName}` alone. A test's
    // frontmatter interpolates nothing — offer nothing there.
    const pathPosition = inFrontmatter(text, position.line);
    if (pathPosition && !isSkill) return [];

    // A present `env:` key pins the file — even a blank one, which pins "no
    // env": the batch runner sends the pin verbatim and blank trims to none.
    // Only when the key is absent does the workspace EnvSelector apply.
    const envName =
      (fm.env !== undefined ? fm.env.trim() : EnvSelector.activeEnv()) || null;
    // No env → the run interpolates nothing; completing a reference here
    // would hand the AI literal `${...}` text.
    if (!envName) return [];

    const dirs = resolveProjectDirs(document.uri);
    const workspaceRoot =
      vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ??
      path.dirname(document.uri.fsPath);
    // The server resolves `.env`, `.env.<name>`, and `<dataDir>/<name>.json`
    // against the aiui.config.json directory (= the workspace root in the
    // common layout, which is also where the EnvSelector enumerates).
    const projectRoot = dirs ? path.dirname(dirs.configPath) : workspaceRoot;
    const baseEnvPath = path.join(projectRoot, '.env');
    const overlayPath = path.join(projectRoot, `.env.${envName}`);
    const dataFile = path.resolve(projectRoot, dirs?.dataDir ?? DEFAULT_DATA_DIR, `${envName}.json`);

    if (ref.kind === 'namespace') {
      const envParts = [
        ...(fs.existsSync(baseEnvPath) ? ['.env'] : []),
        ...(fs.existsSync(overlayPath) ? [`.env.${envName}`] : []),
      ];
      const plain = namespaceCompletions({
        envName,
        dataDetail: isSkill
          ? null // skills never see the caller-env data file
          : displayPath(dataFile, projectRoot) + (fs.existsSync(dataFile) ? '' : ' (not found)'),
        sources: Object.entries(fm.dataSources ?? {}).map(([name, declared]) => ({
          name,
          detail: declared,
        })),
        envDetail: envParts.length > 0 ? envParts.join(' + ') : '(no .env found)',
        pathPosition,
      });
      return plain.map((c) => this.toItem(c, position, ref.replaceStart));
    }

    // Dotted-path position. One env map serves every branch below.
    const env = composedEnv(baseEnvPath, overlayPath);

    if (ref.namespace === 'env') {
      // env is a flat namespace: one segment deep, nothing below it.
      const plain = ref.parentPath.length === 0 ? envVarCompletions(env) : [];
      return plain.map((c) => this.toItem(c, position, ref.replaceStart));
    }

    // The remaining namespaces read a JSON tree — resolve which file's.
    let treeFile: string | null = null;
    if (!pathPosition) {
      if (ref.namespace === 'data' && !isSkill) {
        treeFile = dataFile;
      } else {
        const declared = fm.dataSources?.[ref.namespace];
        if (declared !== undefined) {
          treeFile = resolveSourcePath(declared, document.uri.fsPath, isSkill, env, envName);
        }
      }
    }
    if (treeFile === null) return [];
    const tree = readDataJson(treeFile, env);
    return treeCompletions(tree, ref.parentPath, ref.namespace).map((c) =>
      this.toItem(c, position, ref.replaceStart),
    );
  }

  private toItem(
    c: PlainCompletion,
    position: vscode.Position,
    replaceStart: number,
  ): vscode.CompletionItem {
    const item = new vscode.CompletionItem(c.label, ITEM_KINDS[c.kind]);
    if (c.detail !== undefined) item.detail = c.detail;
    if (c.insertText !== undefined) item.insertText = c.insertText;
    item.sortText = c.sortText;
    item.range = new vscode.Range(position.line, replaceStart, position.line, position.character);
    if (c.chain) {
      item.command = { command: 'editor.action.triggerSuggest', title: 'next segment' };
    }
    // A `.` accepts a branch and lands as the next path separator (the `.`
    // trigger then reopens the widget one level deeper). `}` accepts anything
    // completable and closes the reference in one keystroke.
    if (c.kind === 'branch') item.commitCharacters = ['.', '}'];
    if (c.kind === 'leaf' || c.kind === 'env-var' || c.kind === 'env-name') {
      item.commitCharacters = ['}'];
    }
    return item;
  }
}

// ---------------------------------------------------------------------------
// mtime-cached file reads (same idea as readProjectDirs in aiui-config-parse)
// ---------------------------------------------------------------------------

/** Cache keyed by absolute path → { mtimeMs, parsed }. Entries for missing
 *  files are not kept — a stat miss is cheap and the file may appear. */
const parseCache = new Map<string, { mtimeMs: number; value: unknown }>();

/** Read + parse `absPath` through the mtime cache. Returns undefined when
 *  the file is missing, unreadable, or `parse` throws — the lenient shape
 *  every consumer here wants on a keystroke path. */
function readParsedCached<T>(absPath: string, parse: (text: string) => T): T | undefined {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(absPath).mtimeMs;
  } catch {
    parseCache.delete(absPath);
    return undefined;
  }
  const cached = parseCache.get(absPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value as T;
  let value: T;
  try {
    value = parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return undefined;
  }
  parseCache.set(absPath, { mtimeMs, value });
  return value;
}

/** `.env`-format file → map; missing or malformed reads as empty. */
function readEnvLenient(absPath: string): Record<string, string> {
  return readParsedCached(absPath, parseEnv) ?? {};
}

/** Base `.env` + `.env.<name>` overlay composed, overlay winning — the same
 *  relationship `composeEnv` establishes on the run paths. */
function composedEnv(baseEnvPath: string, overlayPath: string): Record<string, string> {
  return { ...readEnvLenient(baseEnvPath), ...readEnvLenient(overlayPath) };
}

/** JSON data file → `$VAR`-resolved tree; missing / bad JSON / non-object
 *  top level all read as "no tree" (undefined → no suggestions). The raw
 *  parse is cached by mtime; `$VAR` resolution runs per call because it
 *  depends on the composed env, and the trees are small. */
function readDataJson(absPath: string, env: Record<string, string>): DataObject | undefined {
  const parsed = readParsedCached<unknown>(absPath, JSON.parse);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  return resolveDataTree(parsed as DataObject, env) as DataObject;
}

/**
 * A declared dataSources path → absolute, the way the parser resolves it:
 * `~` expanded, relative against the declaring file's directory. Skill paths
 * first interpolate `${env.X}` / `${envName}` (test paths are literal); a
 * placeholder that can't resolve makes the source unavailable (null).
 */
function resolveSourcePath(
  declared: string,
  declaringFile: string,
  isSkill: boolean,
  env: Record<string, string>,
  envName: string,
): string | null {
  let p = declared;
  if (isSkill) {
    let failed = false;
    p = p
      .replace(/\$\{\s*envName\s*\}/g, () => envName)
      .replace(/\$\{\s*env\.([A-Za-z0-9_]+)\s*\}/g, (_m, name: string) => {
        const v = env[name];
        if (v === undefined) failed = true;
        return v ?? '';
      });
    if (failed) return null;
  }
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  return path.isAbsolute(p) ? p : path.resolve(path.dirname(declaringFile), p);
}

/** Project-relative display form of an absolute path (forward slashes),
 *  falling back to the absolute path outside the root. */
function displayPath(absPath: string, projectRoot: string): string {
  const rel = path.relative(projectRoot, absPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return absPath;
  return rel.replace(/\\/g, '/');
}
