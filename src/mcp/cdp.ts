/**
 * The gate on which CDP browser an agent may drive.
 *
 * stories/mcp-cdp-browser.md §6. This reverses a shipped decision, so the
 * reasoning is recorded rather than assumed:
 *
 *   Before — `assemble.ts` refused any agent-supplied `cdp`, on the grounds
 *   that "that selects a live browser to attach to, which is not an agent's
 *   decision to make."
 *
 *   Now — an agent MAY select a browser **this project's framework launched**.
 *   Anything else still needs a human editing `aiui.config.json`.
 *
 * The original rationale is preserved rather than dropped. The agent chooses
 * among browsers it owns — ones this project started, into profile directories
 * this project created; a human decides whether it can reach anything else.
 * What changed is that "a browser we own" became a thing that exists.
 *
 * **The gate is MCP-side, not server-side.** The server cannot tell an agent
 * from a human: TestBench and flick are authenticated clients too, and
 * constraining them would be wrong. What needs constraining is an *agent*
 * choosing a browser, so the check lives where that choice is made.
 */

import { cdpPortNotOwned } from './errors.js';
import { PreflightFailure, type ApiClient, type CdpBrowsers } from './types.js';

/** What §6 permits for one project, read from `aiui.config.json`. */
export interface CdpPermissions {
  allowUnowned: boolean;
  ports: number[] | null;
}

/**
 * Decide whether an agent-supplied `cdp.port` may be used.
 *
 * Resolves against the live registry rather than anything cached: a browser
 * that was running when the agent listed is not necessarily running now, and
 * attaching to a port that has since been taken by something else is the
 * failure this exists to prevent.
 *
 * Throws `PreflightFailure` carrying a §7 message. Refusals happen before any
 * run starts, which is why they are `isError` results rather than run results.
 */
export async function assertPortAttachable(
  client: ApiClient,
  projectRoot: string,
  port: number,
  permissions: CdpPermissions,
  signal?: AbortSignal,
): Promise<void> {
  // `allowUnowned` short-circuits the whole check, including the round-trip. A
  // human has said this agent may drive any browser it can reach, and there is
  // nothing left to verify.
  if (permissions.allowUnowned) return;

  const browsers = await client.getCdpBrowsers(
    { projectRoot, includeForeign: true },
    signal,
  );

  if (browsers.running.some((b) => b.port === port)) return;

  // Not attachable — but *why* changes what the caller should do next, and one
  // of the two answers is the difference between relaunching a signed-in
  // profile and concluding the login is gone.
  if (browsers.foreign.some((b) => b.port === port)) {
    throw new PreflightFailure(cdpPortNotOwned(port, 'foreign'));
  }

  // A profile in `available` has no port to offer, so the port cannot be
  // matched against one directly. When exactly one profile is dormant it is
  // overwhelmingly the one the caller means — they had a port for it a moment
  // ago — and naming it makes the remediation concrete. With several, stay
  // general rather than guess wrong.
  if (browsers.available.length === 1) {
    const only = browsers.available[0]!;
    throw new PreflightFailure(
      cdpPortNotOwned(port, 'available', { profile: only.profile, engine: only.engine }),
    );
  }

  throw new PreflightFailure(cdpPortNotOwned(port, 'nowhere'));
}

/**
 * Whether foreign tab titles and URLs may be shown.
 *
 * A foreign browser's open tabs may be someone's mail or their bank, and for
 * an MCP caller that payload goes straight to a model provider. Seeing that a
 * browser exists is not the same as reading what is in it, which is why the
 * list still reports foreign browsers with `tabsWithheld: true`.
 */
export function maySeeForeignTabs(permissions: CdpPermissions): boolean {
  return permissions.allowUnowned;
}

/** A short human summary of a listing, for `content[0]`. */
export function summarizeBrowsers(browsers: CdpBrowsers): string {
  const parts = [
    `${browsers.running.length} running`,
    `${browsers.available.length} available (not started)`,
  ];
  if (browsers.foreign.length > 0) parts.push(`${browsers.foreign.length} foreign`);
  return parts.join(', ');
}
