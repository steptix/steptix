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
 * The same provider serves the `{{name}}` half — the *runtime* variables a run
 * fills in per step. That side reads no data files at all: its names come from
 * the document's own `## Parameters` bullets (previewed `$VAR`-resolved against
 * the same composed env, masked by the same secret rule) and from the captures
 * earlier steps write. Its one gate difference is deliberate — `{{}}` resolves
 * with no env selected, so unlike `${...}` it is offered anyway, composing the
 * base `.env` alone.
 *
 * Everything is best-effort and silent: a missing or malformed file yields
 * fewer suggestions, never a toast — this runs on keystrokes. File reads are
 * mtime-cached (the `readProjectDirs` convention) since the same files are
 * re-consulted on every trigger while a reference is being typed.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  classifyLines,
  isTestFile,
  parseFrontmatter,
  parseParameters,
  resolveSection,
} from 'ai-ui-automation-runner-core';
import { DEFAULT_DATA_DIR } from './aiui-config-parse.js';
import {
  activeEnvFor,
  composedEnv,
  displayPath,
  envPaths,
  readDataJson,
  resolveSourcePath,
} from './env-data-resolve.js';
import {
  captureNamesBefore,
  envVarCompletions,
  inFrontmatter,
  namespaceCompletions,
  paramCompletions,
  paramContextAt,
  refContextAt,
  treeCompletions,
  type PlainCompletion,
} from './env-data-completion-core.js';

const ITEM_KINDS: Record<PlainCompletion['kind'], vscode.CompletionItemKind> = {
  namespace: vscode.CompletionItemKind.Module,
  'env-var': vscode.CompletionItemKind.Variable,
  branch: vscode.CompletionItemKind.Struct,
  leaf: vscode.CompletionItemKind.Value,
  'env-name': vscode.CompletionItemKind.Constant,
  parameter: vscode.CompletionItemKind.Variable,
  capture: vscode.CompletionItemKind.Reference,
};

/** Kinds that finish a whole reference rather than a path segment, so `}`
 *  accepts and closes it in one keystroke — every `${...}` leaf, and every
 *  flat `{{...}}` name. */
const CLOSES_WITH_BRACE: ReadonlySet<PlainCompletion['kind']> = new Set([
  'leaf',
  'env-var',
  'env-name',
  'parameter',
  'capture',
]);

export class EnvDataCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    // Line-local bail first: the provider fires on every '{' and '.' in any
    // markdown file, and almost none of those sit inside an open reference.
    // Nothing document-wide runs until one of these two probes — both
    // line-local — says the cursor does.
    const line = document.lineAt(position.line).text;
    const ref = refContextAt(line, position.character);
    if (!ref) {
      // Not a `${...}` reference — the other half of the grammar, `{{name}}`,
      // is the remaining possibility. (`${{` lands here too: the parse above
      // rejects it, and the runtime does find a `{{name}}` inside it.)
      const param = paramContextAt(line, position.character);
      return param ? this.paramItems(document, position, param.replaceStart) : [];
    }

    const text = document.getText();
    if (!isTestFile(text)) return [];

    const fm = parseFrontmatter(text);
    const isSkill = fm.type === 'skill';
    // In frontmatter, `${...}` only occurs inside a skill's dataSources path,
    // where the runtime accepts `${env.X}` and `${envName}` alone. A test's
    // frontmatter interpolates nothing — offer nothing there.
    const pathPosition = inFrontmatter(text, position.line);
    if (pathPosition && !isSkill) return [];

    const envName = activeEnvFor(fm);
    // No env → the run interpolates nothing; completing a reference here
    // would hand the AI literal `${...}` text. (`{{...}}` above is deliberately
    // not behind this gate: it resolves without an env.)
    if (!envName) return [];

    const { dirs, projectRoot, baseEnvPath, overlayPath } = envPaths(document, envName);
    const dataFile = path.resolve(projectRoot, dirs?.dataDir ?? DEFAULT_DATA_DIR, `${envName}.json`);

    if (ref.kind === 'namespace') {
      const envParts = [
        ...(fs.existsSync(baseEnvPath) ? ['.env'] : []),
        ...(overlayPath !== null && fs.existsSync(overlayPath) ? [`.env.${envName}`] : []),
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

  /**
   * The `{{` dropdown: the file's declared parameters, then the names its
   * earlier steps capture.
   *
   * Same file gates as the `${...}` half minus one: `{{}}` interpolates
   * nowhere in frontmatter (a skill's dataSources path takes `${env.X}` only),
   * and — the deliberate difference — there is **no env gate**. A run resolves
   * `{{}}` from its parameter map whether or not an env is selected; the env
   * only decides what a `$VAR` parameter value previews as, and with none the
   * base `.env` still resolves what it can.
   */
  private paramItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    replaceStart: number,
  ): vscode.CompletionItem[] {
    const text = document.getText();
    if (!isTestFile(text)) return [];
    // One classification serves both the frontmatter gate and the scope walk;
    // this runs on keystrokes, and classifying is a whole-document pass.
    const classified = classifyLines(text);
    if (inFrontmatter(text, position.line, classified)) return [];

    const { baseEnvPath, overlayPath } = envPaths(document, activeEnvFor(parseFrontmatter(text)));
    // `parseParameters` + `resolveSection` is the same pair the run path uses
    // to build its parameter map (run-controller.ts), so the preview is what
    // would actually be substituted.
    const params = resolveSection(parseParameters(text), composedEnv(baseEnvPath, overlayPath));
    const captures = captureNamesBefore(text, position.line, classified);
    return paramCompletions(params, captures).map((c) => this.toItem(c, position, replaceStart));
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
    if (CLOSES_WITH_BRACE.has(c.kind)) item.commitCharacters = ['}'];
    return item;
  }
}
