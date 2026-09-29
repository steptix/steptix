// Getting typed values out of a dialog intact (stories/bitwarden-sign-in.md §7,
// tests §10.2 38–40).
//
// The defect this pins was live, not hypothetical: PowerShell 5.1 writes
// redirected stdout in the console code page, and on a default Windows install
// that is not UTF-8 — measured, `pässwörd-é-€-日本` arrived as `p�ssw�rd-�-?-??`
// under code page 437. So the unlock dialog could not pass on a master password
// containing any non-ASCII character. The machine this was found on has the
// system-wide UTF-8 option on, which hides it; test 39 sets code page 437
// explicitly so the test means the same thing on every machine.

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DIALOG_SCRIPTS, decodeDialogFields } from '../src/credentials/approval.js';

const NON_ASCII = 'pässwörd-é-€-日本';

function encodeField(value: string): string {
  return `${Buffer.from(value, 'utf8').toString('base64')}\n`;
}

describe('decodeDialogFields', () => {
  it('38. round-trips non-ASCII, an empty value, and a value containing a newline', () => {
    const stdout = encodeField(NON_ASCII) + encodeField('') + encodeField('two\nlines');
    expect(decodeDialogFields(stdout)).toEqual([NON_ASCII, '', 'two\nlines']);
  });

  it('38. tolerates CRLF line endings', () => {
    expect(decodeDialogFields(encodeField(NON_ASCII).replace('\n', '\r\n'))).toEqual([NON_ASCII]);
  });

  it('voids the whole answer on output that is not what the helper writes', () => {
    expect(decodeDialogFields(NON_ASCII)).toBeNull(); // plain text, the old format
    expect(decodeDialogFields(encodeField('a').trimEnd())).toBeNull(); // missing terminator
    expect(decodeDialogFields('not base64!\n')).toBeNull();
  });
});

describe.runIf(process.platform === 'win32')('Write-SteptixFields under a default code page', () => {
  it('39. emits values that survive code page 437 intact', { timeout: 60_000 }, () => {
    // The helper runs alone: the preamble defines it (and loads WinForms, which
    // shows nothing by itself), then it is called on two values that reach the
    // script through the environment. No dialog, no window.
    const script =
      DIALOG_SCRIPTS.preamble +
      `
[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(437)
Write-SteptixFields @($env:STEPTIX_TEST_V1, $env:STEPTIX_TEST_V2)
`;
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      {
        env: { ...process.env, STEPTIX_TEST_V1: NON_ASCII, STEPTIX_TEST_V2: 'plain' },
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    expect(result.status).toBe(0);
    expect(decodeDialogFields(result.stdout)).toEqual([NON_ASCII, 'plain']);
  });
});

describe('every dialog that returns a typed value goes through the helper', () => {
  it('40. unlock, sign-in and code each call Write-SteptixFields, and write nothing directly', () => {
    for (const [name, script] of Object.entries({
      unlock: DIALOG_SCRIPTS.unlock,
      signIn: DIALOG_SCRIPTS.signIn,
      code: DIALOG_SCRIPTS.code,
    })) {
      expect(script, name).toContain('Write-SteptixFields');
      expect(script, name).not.toContain('[Console]::Out.Write');
      expect(script, name).not.toMatch(/Write-Output/i);
    }
  });

  it('40. the helper itself writes Base64 with [Console]::Out, never the output stream', () => {
    const helper = DIALOG_SCRIPTS.preamble.slice(DIALOG_SCRIPTS.preamble.indexOf('function Write-SteptixFields'));
    expect(helper).toContain('[Console]::Out.Write(');
    expect(helper).toContain('ToBase64String');
    expect(helper).not.toMatch(/Write-Output/i);
  });
});
