// Pure logic for the batch-result outputs panel: split a batch's outputs into
// source-tagged sections (Captures / Tool Outputs / Parameters) and apply the
// delta filter, with a backward-compat fallback for older servers that don't
// send `outputSources`. Kept DOM-free so it can be unit-tested directly under
// `node --test` without a webview harness (see tests/unit/output-sections.test.ts).

import type { OutputSource } from '../shared/protocol';

export type OutputSectionKind = 'capture' | 'toolOutput' | 'parameter' | 'unknown';

export interface OutputSection {
  kind: OutputSectionKind;
  /** Heading text shown for the section. */
  label: string;
  /** True for the Parameters section — rendered behind a collapsible summary. */
  collapsed: boolean;
  /** Surviving entries (after the delta filter), in insertion order. */
  entries: Array<[string, string]>;
}

/**
 * Build the ordered list of output sections for one batch.
 *
 * @param outputs        This batch's `outputs` map.
 * @param outputSources  Per-key source labels, or `undefined` for an older
 *                       server (triggers the single-block fallback).
 * @param previousOutputs The previous result batch's `outputs` in the same
 *                       session history, used for the delta filter. Pass `{}`
 *                       (or `undefined`) when this is the first batch.
 *
 * Ordering: Captures → Tool Outputs → Parameters.
 * Delta filter: Captures and Tool Outputs only include keys that are NEW or
 * CHANGED versus `previousOutputs`. Parameters are never delta-filtered (they
 * are stable for the session; the collapsed summary handles their noise).
 * A section is omitted entirely when it has no surviving entries.
 */
export function buildOutputSections(
  outputs: Record<string, string>,
  outputSources: Record<string, OutputSource> | undefined,
  previousOutputs: Record<string, string> | undefined,
): OutputSection[] {
  const all = Object.entries(outputs ?? {});
  if (all.length === 0) return [];

  // Backward compat: no source map → render the legacy single un-labelled
  // block. Treat every key as "unknown" source and apply no delta filter.
  if (!outputSources) {
    return [
      { kind: 'unknown', label: 'Outputs', collapsed: false, entries: all },
    ];
  }

  const prev = previousOutputs ?? {};
  const isNewOrChanged = (key: string, value: string): boolean =>
    !(key in prev) || prev[key] !== value;

  const captures: Array<[string, string]> = [];
  const toolOutputs: Array<[string, string]> = [];
  const parameters: Array<[string, string]> = [];

  for (const [key, value] of all) {
    // An entry present in `outputs` but missing from `outputSources` is
    // treated conservatively as a capture (matches the streaming-event
    // default in the spec's backward-compat table).
    const source: OutputSource = outputSources[key] ?? 'capture';
    if (source === 'parameter') {
      parameters.push([key, value]);
    } else if (source === 'toolOutput') {
      if (isNewOrChanged(key, value)) toolOutputs.push([key, value]);
    } else {
      if (isNewOrChanged(key, value)) captures.push([key, value]);
    }
  }

  const sections: OutputSection[] = [];
  if (captures.length > 0) {
    sections.push({ kind: 'capture', label: 'Captures', collapsed: false, entries: captures });
  }
  if (toolOutputs.length > 0) {
    sections.push({
      kind: 'toolOutput',
      label: 'Tool Outputs',
      collapsed: false,
      entries: toolOutputs,
    });
  }
  if (parameters.length > 0) {
    sections.push({
      kind: 'parameter',
      label: 'Parameters',
      collapsed: true,
      entries: parameters,
    });
  }
  return sections;
}
