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

import {
  cdpPortNotOwned,
  cdpProfileAmbiguous,
  cdpProfileNotRunning,
  cdpTargetAmbiguous,
  type CdpAddressMismatch,
  type McpToolError,
} from './errors.js';
import {
  PreflightFailure,
  type ApiClient,
  type CdpBrowsers,
  type CdpTarget,
} from './types.js';

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
 * failure this exists to prevent. The listing spans both roots — the
 * project's and the user root's — so a user-scope browser passes the gate
 * from anywhere without `allowUnowned` (stories/mcp-no-project.md rule 4).
 *
 * `configPath` is the file a human would edit to widen reach; the refusal
 * names it, and it differs by scope — the project's own config, or the user
 * root's (which may not exist yet).
 *
 * Throws `PreflightFailure` carrying a §7 message. Refusals happen before any
 * run starts, which is why they are `isError` results rather than run results.
 */
export async function assertPortAttachable(
  client: ApiClient,
  projectRoot: string,
  port: number,
  permissions: CdpPermissions,
  configPath: string,
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
    throw new PreflightFailure(cdpPortNotOwned(port, 'foreign', configPath));
  }

  // A profile in `available` has no port to offer, so the port cannot be
  // matched against one directly. When exactly one profile is dormant it is
  // overwhelmingly the one the caller means — they had a port for it a moment
  // ago — and naming it makes the remediation concrete. With several, stay
  // general rather than guess wrong.
  if (browsers.available.length === 1) {
    const only = browsers.available[0]!;
    throw new PreflightFailure(
      cdpPortNotOwned(port, 'available', configPath, {
        profile: only.profile,
        engine: only.engine,
      }),
    );
  }

  throw new PreflightFailure(cdpPortNotOwned(port, 'nowhere', configPath));
}

/**
 * Turn a tool-supplied `config.cdp` into a port.
 *
 * A profile name is the address we want an agent to use: `chrome/default` is
 * the same browser and the same logins tomorrow, while a port is reassigned on
 * every launch — which is why an agent that had *just* started a CDP browser
 * still ran its next steps in a fresh one. It could not carry the number.
 *
 * Resolution happens here rather than on the wire so `session-manager.ts` keeps
 * receiving `{port, tab?}` unchanged. It also settles the §6 gate for free: a
 * port read out of this project's own `running` list is by construction one
 * this project launched, so `assertPortAttachable` has nothing left to check
 * and is skipped. That is a narrowing, not a loophole — the agent named a
 * profile, and only our own registry could turn it into a port.
 *
 * Returns the port, and whether the caller still owes a gate check.
 *
 * `ambiguous` lets a caller supply its own refusal messages. Several tools
 * share this resolution but not their argument names — `run_steps` nests the
 * address under `config.cdp`, while `close_cdp_tab` and `focus_cdp_tab` take
 * it at the top level — and an error telling an agent to fix `config.cdp` on a
 * call that has no `config` is one it cannot act on. The message also carries
 * the stakes, which differ: closing the wrong tab cannot be undone, focusing
 * the wrong one is a nuisance. Called with `null` when no address was given at
 * all, or with the facts of a `profile`/`port` pair that does not name one
 * browser — the port belongs to a different browser, or to none.
 */
export async function resolveCdpTarget(
  client: ApiClient,
  projectRoot: string,
  target: CdpTarget,
  signal?: AbortSignal,
  ambiguous: (mismatch: CdpAddressMismatch | null) => McpToolError = cdpTargetAmbiguous,
): Promise<{ port: number; gateOwed: boolean; scope?: 'project' | 'user' }> {
  const hasProfile = target.profile !== undefined && target.profile.trim() !== '';
  const hasPort = target.port !== undefined;

  if (!hasProfile && !hasPort) throw new PreflightFailure(ambiguous(null));

  if (!hasProfile) return { port: target.port!, gateOwed: true };

  const profile = target.profile!.trim();
  const engine = target.engine?.trim() ?? null;
  // `scope` narrows the same way `engine` does — a name may exist in both the
  // project and the user root, and those are different browsers with
  // different logins (stories/mcp-no-project.md). A server predating the
  // field reports no scope; those entries read as `project`, the only scope
  // such a server can have swept.
  const scope = target.scope ?? null;
  const browsers = await client.getCdpBrowsers({ projectRoot, includeForeign: false }, signal);

  const running = browsers.running.map((b) => ({ ...b, scope: b.scope ?? ('project' as const) }));
  const matches = running.filter(
    (b) =>
      b.profile === profile &&
      (engine === null || b.engine === engine) &&
      (scope === null || b.scope === scope),
  );

  // A pair is resolved-and-compared, not refused: an agent that just read a
  // listing row holds `profile` AND `port` for the same browser, and echoing
  // both back is precision, not ambiguity. Agreement also settles a profile
  // name that is running more than once — a port belongs to exactly one
  // browser, so the pair names one browser or none. What is still refused,
  // loudly and with both facts, is a pair that disagrees — the port names a
  // different browser, or none. That has no correct winner, and silently
  // picking one is the shape of the bug this story exists to remove.
  if (hasPort) {
    const agreed = matches.find((b) => b.port === target.port);
    if (agreed !== undefined) return { port: agreed.port, gateOwed: false, scope: agreed.scope };
    if (matches.length > 0) {
      throw new PreflightFailure(
        ambiguous({
          profile,
          matches: matches.map((b) => ({ engine: b.engine, scope: b.scope, port: b.port })),
          given: target.port!,
        }),
      );
    }
    // Nothing matches the name as narrowed by engine/scope — either the
    // profile's browser is stopped, or the narrowing excluded the running
    // name-bearer the port points at. Both read the same to the caller: the
    // profile half of the pair failed, so it falls through to the profile
    // refusals, which name the exact ask and list what IS running.
  }

  // The matched entry's scope rides back for the callers' result summaries —
  // a profile-resolved port already knows which root it came from, and the
  // server echo may be missing on an older build.
  if (matches.length === 1) {
    return { port: matches[0]!.port, gateOwed: false, scope: matches[0]!.scope };
  }

  // One name, several browsers — engines sharing it, roots sharing it, or
  // both. Naming every match beats guessing: the wrong one is a browser
  // signed in as somebody else, and refusing (never precedence) is the
  // story's locked decision.
  if (matches.length > 1) {
    throw new PreflightFailure(
      cdpProfileAmbiguous(
        profile,
        matches.map((b) => ({ engine: b.engine, scope: b.scope })),
      ),
    );
  }

  throw new PreflightFailure(
    cdpProfileNotRunning(
      profile,
      engine,
      running.map((b) => ({ engine: b.engine, profile: b.profile, scope: b.scope })),
    ),
  );
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

/** A short human summary of a listing, for `content[0]`. The user-root count
 *  is called out because it is the one a reader will not expect from a
 *  project-scoped call — those browsers are theirs from anywhere. */
export function summarizeBrowsers(browsers: CdpBrowsers): string {
  const userRunning = browsers.running.filter((b) => b.scope === 'user').length;
  const parts = [
    `${browsers.running.length} running` +
      (userRunning > 0 ? ` (${userRunning} user-root)` : ''),
    `${browsers.available.length} available (not started)`,
  ];
  if (browsers.foreign.length > 0) parts.push(`${browsers.foreign.length} foreign`);
  return parts.join(', ');
}
