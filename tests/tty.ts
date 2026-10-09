/**
 * Make a standard stream report `isTTY` as given, and hand back the function
 * that puts the stream's own property back — absent included, which is a
 * piped worker's usual state.
 *
 * The CLI runner reads `process.stdin.isTTY` to decide whether anyone can
 * answer a question at all (steptix/steptix#47), and `process.stdout.isTTY`
 * for whether the failure REPL can be seen. A vitest worker has whatever the
 * shell that started it had, so a test that is about either state sets it.
 */
export function setIsTTY(
  stream: NodeJS.ReadStream | NodeJS.WriteStream,
  value: boolean | undefined,
): () => void {
  const saved = Object.getOwnPropertyDescriptor(stream, 'isTTY');
  Object.defineProperty(stream, 'isTTY', { configurable: true, value });
  return () => {
    if (saved) Object.defineProperty(stream, 'isTTY', saved);
    else delete (stream as { isTTY?: boolean }).isTTY;
  };
}
