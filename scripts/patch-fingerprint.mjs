// One-off patch: rewrite fingerprintAssertion to accept `expected: string |
// undefined` (predicate mode) while preserving the NUL-byte delimiters in
// the hash input that the original author used. Edit tool can't safely
// match the NUL-containing template literal, so this script does it
// programmatically. Idempotent — re-runs report "already patched".
import fs from 'node:fs';
const target = 'src/cache/step-cache.ts';
const data = fs.readFileSync(target);
const text = data.toString('binary');

const NUL = '\x00';
const oldFn =
  `export function fingerprintAssertion(\n` +
  `  condition: string,\n` +
  `  expected: string,\n` +
  `  assertIndex: number,\n` +
  `): string {\n` +
  `  return createHash('sha256')\n` +
  `    .update(\`\${assertIndex}${NUL}\${condition}${NUL}\${expected}\`)\n` +
  `    .digest('hex')\n` +
  `    .slice(0, 16);\n` +
  `}`;

const newFn =
  `/**\n` +
  ` * \`expected\` is \`undefined\` for predicate-mode assertions (no comparison\n` +
  ` * literal — both sides are already in \`condition\`). A sentinel keeps the\n` +
  ` * hash space distinct from any conceivable real \`expected\` value, so a\n` +
  ` * DOM assertion with \`expected: ""\` and a predicate assertion with the\n` +
  ` * same \`condition\` cache to different keys.\n` +
  ` */\n` +
  `const PREDICATE_EXPECTED_SENTINEL = '\\u2205'; // U+2205 EMPTY SET — never appears in real expected literals.\n` +
  `\n` +
  `export function fingerprintAssertion(\n` +
  `  condition: string,\n` +
  `  expected: string | undefined,\n` +
  `  assertIndex: number,\n` +
  `): string {\n` +
  `  const expectedKey = expected === undefined ? PREDICATE_EXPECTED_SENTINEL : expected;\n` +
  `  return createHash('sha256')\n` +
  `    .update(\`\${assertIndex}${NUL}\${condition}${NUL}\${expectedKey}\`)\n` +
  `    .digest('hex')\n` +
  `    .slice(0, 16);\n` +
  `}`;

if (text.includes(newFn)) {
  console.log('already patched');
  process.exit(0);
}

if (!text.includes(oldFn)) {
  console.error('FAIL: old fingerprintAssertion block not found verbatim');
  process.exit(1);
}

const patched = text.replace(oldFn, newFn);
fs.writeFileSync(target, Buffer.from(patched, 'binary'));
console.log('OK');
