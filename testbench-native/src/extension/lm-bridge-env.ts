/**
 * What "TestBench: Use Copilot for AI" writes into the project `.env` — or
 * into the active environment's `.env.<name>`, when that overlay would
 * otherwise shadow the trio (stories/copilot-lm-bridge.md §The setup command,
 * effect 3; stories/env-overlay-awareness.md Part A).
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
 * The head of the comment block: what this file is, and the two failure
 * symptoms that are the same wherever the trio lives.
 *
 * Both are named because neither is self-explanatory from the server's error
 * text: a refused connection reads as "the AI is down", and a 401 from a
 * loopback URL reads as "my key is wrong" when the key is simply from a
 * different machine.
 */
const ENV_COMMENT_HEAD = [
  '# Written by "TestBench: Use Copilot for AI" — AI runs on your GitHub Copilot',
  '# seat, through a bridge inside VS Code. It only answers while that window is',
  '# open, and only compile/repair/AI steps call it (a compiled run spends nothing).',
  '#   Connection refused / ECONNREFUSED → no bridge is running on this machine.',
  '#     Open this project in VS Code and run "TestBench: Use Copilot for AI" here.',
  '#   401 from the bridge → this machine\'s bridge mints its own token, and this',
  '#     AI_API_KEY is not it (the file came from another machine, or the token was',
  '#     reset). It lives in VS Code SecretStorage. Rerun setup in this window.',
];

/**
 * The third 401 cause, and the one the base `.env` cannot see: an active
 * environment's `.env.<name>` carries its own `AI_API_KEY`, which beats every
 * line in this file on every run. "Rerun setup" alone does not fix that —
 * setup finds this file already correct and writes nothing — so the remedy has
 * to be spelled out where the lines it is about actually live.
 */
const OVERLAY_CAUSE_LINES = [
  '#   401 with these lines looking correct → an active environment (the',
  '#     testbench-native.activeEnv setting) whose .env.<name> sets its own',
  '#     AI_API_KEY beats this file on every run. Clear the env, or rerun setup',
  '#     with it active to write these lines into that file instead.',
];

/** The comment block written above the trio the first time, in a base `.env`. */
export const ENV_COMMENT_LINES = [...ENV_COMMENT_HEAD, ...OVERLAY_CAUSE_LINES];

/**
 * The comment block for the file this write targets.
 *
 * In `.env.<name>` the overlay cause is inverted — this file IS the winner —
 * so naming it there would describe a mechanism that cannot bite. What that
 * file needs instead is the caveat the head's "rerun setup in this window"
 * leaves out: setup lands here only while this env is the active one, and the
 * CLI reaches these lines only when told `--env <name>`.
 */
export function envCommentLines(envName: string | null): string[] {
  if (envName === null) return ENV_COMMENT_LINES;
  return [
    ...ENV_COMMENT_HEAD,
    `#   These lines are in .env.${envName}, which beats .env — but only while`,
    `#     "${envName}" is the active environment (testbench-native.activeEnv), or`,
    `#     the CLI is given --env ${envName}. Rerunning setup under a different env`,
    '#     writes to that env\'s file instead and leaves these lines behind, stale.',
  ];
}

/**
 * Which of the trio a `.env.<name>` overlay sets, in trio order.
 *
 * All three, not just the token: they are applied independently on the server,
 * so an overlay carrying only `AI_MODEL=openai/…` still composes a run that
 * posts the bridge token to OpenAI. Read with the scanner the server itself
 * uses, so "does this line count" has one answer.
 */
export function overlayBridgeKeys(text: string): string[] {
  const present = new Set(scanServerEnv(text).map((a) => a.key));
  return [AI_MODEL, AI_GATEWAY_URL, AI_API_KEY].filter((key) => present.has(key));
}

/** Last `SERVER_URL` assignment in a `.env`, or null — later wins, as a run does. */
export function serverUrlIn(text: string): string | null {
  let value: string | null = null;
  for (const a of scanServerEnv(text)) if (a.key === 'SERVER_URL') value = a.value;
  return value;
}

export interface EnvUpdateInput {
  /** Current file contents; `''` for a file that does not exist yet. */
  text: string;
  /** `gateway/<vendor>/<id>`. */
  model: string;
  /** `http://127.0.0.1:<port>` — no `/v1`, the client appends it. */
  gatewayUrl: string;
  /** The bridge token. Never rendered into {@link EnvUpdatePlan.preview}. */
  token: string;
  /**
   * Which file this plan is for: `null` for the base `.env`, the env name when
   * it targets that env's `.env.<name>` overlay. It changes only the comment
   * block — the trio written is the same either way, because a file that
   * carries part of it composes a run nobody can diagnose.
   */
  envName?: string | null;
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
 * Plan the write into the file {@link EnvUpdateInput.envName} names.
 *
 * Whichever file that is, it receives the WHOLE trio: the three are applied
 * independently on the server, so half of them in the winning file composes a
 * run that fails in a way no message explains.
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
    // The first line is the marker for "this file already has the block", and
    // it is the same sentence in both variants — so switching target never
    // stacks a second copy on a file that already carries one.
    if (!input.text.includes(ENV_COMMENT_HEAD[0]!)) {
      lines.push(...envCommentLines(input.envName ?? null).map((l) => `${l}${fileCr}`));
    }
    lines.push(...toAppend);
  }

  let text = lines.join('\n');
  if (text !== '' && !text.endsWith('\n')) text += '\n';

  return {
    text,
    unchanged: changes.length === 0,
    changes,
    preview: renderPreview(changes),
    flipsKeylessToKeyed,
    serverUrl: serverUrlIn(input.text),
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
