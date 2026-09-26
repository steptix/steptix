import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseConfig } from 'ai-ui-automation-runner-core';
import type { ActiveFileTracker } from '../active-file-tracker.js';
import { STOP_THE_RUN, type RunController } from '../run-controller.js';
import type { StepRecorder } from '../step-recorder.js';
import { readProjectDirs } from '../aiui-config-parse.js';
import { isSkillDocument } from '../skill-run-targets.js';
import { resolveProjectDirs } from '../aiui-config.js';
import {
  inferBaseUrl,
  newTestDir,
  newTestSkeleton,
  resolveRecordCursor,
  validateNewTestName,
} from '../record-steps-core.js';

/** The slice of the registry the Record commands use. */
export interface RecordRegistry {
  active(): RunController | undefined;
  get(document: vscode.TextDocument): RunController | undefined;
  isStepPaused(controllerUri: vscode.Uri): boolean;
  readonly recorder: StepRecorder;
}

/**
 * Record Steps, Record New Test, and the three controls a recording is
 * steered with (stories/testbench-record-steps.md). The panel's buttons post
 * messages that execute these same commands, so there is one implementation
 * of each gesture.
 *
 * `performStop` is the Stop command's own teardown, handed in rather than
 * re-implemented: a paused run that Record ends (decision 12) must end exactly
 * as a Stop ends it — the yellow ▶, the spinners, the keep-alive and the
 * parked state all go — or the next Continue would resume a run that is over.
 */
export function registerRecordCommands(deps: {
  registry: RecordRegistry;
  tracker: ActiveFileTracker;
  performStop: (opts: { target?: RunController }) => void;
}): vscode.Disposable[] {
  const { registry, tracker, performStop } = deps;
  const recorder = registry.recorder;
  /** A Record gesture between its checks and `recorder.start` — waiting on a
   *  paused run to unwind, or on the new-test prompt. A second one then would
   *  pass the `isRecording` check and start a second recording. */
  let pending = false;
  const guarded =
    <A extends unknown[]>(body: (...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      if (pending) return recorder.refuse('A recording is already starting.');
      pending = true;
      try {
        await body(...args);
      } finally {
        pending = false;
      }
    };

  /**
   * Record at the cursor. `line` (1-based) overrides the cursor, for callers
   * that already know where — a keybinding's args, or a test.
   */
  const recordSteps = async (arg?: { line?: number }): Promise<void> => {
    if (recorder.isRecording) {
      return recorder.refuse(
        `Already recording steps into ${recorder.state?.file ?? 'a test'}. Stop or cancel that recording first.`,
      );
    }
    const editor = tracker.activeEditor;
    if (!editor || !tracker.isActiveTestFile) {
      return recorder.refuse(
        'Open a test (a Markdown file with a "## Steps" heading) and put the cursor where the recorded steps should go.',
      );
    }
    const doc = editor.document;
    if (isSkillDocument(doc.getText(), doc.uri.fsPath, resolveProjectDirs(doc.uri)?.skillsDir ?? null)) {
      return recorder.refuse(
        'Record Steps records into a test, in that test\'s browser. Open a test that calls this skill and record there.',
      );
    }
    const controller = registry.active();
    if (!controller) {
      return recorder.refuse('This file is not inside a workspace folder, so TestBench cannot record into it.');
    }
    const line = typeof arg?.line === 'number' ? arg.line : editor.selection.active.line + 1;
    const cursor = resolveRecordCursor(doc.getText(), line);
    if (!cursor.ok) return recorder.refuse(cursor.reason);

    // Decision 12. A run that is EXECUTING is refused; one parked at a
    // breakpoint — either kind: the client-side pause after a trimmed batch,
    // or a step pause with the server holding the stream open — is ended
    // first, and the recording picks up from the page it left.
    const uri = controller.document.uri;
    const stepPaused = controller.isRunning && registry.isStepPaused(uri);
    if (controller.isRunning && !stepPaused) {
      return recorder.refuse(STOP_THE_RUN);
    }
    if (stepPaused || controller.isParkedAtPause || tracker.breakpointStopFor(uri) !== null) {
      performStop({ target: controller });
      // A step pause holds the run's stream open; the abort above ends it, but
      // the run unwinds asynchronously and the controller refuses to record
      // until it has.
      if (stepPaused && !(await until(() => !controller.isRunning, 5_000))) {
        return recorder.refuse('The paused run did not end in time, so nothing was recorded. Try Record again.');
      }
      controller.postRecordLog('Ended the paused run to record from its page. The browser stays where it is.', 'info');
    }
    recorder.start(controller, {
      mode: 'cursor',
      anchor: cursor.anchor,
      cursorLine: cursor.anchor.line,
      // Only a step pause had a server-side run to let go of.
      retryConflict: stepPaused,
    });
  };

  /**
   * Record New Test: ask for a name, create `<tests dir>/<name>.md` from the
   * skeleton, save and open it, and record into it (decision 11). `name` in
   * the argument skips the prompt.
   */
  const recordNewTest = async (arg?: { name?: string }): Promise<void> => {
    if (recorder.isRecording) {
      return recorder.refuse(
        `Already recording steps into ${recorder.state?.file ?? 'a test'}. Stop or cancel that recording first.`,
      );
    }
    const activeEditor = tracker.activeEditor;
    const folder =
      (activeEditor && vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)) ??
      vscode.workspace.workspaceFolders?.[0];
    if (!folder) return recorder.refuse('Open a folder first: Record New Test creates the test inside the workspace.');

    const raw =
      typeof arg?.name === 'string'
        ? arg.name
        : await vscode.window.showInputBox({
            title: 'TestBench: Record New Test',
            prompt: 'Name of the new test. It becomes <name>.md in the project\'s tests folder.',
            placeHolder: 'pay-by-cash',
            validateInput: (value) => {
              const v = validateNewTestName(value);
              return v.ok ? null : v.reason;
            },
          });
    if (raw === undefined) return; // dismissed
    const name = validateNewTestName(raw);
    if (!name.ok) return recorder.refuse(`Record New Test: ${name.reason}`);

    const root = folder.uri.fsPath;
    const activeInFolder =
      activeEditor &&
      vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)?.uri.toString() === folder.uri.toString()
        ? activeEditor
        : undefined;
    const configPath = findConfigWithin(activeInFolder ? path.dirname(activeInFolder.document.uri.fsPath) : root, root);
    const target = newTestDir({
      configTestsDir: configPath ? (readProjectDirs(configPath)?.testsDir ?? null) : null,
      testsGlob: vscode.workspace.getConfiguration('testbench-native').get<string>('testsGlob') ?? '**/*.md',
      workspaceRoot: root,
    });
    const filePath = path.join(target.dir, name.fileName);
    if (fs.existsSync(filePath)) {
      // docs/specs/SPEC-record-steps.md §10, verbatim.
      return recorder.refuse(`${vscode.workspace.asRelativePath(vscode.Uri.file(filePath), false)} already exists.`);
    }

    const preferred =
      activeInFolder && tracker.isActiveTestFile
        ? (parseConfig(activeInFolder.document.getText())['baseUrl'] ?? null)
        : null;
    const baseUrl = inferBaseUrl(readTestTexts(target.dir), preferred);
    const skeleton = newTestSkeleton({ title: name.title, baseUrl });
    try {
      fs.mkdirSync(target.dir, { recursive: true });
      // `wx`: never overwrite, even if the file appeared since the check.
      fs.writeFileSync(filePath, skeleton.text, { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      return recorder.refuse(
        `Record New Test: could not create ${filePath} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const cursor = new vscode.Position(skeleton.cursorLine - 1, 0);
    editor.selection = new vscode.Selection(cursor, cursor);
    const controller = registry.get(doc);
    if (!controller) {
      return recorder.refuse(
        `Record New Test: created ${filePath}, but it is outside the workspace, so TestBench cannot record into it.`,
      );
    }
    recorder.start(controller, { mode: 'new', anchor: null });
  };

  return [
    vscode.commands.registerCommand('testbench-native.recordSteps', guarded(recordSteps)),
    vscode.commands.registerCommand('testbench-native.recordNewTest', guarded(recordNewTest)),
    vscode.commands.registerCommand('testbench-native.stopRecording', () => recorder.stop()),
    vscode.commands.registerCommand('testbench-native.recordAddCheck', () => recorder.toggleCheck()),
    vscode.commands.registerCommand('testbench-native.cancelRecording', () => recorder.cancel()),
  ];
}

/** Poll `predicate` until it holds or `timeoutMs` passes; whether it held. */
async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/**
 * The nearest `aiui.config.json` from `startDir` up to `root`, never above it:
 * a config outside the workspace (the repo this workspace sits in, say) is not
 * this project's, and its `tests.dir` would put the new test somewhere the
 * workspace cannot see.
 */
function findConfigWithin(startDir: string, root: string): string | null {
  const top = path.resolve(root);
  let dir = path.resolve(startDir);
  const rel = path.relative(top, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) dir = top;
  for (;;) {
    const candidate = path.join(dir, 'aiui.config.json');
    if (fs.existsSync(candidate)) return candidate;
    if (dir === top) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The text of up to 200 Markdown files under `dir` (three levels deep,
 * skipping dot-folders and node_modules), in path order — the population the
 * `baseUrl` inference counts. Unreadable entries are skipped.
 */
function readTestTexts(dir: string): string[] {
  const files: string[] = [];
  const walk = (at: string, depth: number): void => {
    if (depth > 3 || files.length >= 200) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= 200) return;
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && e.name !== 'node_modules') walk(path.join(at, e.name), depth + 1);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        files.push(path.join(at, e.name));
      }
    }
  };
  walk(dir, 0);
  const out: string[] = [];
  for (const f of files) {
    try {
      out.push(fs.readFileSync(f, 'utf8'));
    } catch {
      /* skip */
    }
  }
  return out;
}
