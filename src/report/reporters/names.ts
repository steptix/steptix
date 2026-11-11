import { REPORTER_NAMES, type ReporterName } from './types.js';

/**
 * Reading the reporter names `steptix run` is given (docs/specs/SPEC-reporters.md
 * §4): from `--reporter`, which can be repeated and holds comma-separated
 * names, or else from `reports.reporters` in `steptix.config.json`.
 */

/** A name that is not one of {@link REPORTER_NAMES}, or a `--reporter` that
 *  names nothing. The message is the whole usage error, so the caller prints
 *  it as it is. */
export class ReporterNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReporterNameError';
  }
}

/** Where a list of names came from, for the error that refuses one. */
export type ReporterSource = { kind: 'flag' } | { kind: 'config'; file: string };

const VALID_LIST = REPORTER_NAMES.join(', ');

/**
 * The names in `values`, each of which may hold several separated by commas.
 * Letter case and spaces around a name do not matter, an empty piece (`a,,b`)
 * is ignored, and a name given twice counts once. The result keeps the order
 * the names were first given in.
 */
export function parseReporterNames(values: readonly string[], source: ReporterSource): ReporterName[] {
  const names: ReporterName[] = [];
  for (const value of values) {
    for (const piece of value.split(',')) {
      const name = piece.trim().toLowerCase();
      if (name === '') continue;
      if (!(REPORTER_NAMES as readonly string[]).includes(name)) {
        throw new ReporterNameError(unknownNameMessage(piece.trim(), source));
      }
      if (!names.includes(name as ReporterName)) names.push(name as ReporterName);
    }
  }
  return names;
}

function unknownNameMessage(name: string, source: ReporterSource): string {
  const where = source.kind === 'flag' ? '--reporter' : `reports.reporters in ${source.file}`;
  return `Unknown reporter "${name}" in ${where}. The reporters are ${VALID_LIST}.`;
}

/**
 * The reporters a run uses. `--reporter`, when given at all, replaces the
 * config list rather than adding to it (§4), so `flag` is undefined when the
 * option was absent and a list when it was present.
 *
 * `configValue` is `reports.reporters` as the loader left it. The loader does
 * not check it, because runs that are not `steptix run` share the loader and
 * must not fail over it; so a value that is not a list of strings is refused
 * here, naming the file.
 */
export function chooseReporters(
  flag: readonly string[] | undefined,
  configValue: unknown,
  configFile: string,
): ReporterName[] {
  if (flag !== undefined) {
    const names = parseReporterNames(flag, { kind: 'flag' });
    // `--reporter ""`, as a CI script with an unset variable sends. Taking it
    // as "no reporters" would quietly write nothing; refusing it says why.
    if (names.length === 0) {
      throw new ReporterNameError(`--reporter was given no name. The reporters are ${VALID_LIST}.`);
    }
    return names;
  }
  if (configValue === undefined || configValue === null) return [];
  if (!Array.isArray(configValue) || !configValue.every((v) => typeof v === 'string')) {
    throw new ReporterNameError(
      `reports.reporters in ${configFile} must be a list of names. The reporters are ${VALID_LIST}.`,
    );
  }
  return parseReporterNames(configValue as string[], { kind: 'config', file: configFile });
}
