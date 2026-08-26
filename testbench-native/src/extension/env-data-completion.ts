/**
 * Completion provider for `${env.X}` / `${data.X.Y}` / `${<source>.X}` /
 * `${envName}` references in test and skill Markdown.
 *
 * Which files feed the suggestions mirrors what a run would load:
 *
 *  - env name: the file's frontmatter `env:` pin, else the workspace
 *    EnvSelector — the same precedence the batch runner applies.
 *  - `data.*`: `<dataDir>/<envName>.json` under the project root (the
 *    `aiui.config.json` directory, where the server resolves it), `dataDir`
 *    from `tests.dataDir` (default `data`).
 *  - `env.*`: the walked-up base `.env` + the `.env.<name>` overlay — the
 *    same two files the run composes (the server adds its own process env on
 *    top; those keys are unknowable from the editor and not offered).
 *  - `<source>.*`: the file's own `dataSources:` frontmatter, paths resolved
 *    against the file's directory (skills additionally interpolate
 *    `${env.X}` / `${envName}` in the path, tests take it literally).
 *
 * Everything is best-effort and silent: a missing or malformed file yields
 * fewer suggestions, never a toast — this runs on keystrokes.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  composeEnv,
  isTestFile,
  parseEnv,
  parseFrontmatter,
  resolveEnvFile,
} from 'ai-ui-automation-runner-core';
import { EnvSelector } from './env-selector.js';
import { resolveProjectDirs } from './aiui-config.js';
import {
  envVarCompletions,
  inFrontmatter,
  namespaceCompletions,
  refContextAt,
  resolveDataTree,
  treeCompletions,
  type DataObject,
  type DataValue,
  type PlainCompletion,
} from './env-data-completion-core.js';

/** Default data directory when `tests.dataDir` is undeclared — the loader's. */
const DEFAULT_DATA_DIR = 'data';

const ITEM_KINDS: Record<PlainCompletion['kind'], vscode.CompletionItemKind> = {
  namespace: vscode.CompletionItemKind.Module,
  'env-var': vscode.CompletionItemKind.Variable,
  branch: vscode.CompletionItemKind.Struct,
  leaf: vscode.CompletionItemKind.Value,
  'env-name': vscode.CompletionItemKind.Constant,
};

export class EnvDataCompletionProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    const text = document.getText();
    if (!isTestFile(text)) return [];

    const line = document.lineAt(position.line).text;
    const ref = refContextAt(line, position.character);
    if (!ref) return [];

    const fm = parseFrontmatter(text);
    const isSkill = fm.type === 'skill';
    // In frontmatter, `${...}` only occurs inside a skill's dataSources path,
    // where the runtime accepts `${env.X}` and `${envName}` alone. A test's
    // frontmatter interpolates nothing — offer nothing there.
    const pathPosition = inFrontmatter(text, position.line);
    if (pathPosition && !isSkill) return [];

    // Frontmatter `env:` pins the file (batch semantics); the selector
    // otherwise. Matches `envForThisTest` in test-controller.ts.
    const envName = (fm.env?.trim() || EnvSelector.activeEnv()) || null;

    const dirs = resolveProjectDirs(document.uri);
    const workspaceRoot =
      vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ??
      path.dirname(document.uri.fsPath);
    // Where the server resolves `.env.<name>` and `<dataDir>/<name>.json`:
    // the aiui.config.json directory (= the workspace root in the common
    // layout, which is also where the EnvSelector enumerates).
    const projectRoot = dirs ? path.dirname(dirs.configPath) : workspaceRoot;
    const dataDirRel = dirs?.dataDir ?? DEFAULT_DATA_DIR;
    const dataFile = envName
      ? path.resolve(projectRoot, dataDirRel, `${envName}.json`)
      : null;
    const sources = Object.entries(fm.dataSources ?? {});

    if (ref.kind === 'namespace') {
      const overlayExists =
        envName !== null && fs.existsSync(path.join(projectRoot, `.env.${envName}`));
      const baseEnvPath = await this.resolveBaseEnvPath(document.uri.fsPath, workspaceRoot);
      const envDetail =
        baseEnvPath === null && !overlayExists
          ? '(no .env found)'
          : [
              ...(baseEnvPath !== null ? [path.basename(baseEnvPath)] : []),
              ...(overlayExists ? [`.env.${envName}`] : []),
            ].join(' + ');
      const plain = namespaceCompletions({
        envName,
        isSkill,
        dataDetail:
          dataFile === null
            ? null
            : displayPath(dataFile, projectRoot) + (fs.existsSync(dataFile) ? '' : ' (not found)'),
        sources: sources.map(([name, declared]) => ({ name, detail: declared })),
        envDetail,
        pathPosition,
      });
      return plain.map((c) => this.toItem(c, position, ref.replaceStart));
    }

    // Dotted-path position — resolve the one namespace being completed.
    let plain: PlainCompletion[] = [];
    if (ref.namespace === 'env') {
      plain = envVarCompletions(await this.loadEnvMap(document.uri.fsPath, workspaceRoot, projectRoot, envName));
    } else if (!pathPosition && ref.namespace === 'data' && !isSkill && dataFile !== null) {
      const env = await this.loadEnvMap(document.uri.fsPath, workspaceRoot, projectRoot, envName);
      plain = treeCompletions(readDataJson(dataFile, env), ref.parentPath, ['data']);
    } else {
      const declared = !pathPosition ? fm.dataSources?.[ref.namespace] : undefined;
      if (declared !== undefined) {
        const env = await this.loadEnvMap(document.uri.fsPath, workspaceRoot, projectRoot, envName);
        const abs = resolveSourcePath(declared, document.uri.fsPath, isSkill, env, envName);
        plain = abs === null
          ? []
          : treeCompletions(readDataJson(abs, env), ref.parentPath, [ref.namespace]);
      }
    }
    return plain.map((c) => this.toItem(c, position, ref.replaceStart));
  }

  /** Base `.env` the run would use — same walk-up + fallback as the runner. */
  private async resolveBaseEnvPath(
    testFile: string,
    workspaceRoot: string,
  ): Promise<string | null> {
    const fallbackPath =
      vscode.workspace.getConfiguration('testbench-native').get<string>('defaultEnvFile') ?? '';
    const resolution = await resolveEnvFile({ testFile, workspaceRoot, fallbackPath });
    return resolution.hit ? resolution.path : null;
  }

  /** Composed base `.env` + `.env.<name>` overlay, both read leniently. */
  private async loadEnvMap(
    testFile: string,
    workspaceRoot: string,
    projectRoot: string,
    envName: string | null,
  ): Promise<Record<string, string>> {
    const basePath = await this.resolveBaseEnvPath(testFile, workspaceRoot);
    const base = basePath !== null ? readEnvLenient(basePath) : {};
    const overlay =
      envName !== null ? readEnvLenient(path.join(projectRoot, `.env.${envName}`)) : {};
    return composeEnv(base, overlay);
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

/** `.env`-format file → map; missing or malformed reads as empty. */
function readEnvLenient(absPath: string): Record<string, string> {
  try {
    return parseEnv(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return {};
  }
}

/** JSON data file → `$VAR`-resolved tree; missing / bad JSON / non-object
 *  top level all read as "no tree" (undefined → no suggestions). */
function readDataJson(absPath: string, env: Record<string, string>): DataObject | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  return resolveDataTree(parsed as DataValue, env) as DataObject;
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
  envName: string | null,
): string | null {
  let p = declared;
  if (isSkill) {
    let failed = false;
    p = p
      .replace(/\$\{\s*envName\s*\}/g, () => {
        if (envName === null) failed = true;
        return envName ?? '';
      })
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
