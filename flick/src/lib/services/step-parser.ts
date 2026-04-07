export function parseSteps(input: string): string[] {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      // Strip numbered list prefix: "1. ", "2) ", etc.
      const numbered = line.match(/^\d+[\.\)]\s+(.+)/);
      if (numbered) return numbered[1];

      // Strip dash prefix: "- "
      const dashed = line.match(/^-\s+(.+)/);
      if (dashed) return dashed[1];

      return line;
    });
}
