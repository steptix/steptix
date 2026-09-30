import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tool } from 'steptix/tools';

/**
 * Write the test's variables as one JSON object per call, one line each, to a
 * JSON Lines file:
 *
 *   [tool: save_json file="output/customers.jsonl" key="customer_id" customer_id firstname lastname]
 *
 * Every argument except `file` and `key` becomes a field. A bare name is the
 * shorthand for `name="{{name}}"`, so the variable names become the JSON keys,
 * and every value is written as a string.
 *
 * `key` names the field that identifies a record: a line already holding the
 * same value for it is replaced where it sits, so running a data-driven test
 * again — or one row of it — updates that row's line instead of adding a
 * second one. Without `key`, every call appends. Nothing clears the file at
 * the start of a run; delete it to start over.
 *
 * A relative `file` resolves against the project root: the nearest folder
 * above this tool holding a `steptix.config.json`. A tool is not told the root,
 * and the server runs a bundled copy of this file from elsewhere, but it pins
 * `import.meta.dirname` to this file's own folder, so the walk starts here.
 */
export default tool(async ({ args, log }) => {
  const { file, key, ...fields } = args as Record<string, string>;
  if (!file) throw new Error('save_json needs file="…"');
  if (key !== undefined && !(key in fields)) {
    throw new Error(`key="${key}" is not one of the fields: ${Object.keys(fields).join(', ')}`);
  }

  // A variable nothing captured reaches a tool as the literal "{{name}}".
  const missing = Object.entries(fields)
    .filter(([, value]) => /^\{\{.+\}\}$/.test(value))
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Never captured, so not saved: ${missing.join(', ')}`);
  }

  const target = path.isAbsolute(file) ? file : path.resolve(projectRoot(), file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const line = JSON.stringify(fields);

  if (key === undefined) {
    await fs.appendFile(target, `${line}\n`);
    log.info(`Appended ${Object.keys(fields).join(', ')} to ${target}`);
    return;
  }

  let lines: string[] = [];
  try {
    lines = (await fs.readFile(target, 'utf8')).split('\n').filter((l) => l.trim() !== '');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // Replace in place, so the file keeps the order the rows first ran in.
  const at = lines.findIndex((l) => JSON.parse(l)[key] === fields[key]);
  if (at === -1) lines.push(line);
  else lines[at] = line;
  await fs.writeFile(target, lines.join('\n') + '\n');
  log.info(`${at === -1 ? 'Added' : 'Replaced'} ${key}=${fields[key]} in ${target}`);
});

function projectRoot(): string {
  for (let dir = import.meta.dirname; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'steptix.config.json'))) return dir;
    if (path.dirname(dir) === dir) {
      throw new Error(
        `save_json found no steptix.config.json above ${import.meta.dirname}; pass an absolute file="…"`,
      );
    }
  }
}
