import * as vscode from 'vscode';
import * as path from 'node:path';

/**
 * The compile diff (stories/codebehind-compile.md §What the author sees).
 *
 * A compile proposes file content; nothing is written until the author says
 * so. The proposal is served as a virtual document so `vscode.diff` can show
 * it against the real file, and Apply goes through the workspace edit API —
 * so it lands in the undo stack and in Source Control like any other edit,
 * rather than appearing from nowhere the way the CLI's direct write does.
 */

export const CODEBEHIND_SCHEME = 'steptix-codebehind';

/** What a green compile came back with. */
export interface CompileProposal {
  /** The test that was compiled, for titles and messages. */
  testFilePath: string;
  /** Absolute `.steps.ts` path → proposed content. More than one when the
   *  test invokes skills, whose entries compile into the skill's own file. */
  files: Record<string, string>;
  /** Where Apply should land the author afterwards, when it is not the test
   *  file — a skill-file single-step compile returns to the SKILL, whose
   *  step the author is iterating on, not the test whose session recorded
   *  it. Absent means `testFilePath`, the behaviour every other compile
   *  keeps. */
  returnTo?: string;
}

export class CodeBehindDiffs implements vscode.Disposable {
  private readonly subs: vscode.Disposable[] = [];
  /** Virtual-document content, keyed by the proposal URI's path+query. */
  private readonly contents = new Map<string, string>();
  private proposal: CompileProposal | null = null;
  /** Bumped per compile so a second proposal for the same file gets its own
   *  URI — VS Code caches a virtual document by URI, and reusing one would
   *  show the previous compile's text. */
  private nonce = 0;

  constructor() {
    this.subs.push(
      vscode.workspace.registerTextDocumentContentProvider(CODEBEHIND_SCHEME, {
        provideTextDocumentContent: (uri) => this.contents.get(keyOf(uri)) ?? '',
      }),
    );
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
  }

  /** The proposal waiting for Apply or Discard, if any. */
  get pending(): CompileProposal | null {
    return this.proposal;
  }

  /**
   * Open one diff per proposed file: the real file on the left, the compile's
   * proposal on the right.
   *
   * The last one opened is the one left focused, so a single-file compile —
   * every compile that touches no skills — behaves as if it opened one editor.
   */
  async open(proposal: CompileProposal): Promise<void> {
    this.proposal = proposal;
    this.nonce++;
    const entries = Object.entries(proposal.files);
    for (const [file, content] of entries) {
      const right = this.uriFor(file);
      this.contents.set(keyOf(right), content);
      const left = vscode.Uri.file(file);
      // A file that does not exist yet has nothing to diff against; the empty
      // virtual document on the left makes the whole proposal read as an
      // addition rather than as a failure to open.
      const leftSide = (await exists(left)) ? left : this.emptyUriFor(file);
      if (leftSide !== left) this.contents.set(keyOf(leftSide), '');
      await vscode.commands.executeCommand(
        'vscode.diff',
        leftSide,
        right,
        `${path.basename(file)} ↔ compiled`,
        { preview: false },
      );
    }
    await setPendingContext(true);
  }

  /**
   * Write every proposed file through the workspace edit API.
   *
   * Returns the paths written. One `WorkspaceEdit` for all of them so a
   * multi-file compile is one undo, not one per file.
   */
  async apply(): Promise<string[]> {
    const proposal = this.proposal;
    if (!proposal) return [];
    const edit = new vscode.WorkspaceEdit();
    const written: string[] = [];
    for (const [file, content] of Object.entries(proposal.files)) {
      const uri = vscode.Uri.file(file);
      if (await exists(uri)) {
        const doc = await vscode.workspace.openTextDocument(uri);
        edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), content);
      } else {
        // `contents`, not createFile + insert: an inserted string is re-ended
        // to the new document's EOL, which on Windows means a file `steptix
        // compile` writes with LF arrives here with CRLF. The bytes the
        // compiler produced are the bytes that should land.
        edit.createFile(uri, { ignoreIfExists: true, contents: Buffer.from(content, 'utf-8') });
      }
      written.push(file);
    }
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) return [];
    // Saved on the author's behalf: an applied compile that lives only in a
    // dirty buffer would not be there for the next run, which is the one thing
    // the author is about to do.
    for (const file of written) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await doc.save();
    }
    await this.clear();
    return written;
  }

  /** Drop the proposal. The diff editors stay open; they are just history. */
  async discard(): Promise<void> {
    await this.clear();
  }

  /**
   * Take the proposal out of the slot for the duration of a compile, and hand
   * back the way to put it there again.
   *
   * A compile has to start from an empty slot, or anything asking "is there a
   * proposal yet?" — the `steptix.codeBehindProposal` context key
   * that gates Apply, a test's wait — is answered by the LAST compile's files
   * before this one has produced any. But a compile that starts and then
   * yields nothing (the server was down, the compile errored, every step was
   * already code) must not have cost the author the proposal they were still
   * deciding about, so every such exit calls the returned restore.
   *
   * `contents` is deliberately left alone, unlike `clear()`: it backs the
   * virtual documents of diff editors that are still open, and emptying it
   * mid-compile would make a reopened diff render as though the proposal
   * deleted the whole file.
   */
  async park(): Promise<() => Promise<void>> {
    const parked = this.proposal;
    if (parked === null) return async () => {};
    this.proposal = null;
    await setPendingContext(false);
    return async () => {
      // Only if nothing else claimed the slot in the meantime — a restore
      // must never overwrite a proposal this compile went on to produce.
      if (this.proposal !== null) return;
      this.proposal = parked;
      await setPendingContext(true);
    };
  }

  private async clear(): Promise<void> {
    this.proposal = null;
    this.contents.clear();
    await setPendingContext(false);
  }

  private uriFor(file: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: CODEBEHIND_SCHEME,
      path: normalisedPath(file),
      query: `compile=${this.nonce}`,
    });
  }

  private emptyUriFor(file: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: CODEBEHIND_SCHEME,
      path: normalisedPath(file),
      query: `compile=${this.nonce}&empty=1`,
    });
  }
}

/** Windows paths need the leading slash a URI path always has. */
function normalisedPath(file: string): string {
  const forward = file.replace(/\\/g, '/');
  return forward.startsWith('/') ? forward : `/${forward}`;
}

function keyOf(uri: vscode.Uri): string {
  return `${uri.path}?${uri.query}`;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Gates the Apply / Discard buttons in the diff editor's title bar. */
async function setPendingContext(value: boolean): Promise<void> {
  await vscode.commands.executeCommand(
    'setContext',
    'steptix.codeBehindProposal',
    value,
  );
}

/**
 * Where a step's code-behind entry lives, and where in the file
 * (stories/codebehind-compile.md §What the author sees, "Open Code-behind").
 *
 * Binding is by the step's authored text, so finding the entry is finding the
 * `source:` that matches it — the same rule the runtime uses, rather than a
 * second index that could disagree with it.
 */
export function findEntryLine(fileText: string, stepText: string): number | null {
  const wanted = stepText.trim();
  const lines = fileText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /source\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(lines[i] ?? '');
    if (!match) continue;
    if (unescapeSource(match[2] ?? '') === wanted) return i + 1;
  }
  return null;
}

/** Just enough to compare a generated `source:` literal with the step text:
 *  the writer emits JSON strings, so the escapes are JSON's. */
function unescapeSource(raw: string): string {
  try {
    return JSON.parse(`"${raw.replace(/"/g, '\\"').replace(/\\'/g, "'")}"`) as string;
  } catch {
    return raw;
  }
}

/** `tests/github.md` → `tests/github.steps.ts`. */
export function codeBehindPathFor(markdownFile: string): string {
  const dir = path.dirname(markdownFile);
  const base = path.basename(markdownFile, path.extname(markdownFile));
  return path.join(dir, `${base}.steps.ts`);
}
