/**
 * GitHub Copilot from a terminal (docs/specs/SPEC-install.md §7.2).
 *
 * Copilot reaches Steptix through the bridge inside a VS Code window
 * (stories/copilot-lm-bridge.md), so a `steptix` command in a terminal can
 * use it only while that window is open. When the project's AI is Copilot
 * and the bridge does not answer, the command says so and what to do, rather
 * than failing later to connect.
 */

export const COPILOT_IN_TERMINAL =
  'Copilot works only inside VS Code. To use the AI from a terminal, run steptix ai.';

/** True when the AI is Copilot through the bridge, and the bridge does not answer. */
export async function copilotOutOfReach(
  ai: { model: string; gatewayUrl?: string | undefined },
  fetchFn: (url: string, init: { signal: AbortSignal }) => Promise<unknown> = (url, init) => fetch(url, init),
): Promise<boolean> {
  if (!/^gateway\/copilot\//.test(ai.model)) return false;
  const base = ai.gatewayUrl?.trim().replace(/\/+$/, '');
  if (!base) return true;
  try {
    // Any answer, a refusal for want of the token included, means it is there.
    await fetchFn(`${base}/v1/models`, { signal: AbortSignal.timeout(2_000) });
    return false;
  } catch {
    return true;
  }
}
