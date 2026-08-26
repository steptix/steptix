import * as vscode from 'vscode';
import * as path from 'node:path';
import { classifyLines, isTestFile, parseFrontmatter } from 'ai-ui-automation-runner-core';
import { DEFAULT_DATA_DIR } from './aiui-config-parse.js';
import {
  captureNamesBefore,
  captureWriteRange,
  inFrontmatter,
} from './env-data-completion-core.js';
import {
  activeEnvFor,
  composedEnv,
  displayPath,
  envPaths,
  readJsonCached,
  readTextCached,
  resolveSourcePath,
} from './env-data-resolve.js';
import {
  findEnvLine,
  findParameterBullet,
  locateJsonPath,
  paramRefAtPosition,
  refAtPosition,
  type RefAtPosition,
} from './env-data-definition-core.js';
import { DedupedWarnings } from './warnings.js';

/**
 * "Go to Definition" (F12 / Ctrl+Click / Peek) for `${...}` references in
 * test and skill Markdown — the navigation side of the completion provider
 * next door (env-data-completion.ts), resolving WHICH files through the same
 * helpers (env-data-resolve.ts) so the two can't disagree:
 *
 *   - `${data.a.b}`     → the `"b"` key inside `<dataDir>/<envName>.json`
 *   - `${<source>.a.b}` → the same, inside the declared dataSources file
 *   - `${env.X}`        → the `X=` line in `.env.<envName>`, else `.env`
 *                         (the overlay wins composition, so it wins here)
 *   - `{{name}}`        → what writes it, in the file itself: the `- name:`
 *                         bullet under `## Parameters` and/or the first
 *                         in-scope capturing step (both when a step
 *                         overwrites a declared parameter — a peek list)
 *
 * The cursor's path segment decides the depth: F12 on `user` in
 * `${data.user.name}` jumps to the `"user"` key, on `name` to the key inside
 * it. Cursor on the namespace token opens the file itself.
 *
 * Unlike completion — which runs on keystrokes and stays silent — F12 is an
 * explicit gesture, so unresolvable-but-intentional references explain
 * themselves with a (deduplicated) warning toast: no env selected, a missing
 * file, a path the file doesn't contain. When the file exists but the exact
 * key doesn't, navigation still lands on the nearest existing ancestor —
 * that is where the author would go to add it. What stays silent: text that
 * is not a complete reference, namespaces nothing declares (the run passes
 * those through literally, so they are likely prose), and `${envName}`,
 * whose value is selector state, not a file.
 */
export class EnvDataDefinitionProvider implements vscode.DefinitionProvider {
  private warnings = new DedupedWarnings();

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Definition | undefined {
    const line = document.lineAt(position.line).text;
    const ref = refAtPosition(line, position.character);
    if (ref === null) {
      // The other half of the grammar: a flat `{{name}}` runtime variable.
      // (`${{name}}` lands here too — the `${` parse rejects it while the
      // runtime resolves the inner `{{name}}` — mirroring the completion
      // provider's split.)
      const param = paramRefAtPosition(line, position.character);
      if (!param) return undefined;
      const text = document.getText();
      if (!isTestFile(text)) return undefined;
      return this.paramTarget(document, position, param.name);
    }
    // `${envName}` has no on-disk definition — its value is the selector's
    // (or the frontmatter pin's) state, not a file.
    if (ref.namespace === 'envName') return undefined;

    const text = document.getText();
    if (!isTestFile(text)) return undefined;

    const fm = parseFrontmatter(text);
    const isSkill = fm.type === 'skill';
    // In frontmatter, `${...}` only occurs inside a skill's dataSources path,
    // where the runtime accepts `${env.X}` and `${envName}` alone. A test's
    // frontmatter interpolates nothing.
    const pathPosition = inFrontmatter(text, position.line);
    if (pathPosition && !isSkill) return undefined;
    if (pathPosition && ref.namespace !== 'env') return undefined;

    // A namespace that is neither built-in nor declared passes through a run
    // literally — in a document it is most likely prose or an example, so it
    // is not a navigation failure worth a toast.
    const declaredSource = fm.dataSources?.[ref.namespace];
    if (ref.namespace !== 'env' && ref.namespace !== 'data' && declaredSource === undefined) {
      return undefined;
    }

    const envName = activeEnvFor(fm);
    if (!envName) {
      this.warnings.warn(
        'TestBench: no environment selected — ${...} references resolve against ' +
          "an environment's files. Pick one in the TestBench panel to navigate.",
      );
      return undefined;
    }

    const { dirs, projectRoot, baseEnvPath, overlayPath } = envPaths(document, envName);

    if (ref.namespace === 'env') {
      // overlayPath is non-null here: envName was gated above.
      return this.envTarget(ref, baseEnvPath, overlayPath!, envName, projectRoot);
    }

    if (ref.namespace === 'data') {
      if (isSkill) {
        this.warnings.warn(
          'TestBench: ${data...} does not resolve inside a skill — skills read ' +
            "their own dataSources:, never the caller environment's data file.",
        );
        return undefined;
      }
      const dataFile = path.resolve(
        projectRoot,
        dirs?.dataDir ?? DEFAULT_DATA_DIR,
        `${envName}.json`,
      );
      return this.jsonTarget(dataFile, ref, projectRoot);
    }

    const file = resolveSourcePath(
      declaredSource!,
      document.uri.fsPath,
      isSkill,
      composedEnv(baseEnvPath, overlayPath),
      envName,
    );
    if (file === null) {
      this.warnings.warn(
        `TestBench: dataSources path "${declaredSource}" doesn't resolve — ` +
          'an ${env...} placeholder in it is unset.',
      );
      return undefined;
    }
    return this.jsonTarget(file, ref, projectRoot);
  }

  /**
   * Definitions for a `{{name}}` runtime variable — everything that writes
   * it before the cursor's step, in the file itself:
   *
   *  - the `- name:` bullet under `## Parameters`, when declared;
   *  - the first in-scope capture (`[store as:]` / `[input:]` / `[output:]` /
   *    an `out.k="name"` alias), per `captureNamesBefore`'s execution-order
   *    walk — pre-hooks lead, section bodies count at their call sites.
   *
   * Both can hold at once (a capture overwriting a declared parameter); both
   * are returned and VS Code shows its peek list. There is no env gate,
   * matching the completion split — `{{}}` resolves with no env selected.
   *
   * A name nothing writes toasts instead of silently doing nothing: unlike an
   * undeclared `${namespace}`, a `{{name}}` in a test file is almost
   * certainly meant as a runtime variable, and the two interesting misses —
   * the write sits BELOW the cursor, or it is prose ("store it as {{x}}"),
   * which deliberately binds nothing — are authoring mistakes worth
   * explaining.
   */
  private paramTarget(
    document: vscode.TextDocument,
    position: vscode.Position,
    name: string,
  ): vscode.Definition | undefined {
    const text = document.getText();
    // One classification serves the frontmatter gate and both scope walks.
    const classified = classifyLines(text);
    // `{{}}` interpolates nowhere in frontmatter (a skill's dataSources path
    // takes `${env.X}` / `${envName}` only).
    if (inFrontmatter(text, position.line, classified)) return undefined;

    const locations: vscode.Location[] = [];
    const bullet = findParameterBullet(text, name);
    if (bullet) {
      locations.push(
        new vscode.Location(
          document.uri,
          new vscode.Range(bullet.line, bullet.column, bullet.line, bullet.column + bullet.length),
        ),
      );
    }
    const capture = captureNamesBefore(text, position.line, classified).find(
      (c) => c.name === name,
    );
    if (capture) {
      const lineIdx = capture.line - 1;
      const range = captureWriteRange(document.lineAt(lineIdx).text, name);
      locations.push(
        new vscode.Location(
          document.uri,
          range
            ? new vscode.Range(lineIdx, range.column, lineIdx, range.column + range.length)
            : new vscode.Range(lineIdx, 0, lineIdx, 0),
        ),
      );
    }
    if (locations.length > 0) return locations;

    // Nothing writes it above the cursor — say why, distinguishing "written
    // too late" (best-effort: the same walk run from the end of the file)
    // from "written nowhere".
    const later = captureNamesBefore(text, classified.length, classified).find(
      (c) => c.name === name,
    );
    this.warnings.warn(
      later
        ? `TestBench: {{${name}}} has no value here — its first write is on line ` +
            `${later.line}, after this step. A step can only read what ran before it.`
        : `TestBench: {{${name}}} is not a declared parameter, and no step before ` +
            'this one stores it (prose like "store it as {{x}}" binds nothing — ' +
            'use [store as: x]).',
    );
    return undefined;
  }

  /**
   * A location inside a JSON data file: the key the cursor's path segment
   * names, the nearest existing ancestor when that key is missing (with a
   * toast saying so), the top of the file for the namespace token — and a
   * warning with no navigation only when the file itself is missing.
   */
  private jsonTarget(
    file: string,
    ref: RefAtPosition,
    projectRoot: string,
  ): vscode.Location | undefined {
    const raw = readTextCached(file);
    if (raw === undefined) {
      this.warnings.warn(`TestBench: data file not found — looked for ${file}`);
      return undefined;
    }
    const uri = vscode.Uri.file(file);
    const shown = displayPath(file, projectRoot);
    if (ref.segmentIndex < 0) {
      // Cursor on the namespace itself — the file is the definition.
      return new vscode.Location(uri, new vscode.Position(0, 0));
    }
    if (readJsonCached(file) === undefined) {
      this.warnings.warn(`TestBench: ${shown} is not valid JSON — opening the top of the file.`);
      return new vscode.Location(uri, new vscode.Position(0, 0));
    }
    const wanted = ref.path.slice(0, ref.segmentIndex + 1);
    const hit = locateJsonPath(raw, wanted);
    if (hit.depth < wanted.length) {
      const missing = [ref.namespace, ...wanted].join('.');
      const landing =
        hit.depth === 0
          ? 'the top of the file'
          : `its nearest parent, ${[ref.namespace, ...wanted.slice(0, hit.depth)].join('.')}`;
      this.warnings.warn(
        `TestBench: \${${missing}} not found in ${shown} — opening ${landing}.`,
      );
    }
    return new vscode.Location(
      uri,
      new vscode.Range(hit.line, hit.column, hit.line, hit.column + hit.length),
    );
  }

  /**
   * A location inside the env files: the assignment line for the referenced
   * variable, checked in the overlay first because the overlay wins the
   * composed map. A defined-nowhere name opens the winning file's top with a
   * toast; only "neither env file exists" refuses to navigate.
   */
  private envTarget(
    ref: RefAtPosition,
    baseEnvPath: string,
    overlayPath: string,
    envName: string,
    projectRoot: string,
  ): vscode.Location | undefined {
    const overlayText = readTextCached(overlayPath);
    const baseText = readTextCached(baseEnvPath);
    if (overlayText === undefined && baseText === undefined) {
      this.warnings.warn(`TestBench: no .env or .env.${envName} found in ${projectRoot}.`);
      return undefined;
    }
    const winnerPath = overlayText !== undefined ? overlayPath : baseEnvPath;
    if (ref.segmentIndex < 0) {
      return new vscode.Location(vscode.Uri.file(winnerPath), new vscode.Position(0, 0));
    }

    // env is flat: whatever follows `env.` — dots included — is the one key
    // the runtime would look up.
    const name = ref.path.join('.');
    const inOverlay = overlayText !== undefined ? findEnvLine(overlayText, name) : null;
    const hit = inOverlay ?? (baseText !== undefined ? findEnvLine(baseText, name) : null);
    if (!hit) {
      this.warnings.warn(
        `TestBench: "${name}" is not defined in .env or .env.${envName} — ` +
          `opening ${displayPath(winnerPath, projectRoot)}.`,
      );
      return new vscode.Location(vscode.Uri.file(winnerPath), new vscode.Position(0, 0));
    }
    const file = inOverlay ? overlayPath : baseEnvPath;
    return new vscode.Location(
      vscode.Uri.file(file),
      new vscode.Range(hit.line, hit.column, hit.line, hit.column + hit.length),
    );
  }
}
