/**
 * What VS Code says about compiled steps a newer Steptix wrote
 * (docs/specs/SPEC-install.md §4.13). The server sends its notice with a
 * `newerCompiled` field (protocol.ts, OutputEvent); a client that knows the
 * field says it in its own words, naming the extension update and its
 * Compile command where the server can only say "update Steptix".
 */

export interface NewerCompiled {
  /** The compiled steps file, absolute. */
  file: string;
  /** The version that compiled it, as its stamp says. */
  version: string;
  /** How many of the run's steps it has entries for. */
  steps: number;
}

/** `1.5.2` → `1.5`. */
function majorMinor(version: string): string {
  const m = /^\s*(\d+)\.(\d+)/.exec(version);
  return m ? `${m[1]}.${m[2]}` : version;
}

/** The line VS Code shows for the notice. */
export function newerCompiledText(newer: NewerCompiled): string {
  const by = `Steptix ${majorMinor(newer.version)}`;
  const base = newer.file.split(/[\/]/).pop() ?? newer.file;
  const what =
    newer.steps > 0
      ? `${newer.steps} step${newer.steps === 1 ? ' was' : 's were'} compiled by ${by} and ran with the AI instead.`
      : `The compiled steps in ${base} were written by ${by} and are not used by this version.`;
  return `${what} Update the Steptix extension to use them, or recompile them with this version: Steptix: Compile Code-behind.`;
}

/** An output event's message as VS Code shows it. */
export function outputText(event: { msg: string; newerCompiled?: NewerCompiled }): string {
  return event.newerCompiled ? newerCompiledText(event.newerCompiled) : event.msg;
}
