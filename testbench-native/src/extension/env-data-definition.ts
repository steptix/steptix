import * as vscode from 'vscode';
import * as path from 'node:path';
import { classifyLines, isTestFile, parseFrontmatter } from 'ai-ui-automation-runner-core';
import { DEFAULT_DATA_DIR } from './aiui-config-parse.js';
import {
  POST_HOOK_SCOPES,
  allCaptureWrites,
  captureNamesBefore,
  findForEachBinding,
  hookScopeAt,
  inFrontmatter,
  isFencedLine,
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
 *                         bullet under `## Parameters` and every in-scope
 *                         capturing step (more than one peeks as a list)
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
    // Line-local bails first: this runs on Ctrl+hover as well as F12, and
    // almost no position is inside a reference. Nothing document-wide happens
    // until one of these two probes says it is.
    const line = document.lineAt(position.line).text;
    const ref = refAtPosition(line, position.character);
    if (ref === null) {
      // The other half of the grammar: a flat `{{name}}` runtime variable.
      // (`${{name}}` lands here too — the `${` parse rejects it while the
      // runtime resolves the inner `{{name}}` — mirroring the completion
      // provider's split.)
      const param = paramRefAtPosition(line, position.character);
      if (param === null) return undefined;
      const text = this.interpolatedText(document, position);
      return text === null ? undefined : this.paramTarget(document, position, param.name, text);
    }
    // `${envName}` has no on-disk definition — its value is the selector's
    // (or the frontmatter pin's) state, not a file.
    if (ref.namespace === 'envName') return undefined;

    const text = this.interpolatedText(document, position);
    if (text === null) return undefined;

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

    // Refusals that no environment could satisfy come BEFORE the env gate:
    // telling the author to pick an environment has to be advice that would
    // actually work. A skill never reads the caller's data file, whatever is
    // selected.
    if (ref.namespace === 'data' && isSkill) {
      this.warnings.warn(
        'TestBench: ${data...} does not resolve inside a skill — skills read ' +
          "their own dataSources:, never the caller environment's data file.",
      );
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
   * Definitions for a `{{name}}` runtime variable — everything that writes it
   * in scope at the cursor, in the file itself:
   *
   *  - the `- name:` bullet under `## Parameters`, when declared;
   *  - EVERY in-scope capture (`[store as:]` / `[input:]` / `[output:]` / an
   *    `out.k="name"` alias), per `captureNamesBefore`'s execution-order walk
   *    — pre-hooks lead, section bodies count at their call sites;
   *  - failing both, every `For each {{name}} in {{list}}` header that binds
   *    it, which is the one binding no step carries a marker for.
   *
   * A dotted `{{order.id}}` is answered by its ROOT throughout: the planner
   * binds `order` and its properties together, once per pass, so the honest
   * target is the `For each` line and field-level navigation is explicitly not
   * required (SPEC-structured-table-reads.md §8.4). That is also what keeps
   * the widened grammar from being a regression: a property is never a
   * capture, so resolving `{{order.id}}` by its own name would find nothing
   * and toast "no step stores it" on every correct table loop.
   *
   * All of them are returned, so a name written more than once peeks as a
   * list rather than silently picking one: the run's LAST write is the live
   * value, while a reader looking for where a name comes from usually wants
   * the first, and the editor should not have to guess which question is
   * being asked. There is no env gate, matching the completion split —
   * `{{}}` resolves with no env selected.
   *
   * Scope depends on what the cursor's line IS, not only where it sits: an
   * `after`/`afterEach` hook runs once the whole main flow has, so a read
   * there sees every step's captures however the file is ordered.
   *
   * A name nothing writes toasts instead of silently doing nothing: unlike an
   * undeclared `${namespace}`, a `{{name}}` in a test file is almost
   * certainly meant as a runtime variable, and the two interesting misses —
   * the write sits later in the run, or it is prose ("store it as {{x}}"),
   * which deliberately binds nothing — are authoring mistakes worth
   * explaining.
   */
  private paramTarget(
    document: vscode.TextDocument,
    position: vscode.Position,
    name: string,
    text: string,
  ): vscode.Definition | undefined {
    // One classification serves the frontmatter gate and the scope walk.
    const classified = classifyLines(text);
    // `{{}}` interpolates nowhere in frontmatter (a skill's dataSources path
    // takes `${env.X}` / `${envName}` only).
    if (inFrontmatter(text, position.line, classified)) return undefined;

    // Everything below asks about the ROOT: `order.id` is bound by whatever
    // binds `order`, and nothing writes a property under its own name.
    const root = name.split('.')[0]!;

    const locations: vscode.Location[] = [];
    const bullet = findParameterBullet(text, root);
    if (bullet) locations.push(this.locationAt(document.uri, bullet));

    // A post-hook reads after the whole flow; anything else reads where it
    // sits. `mainFlowOnly` also keeps the hook line — which belongs to no
    // section — from being attributed to whatever section encloses it.
    const postHook = POST_HOOK_SCOPES.has(hookScopeAt(text, position.line) ?? '');
    const writes = captureNamesBefore(
      text,
      postHook ? classified.length : position.line,
      classified,
      { mainFlowOnly: postHook, dedupe: false },
    ).filter((c) => c.name === root);
    for (const write of writes) {
      locations.push(this.locationAt(document.uri, { ...write, line: write.line - 1 }));
    }
    // A loop item last, and only when nothing else claimed the name: a `For
    // each` binds for the length of its body, while a capture or a parameter
    // is the value the author asked about everywhere else in the file.
    if (locations.length === 0) {
      for (const header of findForEachBinding(text, root)) {
        locations.push(this.locationAt(document.uri, header));
      }
    }
    if (locations.length > 0) return locations;

    // Nothing writes it in scope — say why, distinguishing "written later in
    // the run" from "written nowhere". This asks whether the name is written
    // AT ALL, which is not the scope walk run from the end of the file: that
    // walk resolves an owning section for its position, so a file ending
    // inside a section body would drop the main-flow steps below its call
    // site and misreport them as never written.
    const later = allCaptureWrites(text, classified).find((c) => c.name === root);
    this.warnings.warn(
      later
        ? `TestBench: {{${name}}} has no value here — it is written on line ` +
            `${later.line}, which the run reaches after this point.`
        : name === root
          ? `TestBench: {{${name}}} is not a declared parameter, and no step stores ` +
            'it (prose like "store it as {{x}}" binds nothing — use [store as: x]).'
          : // Dotted, and its root is bound by nothing at all. Worded like the
            // runtime's own refusal (`dottedReferenceError`), which names the
            // root rather than the property: the property is only ever as real
            // as the row it came from.
            `TestBench: {{${name}}} has no value — nothing in this file binds ` +
            `{{${root}}}. A property comes from the record a ` +
            `"For each {{${root}}} in {{list}}" is iterating.`,
    );
    return undefined;
  }

  /**
   * The document's text when a reference at `position` would actually be
   * interpolated by a run, else null — the gates both halves of the grammar
   * share, stated once and paid for only after a line-local probe has found
   * a reference.
   *
   * A reference inside a fenced block is example text: a run interpolates
   * nothing there, and `captureNamesBefore` already refuses to read writes
   * out of fences, so reporting on a fenced READ (worse, warning about one)
   * would be commentary on prose.
   */
  private interpolatedText(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): string | null {
    const text = document.getText();
    if (!isTestFile(text)) return null;
    return isFencedLine(text, position.line) ? null : text;
  }

  /** A single-line selection of `hit`, which every locator here reports as a
   *  0-based line plus a column/length. */
  private locationAt(
    uri: vscode.Uri,
    hit: { line: number; column: number; length: number },
  ): vscode.Location {
    return new vscode.Location(
      uri,
      new vscode.Range(hit.line, hit.column, hit.line, hit.column + hit.length),
    );
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
    if (ref.segmentIndex < 0) {
      // Cursor on the namespace itself — the file is the definition.
      return new vscode.Location(uri, new vscode.Position(0, 0));
    }
    const shown = displayPath(file, projectRoot);
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
    return this.locationAt(uri, hit);
  }

  /**
   * A location inside the env files: the assignment line for the referenced
   * variable, searched in composition order so the file that WINS the value
   * is the file navigated to. A defined-nowhere name opens the winning file's
   * top with a toast; only "neither env file exists" refuses to navigate.
   */
  private envTarget(
    ref: RefAtPosition,
    baseEnvPath: string,
    overlayPath: string,
    envName: string,
    projectRoot: string,
  ): vscode.Location | undefined {
    // Highest precedence first — the overlay overrides the base, so the one
    // list expresses that once for both the search and the fallback file.
    const candidates = [overlayPath, baseEnvPath]
      .map((file) => ({ file, text: readTextCached(file) }))
      .filter((c): c is { file: string; text: string } => c.text !== undefined);
    if (candidates.length === 0) {
      this.warnings.warn(`TestBench: no .env or .env.${envName} found in ${projectRoot}.`);
      return undefined;
    }
    const winner = candidates[0]!;
    const topOfWinner = new vscode.Location(vscode.Uri.file(winner.file), new vscode.Position(0, 0));
    if (ref.segmentIndex < 0) return topOfWinner;

    // env is flat: whatever follows `env.` — dots included — is the one key
    // the runtime would look up.
    const name = ref.path.join('.');
    for (const candidate of candidates) {
      const hit = findEnvLine(candidate.text, name);
      if (hit) return this.locationAt(vscode.Uri.file(candidate.file), hit);
    }
    this.warnings.warn(
      `TestBench: "${name}" is not defined in .env or .env.${envName} — ` +
        `opening ${displayPath(winner.file, projectRoot)}.`,
    );
    return topOfWinner;
  }
}
