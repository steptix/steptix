/**
 * `desktop` and `browser.launchArgs`
 * (docs/specs/SPEC-use-computer.md §5.10; acceptance §13.1 "config defaults
 * and schema", §13 item 7).
 *
 * Note where the two halves of "validation" live. `loadConfig` has no
 * per-key type checking for the rest of the file — it deep-merges a parsed
 * JSON object over the defaults, and has done since long before this section
 * — so for most keys what it is asserted to do here is MERGE correctly: a
 * partial `desktop` block inherits its sibling defaults, and an absent one
 * leaves `enabled` false. The `desktop` section is the exception, typed at
 * load (the block after the merge tests), because two of its keys are the
 * opt-in and the privacy switch and a wrong-typed value used to flip both.
 * The generated JSON schema rejects the same values in the editor, and the
 * last block tests it there.
 *
 * And the one place a project's config comes from that is not its own file:
 * `aiui init`, which must not hand a new project the fixture workspace's
 * opt-in.
 */
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { loadConfig } from '../src/config/loader.js';
import { initCommand, SCAFFOLD_CONFIG } from '../src/cli/commands/init.js';

const dirs: string[] = [];

function projectWith(config: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'aiui-desktop-config-'));
  dirs.push(dir);
  writeFileSync(path.join(dir, 'aiui.config.json'), JSON.stringify(config, null, 2), 'utf8');
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('DEFAULT_CONFIG.desktop — §5.10', () => {
  it('carries the four documented defaults', () => {
    expect(DEFAULT_CONFIG.desktop).toEqual({
      enabled: false,
      maxImageWidth: 1600,
      settleMs: 300,
      reportScreenshots: true,
    });
  });

  it('is OFF by default — a shared project must opt in (§5.1 item 1)', () => {
    expect(DEFAULT_CONFIG.desktop.enabled).toBe(false);
  });

  it('ships no launchArgs — the launcher\'s own flags are the whole list', () => {
    expect(DEFAULT_CONFIG.browser.launchArgs).toBeUndefined();
  });
});

describe('loadConfig — the new keys', () => {
  it('an unconfigured project gets the defaults', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiui-desktop-none-'));
    dirs.push(dir);
    const config = await loadConfig(undefined, dir);
    expect(config.desktop).toEqual(DEFAULT_CONFIG.desktop);
  });

  it('reads an enabled desktop section', async () => {
    const config = await loadConfig(
      undefined,
      projectWith({ desktop: { enabled: true, maxImageWidth: 1280, settleMs: 500 } }),
    );
    expect(config.desktop).toEqual({
      enabled: true,
      maxImageWidth: 1280,
      settleMs: 500,
      // Not named in the file, so it keeps its default — the deep merge is
      // per key, not per section.
      reportScreenshots: true,
    });
  });

  it('keeps every other default when only one key is set', async () => {
    const config = await loadConfig(undefined, projectWith({ desktop: { reportScreenshots: false } }));
    expect(config.desktop).toEqual({
      enabled: false,
      maxImageWidth: 1600,
      settleMs: 300,
      reportScreenshots: false,
    });
  });

  it('reads browser.launchArgs, replacing rather than merging the array', async () => {
    const config = await loadConfig(
      undefined,
      projectWith({ browser: { launchArgs: ['--disable-print-preview'] } }),
    );
    expect(config.browser.launchArgs).toEqual(['--disable-print-preview']);
    // The sibling browser defaults survive.
    expect(config.browser.headed).toBe(true);
  });
});

describe('loadConfig — the desktop section is typed at load (§5.1 item 1)', () => {
  it('the string "false" does NOT enable computer mode: the load refuses, naming the file and the value', async () => {
    const dir = projectWith({ desktop: { enabled: 'false' } });
    const file = path.join(dir, 'aiui.config.json');
    // Before this check the gate read `enabled` as truthy, and "false" is.
    await expect(loadConfig(undefined, dir)).rejects.toThrow(
      `Invalid desktop.enabled in ${file}: expected true or false, got the string "false"`,
    );
  });

  it.each([
    ['the string "true"', 'true', 'the string "true"'],
    ['a number', 1, 'the number 1'],
    ['null', null, 'null'],
  ])('refuses enabled as %s rather than guessing', async (_label, value, described) => {
    const dir = projectWith({ desktop: { enabled: value } });
    await expect(loadConfig(undefined, dir)).rejects.toThrow(
      new RegExp(`desktop\\.enabled .*got ${described.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  });

  it('true enables it and false does not', async () => {
    expect((await loadConfig(undefined, projectWith({ desktop: { enabled: true } }))).desktop.enabled)
      .toBe(true);
    expect((await loadConfig(undefined, projectWith({ desktop: { enabled: false } }))).desktop.enabled)
      .toBe(false);
  });

  it('refuses a string reportScreenshots — "false" would otherwise keep captures in the report', async () => {
    const dir = projectWith({ desktop: { reportScreenshots: 'false' } });
    await expect(loadConfig(undefined, dir)).rejects.toThrow(
      'Invalid desktop.reportScreenshots',
    );
  });

  it('refuses a non-number maxImageWidth / settleMs, and a desktop that is not an object', async () => {
    await expect(loadConfig(undefined, projectWith({ desktop: { maxImageWidth: '1600' } })))
      .rejects.toThrow('Invalid desktop.maxImageWidth');
    await expect(loadConfig(undefined, projectWith({ desktop: { settleMs: '300' } })))
      .rejects.toThrow('Invalid desktop.settleMs');
    await expect(loadConfig(undefined, projectWith({ desktop: true })))
      .rejects.toThrow('Invalid "desktop"');
  });
});

describe('aiui init — a new project does not inherit the fixture workspace\'s config', () => {
  const templateConfigPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../templates/init/aiui.config.json',
  );

  async function initInto(): Promise<string> {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiui-init-'));
    dirs.push(dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await initCommand(dir, false);
    } finally {
      log.mockRestore();
    }
    return dir;
  }

  it('writes a config with computer mode off, no fixture launch args and no fixture toolsDir', async () => {
    const dir = await initInto();
    const written = JSON.parse(readFileSync(path.join(dir, 'aiui.config.json'), 'utf8'));
    expect(written.desktop?.enabled).not.toBe(true);
    expect(written.browser?.launchArgs).toBeUndefined();
    expect(written.tests?.toolsDir).not.toMatch(/fixtures/);

    // And what the project actually RUNS with, through the real loader.
    const config = await loadConfig(undefined, dir);
    expect(config.desktop.enabled).toBe(false);
    expect(config.browser.launchArgs).toBeUndefined();
    expect(config.tests.toolsDir).toBe('./tools/src');
  });

  it('still scaffolds the example tests beside it', async () => {
    const dir = await initInto();
    expect(existsSync(path.join(dir, 'tests', 'example.md'))).toBe(true);
    expect(existsSync(path.join(dir, 'context', 'app.md'))).toBe(true);
  });

  it('the fixture workspace keeps its own opt-in — the live computer-mode test needs it', async () => {
    // The other half of keeping the two files apart: the live suite's
    // `pdf-dialog-cancel.md` runs in templates/init and needs both keys, and the
    // file must still pass the typed load.
    const fixture = JSON.parse(readFileSync(templateConfigPath, 'utf8'));
    expect(fixture.desktop.enabled).toBe(true);
    expect(fixture.browser.launchArgs).toEqual(['--disable-print-preview']);
    const config = await loadConfig(undefined, path.dirname(templateConfigPath));
    expect(config.desktop.enabled).toBe(true);
  });

  it('the scaffold is what init writes, and it is valid JSON with no desktop section at all', () => {
    const scaffold = JSON.parse(SCAFFOLD_CONFIG);
    expect(scaffold.desktop).toBeUndefined();
  });
});

describe('aiui.config.schema.json — desktop and browser.launchArgs', () => {
  // The schema is a committed artifact regenerated by `npm run build:schema`
  // (part of `npm run build`). These assertions fail if it was not re-run,
  // which is the only signal a reader gets that the editor's autocomplete and
  // the code have drifted apart.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let validate: any;

  beforeAll(async () => {
    const schemaText = await readFile(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../schema/aiui.config.schema.json'),
      'utf8',
    );
    const ajv = new Ajv({ strict: false, allErrors: true });
    validate = ajv.compile(JSON.parse(schemaText));
  });

  it('accepts a full desktop section', () => {
    expect(
      validate({
        desktop: { enabled: true, maxImageWidth: 1600, settleMs: 300, reportScreenshots: false },
      }),
    ).toBe(true);
  });

  it('accepts a partial one', () => {
    expect(validate({ desktop: { enabled: true } })).toBe(true);
  });

  it.each([
    ['enabled as a string', { desktop: { enabled: 'yes' } }],
    ['maxImageWidth as a string', { desktop: { maxImageWidth: '1600' } }],
    ['settleMs as a string', { desktop: { settleMs: '300' } }],
    ['reportScreenshots as a number', { desktop: { reportScreenshots: 1 } }],
  ])('rejects %s', (_label, value) => {
    expect(validate(value)).toBe(false);
  });

  it('rejects a key that is not in the section', () => {
    // The generator emits `additionalProperties: false`, so a typo is caught
    // in the editor rather than silently ignored at run time.
    expect(validate({ desktop: { enable: true } })).toBe(false);
  });

  it('accepts browser.launchArgs as an array of strings', () => {
    expect(validate({ browser: { launchArgs: ['--disable-print-preview'] } })).toBe(true);
    expect(validate({ browser: { launchArgs: [] } })).toBe(true);
  });

  it('rejects a launchArgs that is one string rather than a list', () => {
    expect(validate({ browser: { launchArgs: '--disable-print-preview' } })).toBe(false);
    expect(validate({ browser: { launchArgs: [1, 2] } })).toBe(false);
  });

  it('documents each key, so the editor hover says what it does', () => {
    // The JSDoc → `description` path is the whole reason the schema is
    // generated from the types rather than written by hand.
    const raw = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      JSON.stringify(validate.schema),
    );
    const desktop = raw.definitions['DeepPartial<DesktopConfig>'];
    expect(desktop).toBeDefined();
    for (const key of ['enabled', 'maxImageWidth', 'settleMs', 'reportScreenshots']) {
      expect(desktop.properties[key].description, `${key} has no description`).toBeTruthy();
    }
  });
});
