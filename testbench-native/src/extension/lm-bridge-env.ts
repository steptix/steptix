/**
 * What "TestBench: Use Copilot for AI" writes into the project `.env`
 * (stories/copilot-lm-bridge.md §The setup command, effect 3).
 *
 * Pure text in / text out — no `vscode`, no filesystem — because this file
 * holds the user's other secrets and the confirm they approve has to be the
 * literal thing that gets written. The only import is the runner-core scanner
 * that reads `.env` exactly the way the SERVER does, so "which line wins" here
 * is the same answer a run would get rather than a second grammar that drifts.
 */
import { scanServerEnv } from 'ai-ui-automation-runner-core';

/** The three lines this command owns. Nothing else in the file is touched. */
export const AI_MODEL = 'AI_MODEL';
export const AI_GATEWAY_URL = 'AI_GATEWAY_URL';
export const AI_API_KEY = 'AI_API_KEY';

/** Shown in the confirm and the file instead of the token itself. */
export const TOKEN_PLACEHOLDER = '<bridge token — kept in this machine\'s SecretStorage>';

/**
 * Stands in for the key the file already held.
 *
 * The `-` side of the diff is as sensitive as the `+` side: a project that
 * already had a real provider key would otherwise have it rendered in full in
 * a modal. A blank value is NOT masked — an empty `AI_API_KEY=` is the keyless
 * pin, and seeing that it was empty is the whole point of that line.
 */
export const PREVIOUS_KEY_PLACEHOLDER = '<the key this file already had>';

/**
 * The comment block written above the trio the first time.
 *
 * Both failure symptoms are named because neither is self-explanatory from the
 * server's error text: a refused connection reads as "the AI is down", and a
 * 401 from a loopback URL reads as "my key is wrong" when the key is simply
 * from a different machine.
 */
export const ENV_COMMENT_LINES = [
  '# Written by "TestBench: Use Copilot for AI" — AI runs on your GitHub Copilot',
  '# seat, through a bridge inside VS Code. It only answers while that window is',
  '# open, and only compile/repair/AI steps call it (a compiled run spends nothing).',
  '#   Connection refused / ECONNREFUSED → the bridge is not running: open this',
  '#     project in VS Code, or rerun "TestBench: Use Copilot for AI".',
  '#   401 from the bridge → this AI_API_KEY was minted on another machine.',
  '#     Settings Sync copies the bridge settings but not the token, which lives',
  '#     in this machine\'s VS Code SecretStorage. Rerun setup here either way.',
];

export interface EnvUpdateInput {
  /** Current file contents; `''` for a file that does not exist yet. */
  text: string;
  /** `gateway/<vendor>/<id>`. */
  model: string;
  /** `http://127.0.0.1:<port>` — no `/v1`, the client appends it. */
  gatewayUrl: string;
  /** The bridge token. Never rendered into {@link EnvUpdatePlan.preview}. */
  token: string;
}

export interface EnvChange {
  key: string;
  /** Present value, or null when the key is absent from the file. */
  from: string | null;
  /** Value after the write. Masked for the token — see {@link TOKEN_PLACEHOLDER}. */
  to: string;
}

export interface EnvUpdatePlan {
  /** Exactly what to write. */
  text: string;
  /** Nothing would change — the three lines already say this. */
  unchanged: boolean;
  changes: EnvChange[];
  /** Human-readable diff for the confirm, with the token masked. */
  preview: string;
  /**
   * The file carried a deliberately blank `AI_API_KEY=` and this write fills
   * it. That flips a project pinned keyless — the documented way to force zero
   * AI calls on CLI/CI — into a keyed one, so it must be said in words and not
   * left to be spotted in a diff.
   */
  flipsKeylessToKeyed: boolean;
  /** `SERVER_URL` as the file has it, or null. */
  serverUrl: string | null;
}

/**
 * Plan the `.env` write.
 *
 * Existing assignments are rewritten IN PLACE (the last one wins, matching the
 * server's own later-wins loop), so a file whose `AI_MODEL` sits under a
 * comment explaining it keeps that comment attached. Anything absent is
 * appended, once, under the comment block. Unrelated lines — every other
 * secret in the file — are never reordered or reformatted.
 */
export function planEnvUpdate(input: EnvUpdateInput): EnvUpdatePlan {
  const desired: Array<[string, string]> = [
    [AI_MODEL, input.model],
    [AI_GATEWAY_URL, input.gatewayUrl],
    [AI_API_KEY, input.token],
  ];

  const assignments = scanServerEnv(input.text);
  const lastOf = (key: string): { value: string; line: number } | null => {
    let found: { value: string; line: number } | null = null;
    for (const a of assignments) if (a.key === key) found = { value: a.value, line: a.line };
    return found;
  };

  const lines = input.text === '' ? [] : input.text.split('\n');
  // `scanServerEnv` splits on '\n' and lets its trim absorb a trailing '\r', so
  // a CRLF file parses identically — but writing a bare-'\n' line back into one
  // would leave the user's file with mixed endings. A rewritten line keeps the
  // ending it replaced; appended lines take the file's own.
  const cr = (index: number): string => ((lines[index] ?? '').endsWith('\r') ? '\r' : '');
  const fileCr = lines.some((l) => l.endsWith('\r')) ? '\r' : '';
  const changes: EnvChange[] = [];
  const toAppend: string[] = [];
  let flipsKeylessToKeyed = false;

  for (const [key, value] of desired) {
    const existing = lastOf(key);
    const from = existing?.value ?? null;
    const masked = key === AI_API_KEY ? TOKEN_PLACEHOLDER : value;
    if (existing) {
      if (existing.value !== value) {
        // A present-but-empty AI_API_KEY is a deliberate choice, not an
        // oversight: it is how a project is pinned keyless.
        if (key === AI_API_KEY && existing.value === '') flipsKeylessToKeyed = true;
        lines[existing.line] = `${key}=${value}${cr(existing.line)}`;
        changes.push({ key, from, to: masked });
      }
    } else {
      toAppend.push(`${key}=${value}${fileCr}`);
      changes.push({ key, from: null, to: masked });
    }
  }

  if (toAppend.length > 0) {
    // One blank line of separation, and the comment block only when something
    // is actually being appended — a file that only needed its port bumped
    // keeps the comment it already has instead of collecting a second copy.
    if (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() !== '') lines.push(fileCr);
    if (!input.text.includes(ENV_COMMENT_LINES[0]!)) {
      lines.push(...ENV_COMMENT_LINES.map((l) => `${l}${fileCr}`));
    }
    lines.push(...toAppend);
  }

  let text = lines.join('\n');
  if (text !== '' && !text.endsWith('\n')) text += '\n';

  const serverUrlEntry = lastOf('SERVER_URL');

  return {
    text,
    unchanged: changes.length === 0,
    changes,
    preview: renderPreview(changes),
    flipsKeylessToKeyed,
    serverUrl: serverUrlEntry ? serverUrlEntry.value : null,
  };
}

function renderPreview(changes: EnvChange[]): string {
  const shownFrom = (c: EnvChange): string =>
    c.key === AI_API_KEY && c.from ? PREVIOUS_KEY_PLACEHOLDER : (c.from ?? '');
  return changes
    .map((c) =>
      c.from === null
        ? `+ ${c.key}=${c.to}`
        : `- ${c.key}=${shownFrom(c)}\n+ ${c.key}=${c.to}`,
    )
    .join('\n');
}

/**
 * Is this `SERVER_URL` on the same machine as the bridge?
 *
 * The bridge binds 127.0.0.1, so a remote Sessions API server told to reach
 * `http://127.0.0.1:<port>` dials ITSELF and gets a connection refused — with
 * the `.env` looking entirely correct. Cheap to warn about, effectively
 * impossible to diagnose after the fact.
 */
export function isLocalServerUrl(url: string): boolean {
  const value = url.trim();
  if (!value) return true;
  let host: string;
  try {
    host = new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    // Unparseable is not evidence of remoteness; the run path will complain
    // about it in its own words, and a second warning here would just be noise.
    return true;
  }
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost')
  );
}
