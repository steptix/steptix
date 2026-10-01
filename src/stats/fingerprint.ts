/**
 * Which rules, and which build, a line was written under (§5.5) — so a change
 * to the step prompt can be judged by the lines on either side of it
 * (`steptix stats --by prompt`).
 */
import crypto from 'node:crypto';
import { buildSystemPrompt, contentBlocksToText, type SystemPromptOptions } from '../ai/prompts.js';
import { getBuildInfo, getPackageVersion } from '../utils/version.js';

const fingerprints = new Map<string, string>();

/**
 * `p-` and the first 6 hex digits of the SHA-256 of the step prompt's RULES:
 * `buildSystemPrompt('')` under the run's own options.
 *
 * The first argument is where a project's context files go, so leaving it
 * empty is what makes the fingerprint change exactly when the framework's
 * rules change, and lets two projects on the same rules share one. The rules
 * text is built to be byte-identical on every call (providers cache it,
 * src/ai/prompts.ts), so it is computed once per process and option set.
 */
export function rulesFingerprint(opts: SystemPromptOptions = {}): string {
  const key = optionKey(opts);
  const known = fingerprints.get(key);
  if (known !== undefined) return known;
  const rules = contentBlocksToText(buildSystemPrompt('', undefined, opts));
  const fingerprint = `p-${crypto.createHash('sha256').update(rules).digest('hex').slice(0, 6)}`;
  fingerprints.set(key, fingerprint);
  return fingerprint;
}

/** The option set as a cache key: the options that are set, in name order —
 *  so an option added to `SystemPromptOptions` later is keyed without this
 *  file changing. `{}` and `{ dismissalGuidance: false }` key apart and hash
 *  alike, which costs one extra entry and nothing else. */
function optionKey(opts: SystemPromptOptions): string {
  const set = Object.entries(opts).filter(([, value]) => value !== undefined);
  set.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(set);
}

let version: { value: string | undefined } | undefined;

/**
 * The package version, plus `+<short commit>` when `dist/` was built from a
 * git checkout: `1.0.0+b700473`. Read once per process.
 *
 * The commit is the one stamped at build time (`getBuildInfo`), so it names
 * the code that ran, not whatever the checkout had moved on to since. A dirty
 * build carries the same form; `/health` is where `dirty` shows.
 *
 * `undefined` when the version is unknown — absent, never guessed (§5.5). A
 * build from outside a checkout reports the version alone.
 */
export function frameworkVersion(): string | undefined {
  if (version === undefined) {
    const pkg = getPackageVersion();
    const known = pkg === 'unknown' ? undefined : pkg;
    const commit = known === undefined ? null : getBuildInfo().commit;
    version = { value: known !== undefined && commit !== null ? `${known}+${commit}` : known };
  }
  return version.value;
}
