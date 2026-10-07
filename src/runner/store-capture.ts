import { bindVariable } from '../parser/parameters.js';
import { logger } from '../utils/logger.js';
import { maskRecordSecrets, redact } from '../utils/secrets.js';

/**
 * What one read, count or table read captured, as `executeAction` returns it.
 * At most one of the three is set; records win, then a list, then a value.
 */
export interface CapturedResult {
  capturedRecords?: Array<Record<string, string>> | undefined;
  capturedValues?: string[] | undefined;
  capturedValue?: string | undefined;
}

/**
 * Store a capture under `name` in the live parameter map, and say so — the one
 * implementation the AI path and a compiled `step.read` / `step.count` share
 * (docs/specs/SPEC-codebehind-robustness.md §6.6), so a step compiled from its
 * recording stores exactly what the run stored, the way the run stored it.
 * Returns what was stored, or undefined when nothing was captured.
 *
 * All three through `bindVariable` (src/parser/parameters.ts), because a
 * capture can land on a name a `For each` is binding — `Read the order id from
 * the summary [store as: order]` after `For each {{order}} in {{orders}}` —
 * and §8.2 says a rebind of a root erases that root's dotted keys. A plain
 * `params[name] =` left `order.id` holding the LAST PASS's id, so
 * `{{order.id}}` in a later step substituted a row the author had just
 * overwritten, silently.
 *
 * `secrets` is asked AFTER the bind, so the name the author just chose is
 * already in the map the mask set is built from.
 */
export function storeCapture(
  params: Record<string, string>,
  name: string,
  result: CapturedResult,
  secrets: () => string[],
): string | undefined {
  if (result.capturedRecords !== undefined) {
    // Structured capture (readTable) — JSON-encoded like the flat list, so
    // the map stays Record<string, string> and no protocol or session
    // storage migrates (SPEC-structured-table-reads.md §7.1). `For each`
    // parses it back and binds each record's properties.
    //
    // The capture itself is summarised by `readTable captured N rows × M
    // columns as "{{name}}"` (§7.6), written where the bound and the
    // placeholder-skip count are known — in executeAction. This line is
    // about STORAGE, and reads like its two siblings below.
    const rows = result.capturedRecords.length;
    const stored = JSON.stringify(result.capturedRecords);
    bindVariable(params, name, stored);
    logger.info(`Stored ${rows} row record${rows === 1 ? '' : 's'} as "{{${name}}}"`);
    return stored;
  }
  if (result.capturedValues !== undefined) {
    // List capture (read multiple: true) — JSON-encode so it round-trips
    // through the string-valued param map. Tools that declare an
    // array-typed parameter decode this back into a typed array at the
    // bridge boundary.
    const stored = JSON.stringify(result.capturedValues);
    bindVariable(params, name, stored);
    logger.info(
      `Stored ${result.capturedValues.length} captured value${
        result.capturedValues.length === 1 ? '' : 's'
      } as "{{${name}}}"`,
    );
    return stored;
  }
  if (result.capturedValue !== undefined) {
    bindVariable(params, name, result.capturedValue);
    // The only one of the three "Stored …" lines that prints the VALUE, and
    // it printed it raw once. `logger` does not redact — the run-log file
    // does, on its way to disk, and the SSE `output` bridge does not — so a
    // `[store as: password]` capture reached the console and every client
    // watching the stream in clear (§7.6). Masked after the bind, so the name
    // the author just chose is already in the map the set is built from; by
    // shape as well as by value, because a one-row read stores a record under
    // a name that says nothing.
    //
    // It is also the ONLY line that prints a capture. `executeRead`
    // (src/browser/actions.ts) had one of its own — raw, and one frame too
    // deep to ever mask, because down there the value has no name yet
    // (review 6, finding 2). Masking has to happen where the name is, so the
    // line lives here and there is exactly one of it.
    logger.info(
      `Stored captured value as "{{${name}}}": "${redact(maskRecordSecrets(result.capturedValue), secrets())}"`,
    );
    return result.capturedValue;
  }
  return undefined;
}
