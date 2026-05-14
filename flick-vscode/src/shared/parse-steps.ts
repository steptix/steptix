// Parses the raw input-box text into an array of step strings, per SPEC-FLICK.md
// "Step Input & Parsing": one step per non-empty line, with numbered ("1. ") and
// dashed ("- ") list prefixes stripped. Empty lines are ignored.

const NUMBERED = /^\s*\d+[.)]\s+/;
const DASHED = /^\s*[-*]\s+/;

export function parseSteps(rawText: string): string[] {
  return rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(NUMBERED, '').replace(DASHED, '').trim())
    .filter((line) => line.length > 0);
}
