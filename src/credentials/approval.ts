// Asking the user (SPEC 29 §10).
//
// Every fill is gated on a human, and the prompt is raised by THIS process as
// a native window — deliberately not rendered inside the web page, where the
// page's own scripts could draw a convincing copy of it, or click the real one.
//
// The prompt is also the only place a master password is ever typed into
// anything of ours, and §5 keeps an escape hatch from that: if `BW_SESSION` is
// set, the user unlocked in their own terminal, their master password went
// straight to Bitwarden's binary, and this file is never asked for it.

import { spawn } from 'node:child_process';
import type { ApprovalDecision, ApprovalProvider, ApprovalRequest } from './types.js';

/** How long the prompt waits before answering "no" on the user's behalf. */
const APPROVAL_TIMEOUT_MS = 60_000;
/** The unlock prompt gets longer — a master password is long and typed carefully. */
const UNLOCK_TIMEOUT_MS = 120_000;

/**
 * Shared head for both dialogs, and the fix for a trap that cost a live run.
 *
 * The server spawns PowerShell with `windowsHide: true` so no console flashes
 * on every approval. On Windows that sets `SW_HIDE` in the child's STARTUPINFO
 * — and WinForms applies STARTUPINFO's show-command to the FIRST top-level
 * window a process shows. So `ShowDialog()` ran, blocked for its full timeout,
 * and painted nothing: a gate that silently refuses everything because nobody
 * can ever see it.
 *
 * `Reveal` overrides that explicitly with `ShowWindow(SW_SHOW)` once the form
 * exists, then pulls it to the front. `$form.Activate()` alone does not do it —
 * activating a window that was never shown leaves it hidden.
 */
const DIALOG_PREAMBLE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AiuiWin {
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  public static void Reveal(IntPtr h) { ShowWindow(h, 5); SetForegroundWindow(h); }
}
"@
`;

/**
 * The approval dialog, as a Windows Forms window.
 *
 * Values reach it through the ENVIRONMENT, never through the script text. That
 * is not tidiness: `domain` and the item names originate outside this process
 * (a page's URL, a vault the user typed into), and interpolating them into a
 * PowerShell script would be an injection site in the one component whose job
 * is to be the trustworthy gate.
 */
const APPROVAL_SCRIPT = `

$domain = $env:AIUI_APPROVAL_DOMAIN
$framedBy = $env:AIUI_APPROVAL_FRAMEDBY
$items = $env:AIUI_APPROVAL_ITEMS -split "\`n"
$timeout = [int]$env:AIUI_APPROVAL_TIMEOUT

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Approve sign-in'
$form.Size = New-Object System.Drawing.Size(460, 250)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false

$head = New-Object System.Windows.Forms.Label
$head.Text = 'An agent wants to sign in to:'
$head.Location = New-Object System.Drawing.Point(18, 18)
$head.Size = New-Object System.Drawing.Size(410, 20)
$form.Controls.Add($head)

$site = New-Object System.Windows.Forms.Label
$site.Text = $domain
$site.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
$site.Location = New-Object System.Drawing.Point(18, 42)
$site.Size = New-Object System.Drawing.Size(410, 26)
$form.Controls.Add($site)

$y = 72
# IsNullOrEmpty, not a plain inequality. An environment variable set to the
# empty string reads back as $null here, and $null is not equal to '' — so the
# simple comparison drew "Warning: this form is embedded inside " with no host
# on EVERY ordinary sign-in. A warning that cries wolf on every login is worse
# than no warning: it teaches the user to click past the one that matters.
if (-not [string]::IsNullOrEmpty($framedBy)) {
  $warn = New-Object System.Windows.Forms.Label
  $warn.Text = 'Warning: this form is embedded inside ' + $framedBy
  $warn.ForeColor = [System.Drawing.Color]::FromArgb(163, 45, 45)
  $warn.Location = New-Object System.Drawing.Point(18, $y)
  $warn.Size = New-Object System.Drawing.Size(410, 20)
  $form.Controls.Add($warn)
  $y = $y + 24
}

$picker = $null
if ($items.Count -gt 1) {
  $label = New-Object System.Windows.Forms.Label
  $label.Text = 'Which saved login?'
  $label.Location = New-Object System.Drawing.Point(18, $y)
  $label.Size = New-Object System.Drawing.Size(410, 20)
  $form.Controls.Add($label)
  $y = $y + 22
  $picker = New-Object System.Windows.Forms.ComboBox
  $picker.DropDownStyle = 'DropDownList'
  $picker.Location = New-Object System.Drawing.Point(18, $y)
  $picker.Size = New-Object System.Drawing.Size(410, 24)
  foreach ($i in $items) { [void]$picker.Items.Add($i) }
  $picker.SelectedIndex = 0
  $form.Controls.Add($picker)
  $y = $y + 34
} else {
  $only = New-Object System.Windows.Forms.Label
  $only.Text = 'Using saved login: ' + $items[0]
  $only.Location = New-Object System.Drawing.Point(18, $y)
  $only.Size = New-Object System.Drawing.Size(410, 20)
  $form.Controls.Add($only)
  $y = $y + 28
}

$allow = New-Object System.Windows.Forms.Button
$allow.Text = 'Allow'
$allow.Location = New-Object System.Drawing.Point(238, $y)
$allow.Size = New-Object System.Drawing.Size(90, 30)
$allow.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($allow)

$deny = New-Object System.Windows.Forms.Button
$deny.Text = 'Deny'
$deny.Location = New-Object System.Drawing.Point(338, $y)
$deny.Size = New-Object System.Drawing.Size(90, 30)
$deny.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($deny)

# Deny is the default button, so Enter and Escape both refuse. A prompt whose
# default answer is "yes" is not a gate.
$form.AcceptButton = $deny
$form.CancelButton = $deny

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $timeout
$timer.Add_Tick({ $form.DialogResult = [System.Windows.Forms.DialogResult]::Cancel; $form.Close() })
$timer.Start()

$form.Add_Shown({ [AiuiWin]::Reveal($form.Handle) })
$result = $form.ShowDialog()
$timer.Stop()

if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  if ($null -ne $picker) { Write-Output $picker.SelectedIndex } else { Write-Output 0 }
  exit 0
}
exit 1
`;

/** The unlock prompt. Masked, and the value crosses one pipe to this process. */
const UNLOCK_SCRIPT = `
$timeout = [int]$env:AIUI_APPROVAL_TIMEOUT

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Unlock Bitwarden'
$form.Size = New-Object System.Drawing.Size(460, 200)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false

$head = New-Object System.Windows.Forms.Label
$head.Text = 'Your vault is locked. Enter your Bitwarden master password.'
$head.Location = New-Object System.Drawing.Point(18, 18)
$head.Size = New-Object System.Drawing.Size(410, 20)
$form.Controls.Add($head)

$box = New-Object System.Windows.Forms.TextBox
$box.UseSystemPasswordChar = $true
$box.Location = New-Object System.Drawing.Point(18, 48)
$box.Size = New-Object System.Drawing.Size(410, 26)
$form.Controls.Add($box)

$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Unlock'
$ok.Location = New-Object System.Drawing.Point(238, 92)
$ok.Size = New-Object System.Drawing.Size(90, 30)
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($ok)

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Location = New-Object System.Drawing.Point(338, 92)
$cancel.Size = New-Object System.Drawing.Size(90, 30)
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($cancel)

$form.AcceptButton = $ok
$form.CancelButton = $cancel

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $timeout
$timer.Add_Tick({ $form.DialogResult = [System.Windows.Forms.DialogResult]::Cancel; $form.Close() })
$timer.Start()

$form.Add_Shown({ [AiuiWin]::Reveal($form.Handle); $box.Focus() })
$result = $form.ShowDialog()
$timer.Stop()

if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($box.Text)
  exit 0
}
exit 1
`;

/** Base64/UTF-16LE, which is what `-EncodedCommand` wants. Sidesteps every
 *  quoting question about passing a multi-line script through a command line. */
function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

interface DialogResult {
  code: number | null;
  stdout: string;
}

function runDialog(script: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<DialogResult> {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      // `-STA` is required: WinForms will not run on an MTA thread, and
      // PowerShell 5.1 defaults to STA only for the interactive host.
      ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encodeCommand(DIALOG_PREAMBLE + script)],
      { shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let settled = false;
    // A hard backstop above the dialog's own timer: if PowerShell itself fails
    // to start a window, the request must still end in a refusal rather than
    // holding the login open forever.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ code: 1, stdout: '' });
    }, timeoutMs + 15_000);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout: '' });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}

/** Approval by native dialog. Windows only; see `DenyingApproval` elsewhere. */
export class WindowsDialogApproval implements ApprovalProvider {
  async ask(request: ApprovalRequest): Promise<ApprovalDecision> {
    const items = request.items.length > 0 ? request.items : ['(unnamed item)'];
    const result = await runDialog(
      APPROVAL_SCRIPT,
      {
        ...process.env,
        AIUI_APPROVAL_DOMAIN: request.domain,
        AIUI_APPROVAL_FRAMEDBY: request.framedBy ?? '',
        // Newline-joined because an item name can contain almost anything else.
        AIUI_APPROVAL_ITEMS: items.join('\n'),
        AIUI_APPROVAL_TIMEOUT: String(APPROVAL_TIMEOUT_MS),
      },
      APPROVAL_TIMEOUT_MS,
    );
    // `code === null` means PowerShell never ran at all — the prompt could not
    // be shown, which is different from being refused, and the broker says so.
    if (result.code === null) {
      return { allowed: false, chosen: 0, unavailable: 'The approval prompt could not be shown on this machine.' };
    }
    if (result.code !== 0) return { allowed: false, chosen: 0 };
    const chosen = Number.parseInt(result.stdout.trim(), 10);
    return {
      allowed: true,
      chosen: Number.isInteger(chosen) && chosen >= 0 && chosen < items.length ? chosen : 0,
    };
  }

  /**
   * Ask for the master password.
   *
   * Returns it to the caller, which is expected to hand it straight to
   * `BitwardenVault.unlock` and keep no copy. This is the one value in the
   * system that briefly crosses a pipe, and §5's `BW_SESSION` path exists so
   * that anyone who would rather it did not can avoid this entirely.
   */
  async askMasterPassword(): Promise<string | null> {
    const result = await runDialog(
      UNLOCK_SCRIPT,
      { ...process.env, AIUI_APPROVAL_TIMEOUT: String(UNLOCK_TIMEOUT_MS) },
      UNLOCK_TIMEOUT_MS,
    );
    if (result.code !== 0) return null;
    return result.stdout === '' ? null : result.stdout;
  }
}

/**
 * The fallback where no prompt can be raised.
 *
 * Refuses everything, and says why. The alternative — filling without asking
 * when the dialog is unavailable — would mean the gate silently disappears on
 * exactly the machines where nobody is watching.
 */
export class DenyingApproval implements ApprovalProvider {
  constructor(private readonly why: string) {}
  ask(): Promise<ApprovalDecision> {
    return Promise.resolve({ allowed: false, chosen: 0, unavailable: this.why });
  }
}

/** The right provider for this platform. */
export function defaultApproval(): ApprovalProvider {
  if (process.platform === 'win32') return new WindowsDialogApproval();
  return new DenyingApproval(
    `Approval prompts are only implemented for Windows in this prototype (this machine is ${process.platform}).`,
  );
}
