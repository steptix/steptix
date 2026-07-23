import { InvalidArgumentError } from 'commander';

/**
 * Commander arg parser for a non-negative whole number, throwing
 * `InvalidArgumentError` so commander renders the usage error for free.
 *
 * `Number(...)`, not `parseInt`: `parseInt` accepts a numeric *prefix*, so
 * `--idle-timeout 0.5` becomes `0` and `60m` becomes `60`. The first silently
 * disarms the very timeout the user asked for — exactly the failure this
 * parser exists to prevent — and the second silently means something else.
 *
 * Lives in its own dependency-free module so it can be tested without pulling
 * the server (and through it, playwright) into the test's module graph.
 */
export function nonNegativeInt(value: string): number {
  // `Number('')` and `Number('  ')` are 0, which would read as "disabled"
  // rather than "you didn't give me a value".
  if (value.trim() === '') throw new InvalidArgumentError('Expected a non-negative whole number.');
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError('Expected a non-negative whole number.');
  }
  return parsed;
}
