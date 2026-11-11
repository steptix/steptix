/**
 * Choosing reporters for `steptix run` (docs/specs/SPEC-reporters.md §4):
 * every form a name can take on the flag and in the config, the flag
 * replacing the config list, and an unknown name refused with the three
 * valid ones named.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import {
  chooseReporters,
  parseReporterNames,
  ReporterNameError,
} from '../src/report/reporters/names.js';
import { registerRunCommand } from '../src/cli/commands/run.js';
import { loadConfig } from '../src/config/loader.js';

describe('parseReporterNames', () => {
  it('reads comma-separated names, in any case, with spaces around commas', () => {
    expect(parseReporterNames(['JUnit , json'], { kind: 'flag' })).toEqual(['junit', 'json']);
  });

  it('adds up repeated values and folds a name given twice', () => {
    expect(parseReporterNames(['junit', 'json', 'JUNIT'], { kind: 'flag' })).toEqual(['junit', 'json']);
  });

  it('takes html alone', () => {
    expect(parseReporterNames(['html'], { kind: 'flag' })).toEqual(['html']);
  });

  it('ignores an empty piece between commas', () => {
    expect(parseReporterNames(['junit,,json,'], { kind: 'flag' })).toEqual(['junit', 'json']);
  });

  it('refuses an unknown name on the flag, naming the three valid ones', () => {
    expect(() => parseReporterNames(['junit,xml'], { kind: 'flag' })).toThrow(ReporterNameError);
    expect(() => parseReporterNames(['junit,xml'], { kind: 'flag' })).toThrow(
      'Unknown reporter "xml" in --reporter. The reporters are html, junit, json.',
    );
  });

  it('refuses an unknown name in the config, naming the file', () => {
    expect(() =>
      parseReporterNames(['Teamcity'], { kind: 'config', file: 'steptix.config.json' }),
    ).toThrow('Unknown reporter "Teamcity" in reports.reporters in steptix.config.json. The reporters are html, junit, json.');
  });
});

describe('chooseReporters', () => {
  it('uses the config list when no flag was given', () => {
    expect(chooseReporters(undefined, ['json'], 'steptix.config.json')).toEqual(['json']);
  });

  it('lets the flag replace the config list rather than add to it', () => {
    expect(chooseReporters(['html'], ['junit'], 'steptix.config.json')).toEqual(['html']);
  });

  it('does not check the config list when the flag replaces it', () => {
    expect(chooseReporters(['junit'], ['nope'], 'steptix.config.json')).toEqual(['junit']);
  });

  it('chooses nothing when neither is given', () => {
    expect(chooseReporters(undefined, [], 'steptix.config.json')).toEqual([]);
    // An empty flag is not "no reporters": it is refused, and the config list
    // does not stand in for it.
    for (const empty of [[''], [' , '], []]) {
      expect(() => chooseReporters(empty, ['junit'], 'steptix.config.json')).toThrow(
        '--reporter was given no name. The reporters are html, junit, json.',
      );
    }
    expect(chooseReporters(undefined, undefined, 'steptix.config.json')).toEqual([]);
  });

  it('refuses an unknown config name, naming the config file it came from', () => {
    expect(() => chooseReporters(undefined, ['junit', 'xunit'], 'ci/steptix.config.json')).toThrow(
      /"xunit" in reports\.reporters in ci\/steptix\.config\.json.*html, junit, json/,
    );
  });

  it('refuses a config value that is not a list of names', () => {
    expect(() => chooseReporters(undefined, 'junit', 'steptix.config.json')).toThrow(ReporterNameError);
    expect(() => chooseReporters(undefined, [1], 'steptix.config.json')).toThrow(/must be a list of names/);
  });
});

describe('steptix run --reporter', () => {
  /** The `--reporter` values commander hands the action for `argv`. */
  async function reporterOption(argv: string[]): Promise<unknown> {
    const cli = new Command();
    registerRunCommand(cli);
    const run = cli.commands.find((c) => c.name() === 'run')!;
    let seen: unknown = 'not called';
    run.action((_target: unknown, opts: { reporter?: string[] }) => {
      seen = opts.reporter;
    });
    cli.exitOverride();
    run.exitOverride();
    await cli.parseAsync(['run', ...argv], { from: 'user' });
    return seen;
  }

  it('has no default, so "not given" differs from "given as html"', async () => {
    expect(await reporterOption([])).toBeUndefined();
    expect(await reporterOption(['--reporter', 'html'])).toEqual(['html']);
  });

  it('collects a repeated flag in order', async () => {
    const values = await reporterOption(['--reporter', 'junit', '--reporter', 'json']);
    expect(values).toEqual(['junit', 'json']);
    expect(parseReporterNames(values as string[], { kind: 'flag' })).toEqual(
      parseReporterNames(['junit,json'], { kind: 'flag' }),
    );
  });

  it('reads --reporter JUnit as --reporter junit', async () => {
    const values = await reporterOption(['--reporter', 'JUnit']);
    expect(parseReporterNames(values as string[], { kind: 'flag' })).toEqual(['junit']);
  });
});

describe('reports.reporters at the config loader', () => {
  let dir: string;
  const savedLocalAppData = process.env['LOCALAPPDATA'];
  const savedXdg = process.env['XDG_CONFIG_HOME'];

  afterEach(async () => {
    if (savedLocalAppData === undefined) delete process.env['LOCALAPPDATA'];
    else process.env['LOCALAPPDATA'] = savedLocalAppData;
    if (savedXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = savedXdg;
    if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('defaults to an empty list', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-reporters-cfg-'));
    process.env['LOCALAPPDATA'] = dir;
    process.env['XDG_CONFIG_HOME'] = dir;
    const config = await loadConfig(undefined, dir);
    expect(config.reports.reporters).toEqual([]);
  });

  it('does not throw over an unknown name, since runs other than steptix run share the loader', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steptix-reporters-cfg-'));
    process.env['LOCALAPPDATA'] = dir;
    process.env['XDG_CONFIG_HOME'] = dir;
    await fs.writeFile(
      path.join(dir, 'steptix.config.json'),
      JSON.stringify({ reports: { reporters: ['junit', 'teamcity'] } }),
    );
    const config = await loadConfig(undefined, dir);
    expect(config.reports.reporters).toEqual(['junit', 'teamcity']);
  });
});
