// Generate the JSON Schema for `aiui.config.json` from the `UserConfig`
// TypeScript type, so the schema can never drift from the source of truth in
// src/config/types.ts. JSDoc comments on the config interfaces become schema
// `description`s (editor hover docs); string-union types become enums.
//
// We inject an allowed top-level `$schema` string property after generation:
// the generator emits `additionalProperties: false`, which would otherwise
// reject the very `"$schema": "..."` line users add to opt into validation.
//
// Run via `npm run build:schema` (also chained into `npm run build`).

import { createGenerator } from 'ts-json-schema-generator';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const outPath = path.join(projectRoot, 'schema', 'aiui.config.schema.json');

const schema = createGenerator({
  path: path.join(projectRoot, 'src/config/types.ts'),
  tsconfig: path.join(projectRoot, 'tsconfig.json'),
  type: 'UserConfig',
  topRef: true,
  skipTypeCheck: true,
}).createSchema('UserConfig');

// Allow the editor-only `$schema` key on the root object. The loader strips it
// before merging, but it must validate so VS Code doesn't flag it. The root
// chains UserConfig -> DeepPartial<Config> via $ref (URI-encoded), so follow
// the chain to the definition that actually carries `properties`.
function followRef(node) {
  let cur = node;
  const seen = new Set();
  while (cur && cur.$ref && !seen.has(cur.$ref)) {
    seen.add(cur.$ref);
    const name = decodeURIComponent(cur.$ref.replace('#/definitions/', ''));
    cur = schema.definitions?.[name];
  }
  return cur;
}

const root = followRef(schema);
if (root && typeof root === 'object' && root.properties) {
  root.properties.$schema = {
    type: 'string',
    description: 'URL or path to this JSON Schema, enabling editor autocomplete and validation. Ignored at runtime.',
  };
} else {
  throw new Error('build-schema: could not locate root properties to inject $schema');
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(schema, null, 2) + '\n');
console.log(`Wrote ${path.relative(projectRoot, outPath)}`);
