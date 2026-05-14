import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { resolveProjectDirs } from './aiui-config.js';

/**
 * "Go to Definition" (F12 / Ctrl+Click / Peek) for `[skill: ...]` and
 * `[tool: ...]` step invocations inside Markdown test files.
 *
 * Three token kinds on an invocation line are jump targets:
 *   - the skill/tool **name** → the skill `.md` / tool `.ts` file
 *   - an `out.<key>` alias **key** → for skills, the `- <key>:` line under
 *     `## Outputs` in the skill file; for tools, the tool file
 *
 * The alias *value* (the text after `=`) is a new name the caller is
 * creating, not a reference, so it is deliberately not a jump target.
 *
 * Skill/tool directories come from the project's `aiui.config.*` file,
 * located by walking up from the test file (see `aiui-config.ts`).
 */
export class InvocationDefinitionProvider implements vscode.DefinitionProvider {
  /** Last warning shown + when, to avoid stacking identical toasts when a
   *  hover-peek and an F12 land on the same broken invocation. */
  private lastWarning: { message: string; at: number } | null = null;

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Definition | undefined {
    const line = document.lineAt(position.line).text;
    const invocation = parseInvocationLine(line);
    if (!invocation) return undefined;

    const token = tokenAt(invocation, position.character);
    if (!token) return undefined;

    const dirs = resolveProjectDirs(document.uri);
    if (!dirs) {
      this.warn(
        `TestBench: no aiui.config.{ts,js,mjs} found above ${document.uri.fsPath} — ` +
          `can't resolve skills/tools directory.`,
      );
      return undefined;
    }

    if (token.kind === 'name') {
      return invocation.kind === 'skill'
        ? this.skillNameTarget(dirs.skillsDir, invocation.name)
        : this.toolNameTarget(dirs.toolsDir, invocation.name);
    }

    // token.kind === 'outputKey'
    return invocation.kind === 'skill'
      ? this.skillOutputTarget(dirs.skillsDir, invocation.name, token.text)
      : this.toolNameTarget(dirs.toolsDir, invocation.name);
  }

  private skillNameTarget(
    skillsDir: string | null,
    name: string,
  ): vscode.Location | undefined {
    if (!skillsDir) {
      this.warn(`TestBench: aiui.config does not declare a skillsDir.`);
      return undefined;
    }
    const file = path.join(skillsDir, `${name}.md`);
    if (!fs.existsSync(file)) {
      this.warn(`TestBench: skill "${name}" not found — looked for ${file}`);
      return undefined;
    }
    const lineNo = findLine(file, new RegExp(`^#{1,6}\\s+${escapeRegex(name)}\\b`)) ?? 0;
    return new vscode.Location(vscode.Uri.file(file), new vscode.Position(lineNo, 0));
  }

  private skillOutputTarget(
    skillsDir: string | null,
    skillName: string,
    outputKey: string,
  ): vscode.Location | undefined {
    if (!skillsDir) {
      this.warn(`TestBench: aiui.config does not declare a skillsDir.`);
      return undefined;
    }
    const file = path.join(skillsDir, `${skillName}.md`);
    if (!fs.existsSync(file)) {
      this.warn(`TestBench: skill "${skillName}" not found — looked for ${file}`);
      return undefined;
    }
    // Prefer the `- <key>:` bullet under an `## Outputs` heading; fall back
    // to the skill heading, then the top of the file.
    const lineNo =
      findOutputBullet(file, outputKey) ??
      findLine(file, new RegExp(`^#{1,6}\\s+${escapeRegex(skillName)}\\b`)) ??
      0;
    return new vscode.Location(vscode.Uri.file(file), new vscode.Position(lineNo, 0));
  }

  private toolNameTarget(
    toolsDir: string | null,
    name: string,
  ): vscode.Location | undefined {
    if (!toolsDir) {
      this.warn(`TestBench: aiui.config does not declare a toolsDir.`);
      return undefined;
    }
    const file = path.join(toolsDir, `${name}.ts`);
    if (!fs.existsSync(file)) {
      this.warn(`TestBench: tool "${name}" not found — looked for ${file}`);
      return undefined;
    }
    return new vscode.Location(vscode.Uri.file(file), new vscode.Position(0, 0));
  }

  private warn(message: string): void {
    const now = Date.now();
    if (
      this.lastWarning &&
      this.lastWarning.message === message &&
      now - this.lastWarning.at < 3000
    ) {
      return;
    }
    this.lastWarning = { message, at: now };
    void vscode.window.showWarningMessage(message);
  }
}

/** A `[skill: ...]` / `[tool: ...]` invocation located on a line. */
interface InvocationLine {
  kind: 'skill' | 'tool';
  name: string;
  /** [start, end) char range of the name token on the line. */
  nameRange: [number, number];
  /** Each `out.<key>` alias key found, with the char range of `<key>`. */
  outputKeys: Array<{ text: string; range: [number, number] }>;
}

/** A token the cursor can sit on within an invocation line. */
interface Token {
  kind: 'name' | 'outputKey';
  text: string;
}

const INVOCATION_RE = /\[(skill|tool):\s*([A-Za-z0-9_-]+)/;
const OUTPUT_KEY_RE = /\bout\.([A-Za-z0-9_-]+)/g;

/**
 * Parse the invocation prefix + name + any `out.<key>` aliases out of a
 * raw line, recording character ranges so the cursor can be mapped to a
 * token. Returns null if the line is not a skill/tool invocation.
 */
function parseInvocationLine(line: string): InvocationLine | null {
  const m = INVOCATION_RE.exec(line);
  if (!m || m.index === undefined) return null;
  const kind = m[1] as 'skill' | 'tool';
  const name = m[2]!;
  // The name starts after `[skill:`/`[tool:` and the whitespace the regex
  // consumed; recompute its offset from the full match length.
  const nameStart = m.index + m[0].length - name.length;
  const nameRange: [number, number] = [nameStart, nameStart + name.length];

  const outputKeys: InvocationLine['outputKeys'] = [];
  OUTPUT_KEY_RE.lastIndex = 0;
  let om: RegExpExecArray | null;
  while ((om = OUTPUT_KEY_RE.exec(line)) !== null) {
    const key = om[1]!;
    const keyStart = om.index + om[0].length - key.length;
    outputKeys.push({ text: key, range: [keyStart, keyStart + key.length] });
  }

  return { kind, name, nameRange, outputKeys };
}

/** Which token, if any, the cursor column falls on. */
function tokenAt(inv: InvocationLine, column: number): Token | null {
  if (inRange(column, inv.nameRange)) {
    return { kind: 'name', text: inv.name };
  }
  for (const ok of inv.outputKeys) {
    if (inRange(column, ok.range)) {
      return { kind: 'outputKey', text: ok.text };
    }
  }
  return null;
}

/** Cursor is "on" a token if it sits anywhere from its first char through
 *  the position just past its last char (so F12 works at either edge). */
function inRange(column: number, [start, end]: [number, number]): boolean {
  return column >= start && column <= end;
}

/** First 0-based line index in `file` matching `re`, or null. */
function findLine(file: string, re: RegExp): number | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]!)) return i;
  }
  return null;
}

/**
 * Find the `- <key>:` bullet under an `## Outputs` heading in a skill file.
 * Returns the 0-based line index, or null if not found.
 */
function findOutputBullet(file: string, key: string): number | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const bulletRe = new RegExp(`^\\s*-\\s*${escapeRegex(key)}\\b`);
  let inOutputs = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      inOutputs = /^outputs$/i.test(heading[2]!.trim());
      continue;
    }
    if (inOutputs && bulletRe.test(line)) return i;
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
