<#
.SYNOPSIS
  Moves one machine's state from the old names (ai-ui-automation / aiui /
  TestBench) to Steptix. Run once, after pulling the rename, with every
  server stopped (`node dist/index.js stop` from the old build, or close the
  VS Code windows that auto-started one).

.DESCRIPTION
  The repo rename changes what the code looks for; this script changes what is
  already on disk so the code finds it:

    1. %LOCALAPPDATA%\aiui            -> %LOCALAPPDATA%\steptix (machine .env,
                                         stats, logs), its .aiui\ -> .steptix\,
                                         AIUI_* keys in its .env -> STEPTIX_*
    2. User environment variables       AIUI_*  -> STEPTIX_*
    3. VS Code user settings            "testbench-native.*" / "testbench.*"
                                         -> "steptix.*" (backup kept beside it)
    4. Each -Path (a checkout or test project, default the main checkout):
         testbench-native\ leftovers    (ignored files git did not move) ->
                                         steptix-vscode\, old junctions
                                         unlinked, npm install re-links
         .env* files                   AIUI_* / TESTBENCH_* keys -> STEPTIX_*
         aiui.config.json               -> steptix.config.json
         .aiui\, .testbench\            -> .steptix\ (merged)
         .aiui-profile (CDP profiles)   -> .steptix-profile
         .aiui-codebehind-cache\, .aiui-tool-cache\   -> .steptix-*
    5. -UninstallOldExtension           uninstalls pkent.testbench-native

  Every step is skipped when there is nothing to do, so a second run is a
  no-op. -WhatIf shows the plan without touching anything.

.EXAMPLE
  .\scripts\migrate-to-steptix.ps1 -WhatIf
  .\scripts\migrate-to-steptix.ps1 -UninstallOldExtension
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string[]] $Path = @('C:\Projects\vibe\ai-ui-automation'),
  [switch] $UninstallOldExtension,
  # Only step 4, on -Path: for migrating another test project later.
  [switch] $ProjectsOnly
)
$ErrorActionPreference = 'Stop'

function Rename-EnvKeys([string] $file) {
  $text = [IO.File]::ReadAllText($file)
  $new = [regex]::Replace($text, '(?m)^(\s*(?:export\s+)?)(?:AIUI|TESTBENCH)_', '${1}STEPTIX_')
  if ($new -ne $text -and $PSCmdlet.ShouldProcess($file, 'rename AIUI_/TESTBENCH_ keys to STEPTIX_')) {
    [IO.File]::WriteAllText($file, $new)
    Write-Host "  keys renamed: $file"
  }
}

function Move-IfPresent([string] $from, [string] $to) {
  if (-not (Test-Path -LiteralPath $from)) { return }
  if (Test-Path -LiteralPath $to) { Write-Warning "both exist, leaving them alone: $from and $to"; return }
  if ($PSCmdlet.ShouldProcess($from, "move to $to")) {
    Move-Item -LiteralPath $from -Destination $to
    Write-Host "  moved: $from -> $to"
  }
}

# Moves $from into $to, descending into folders both sides have. Used where
# two old folders became one new one: .aiui\ and the extension's .testbench\
# both became .steptix\ (their file names do not overlap), and a checkout's
# leftover testbench-native\ merges into steptix-vscode\.
function Merge-Into([string] $from, [string] $to) {
  if (-not (Test-Path -LiteralPath $from)) { return }
  if (-not (Test-Path -LiteralPath $to)) { Move-IfPresent $from $to; return }
  foreach ($child in Get-ChildItem -LiteralPath $from -Force) {
    $dest = Join-Path $to $child.Name
    if ($child.PSIsContainer -and -not $child.LinkType -and (Test-Path -LiteralPath $dest -PathType Container)) {
      Merge-Into $child.FullName $dest
    } else {
      Move-IfPresent $child.FullName $dest
    }
  }
  if (-not (Get-ChildItem -LiteralPath $from -Force) -and $PSCmdlet.ShouldProcess($from, 'remove empty folder')) {
    Remove-Item -LiteralPath $from
  }
}

# Every CDP profile the framework made carries this marker, and `reset`
# refuses to delete a profile without it, so it is renamed, not dropped.
function Rename-ProfileMarker([string] $file) {
  Move-IfPresent $file (Join-Path (Split-Path $file -Parent) '.steptix-profile')
}

if (-not $ProjectsOnly) {
  # 1. Machine-wide user root.
  Write-Host '1. Machine user root'
  $oldRoot = Join-Path $env:LOCALAPPDATA 'aiui'
  $newRoot = Join-Path $env:LOCALAPPDATA 'steptix'
  try { Move-IfPresent $oldRoot $newRoot }
  catch { throw "Could not move $oldRoot (a running server holds its log open?). Stop every server and re-run. $_" }
  $rootForFixups = if (Test-Path -LiteralPath $newRoot) { $newRoot } else { $oldRoot }
  foreach ($dot in '.aiui', '.steptix') {
    Get-ChildItem -Path (Join-Path $rootForFixups "$dot\cdp-profiles\*\.aiui-profile") -Force -ErrorAction SilentlyContinue |
      ForEach-Object { Rename-ProfileMarker $_.FullName }
  }
  Merge-Into (Join-Path $rootForFixups '.aiui') (Join-Path $rootForFixups '.steptix')
  $machineEnv = Join-Path $rootForFixups '.env'
  if (Test-Path -LiteralPath $machineEnv) { Rename-EnvKeys $machineEnv }

  # 2. User environment variables.
  Write-Host '2. User environment variables'
  $userVars = [Environment]::GetEnvironmentVariables('User')
  foreach ($name in @($userVars.Keys)) {
    if ($name -notmatch '^(AIUI|TESTBENCH)_') { continue }
    $target = $name -replace '^(AIUI|TESTBENCH)_', 'STEPTIX_'
    if ($PSCmdlet.ShouldProcess("user env $name", "rename to $target")) {
      [Environment]::SetEnvironmentVariable($target, $userVars[$name], 'User')
      [Environment]::SetEnvironmentVariable($name, $null, 'User')
      Write-Host "  $name -> $target (new terminals pick it up)"
    }
  }

  # 3. VS Code user settings.
  Write-Host '3. VS Code user settings'
  $settings = Join-Path $env:APPDATA 'Code\User\settings.json'
  if (Test-Path -LiteralPath $settings) {
    $text = [IO.File]::ReadAllText($settings)
    $new = [regex]::Replace($text, '"testbench(?:-native)?\.', '"steptix.')
    if ($new -ne $text -and $PSCmdlet.ShouldProcess($settings, 'rename testbench settings to steptix.*')) {
      Copy-Item -LiteralPath $settings -Destination "$settings.pre-steptix.bak"
      [IO.File]::WriteAllText($settings, $new)
      Write-Host "  settings renamed (backup: $settings.pre-steptix.bak)"
    }
  }
}

# 4. Checkouts and test projects.
foreach ($p in $Path) {
  Write-Host "4. $p"
  if (-not (Test-Path -LiteralPath $p)) { Write-Warning "not found: $p"; continue }

  # A checkout that pulled the rename: git moved the tracked files into
  # steptix-vscode\ and left the ignored ones (node_modules, dist,
  # .vscode-test, fixture .env files, .vsix) in testbench-native\. Two
  # junctions carry the old package names; unlink them without recursing —
  # the fixtures one points at the repo root.
  $oldExt = Join-Path $p 'testbench-native'
  $newExt = Join-Path $p 'steptix-vscode'
  if ((Test-Path -LiteralPath $oldExt) -and (Test-Path -LiteralPath $newExt)) {
    foreach ($link in (Join-Path $oldExt 'node_modules\ai-ui-automation-runner-core'),
                      (Join-Path $p 'fixtures\tools\node_modules\ai-ui-automation')) {
      $item = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
      if ($item -and $item.LinkType -and $PSCmdlet.ShouldProcess($link, 'unlink old-name junction')) {
        [IO.Directory]::Delete($link, $false)
        Write-Host "  unlinked: $link"
      }
    }
    Merge-Into $oldExt $newExt
    if ($PSCmdlet.ShouldProcess($p, 'npm install in steptix-vscode and fixtures\tools (re-creates the junctions)')) {
      foreach ($dir in $newExt, (Join-Path $p 'fixtures\tools')) {
        Push-Location $dir
        try { npm install --no-audit --no-fund | Out-Null; Write-Host "  npm install: $dir" } finally { Pop-Location }
      }
    }
  }
  # Worktrees under .claude\worktrees are other branches, still on the old
  # names until they merge main; migrating them would break them.
  $skip = '\\(node_modules|\.git|\.vscode-test|\.live-shards|\.claude\\worktrees)(\\|$)'
  $items = Get-ChildItem -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch $skip }
  foreach ($f in $items | Where-Object { -not $_.PSIsContainer -and $_.Name -like '.env*' }) {
    Rename-EnvKeys $f.FullName
  }
  foreach ($f in $items | Where-Object { -not $_.PSIsContainer -and $_.Name -eq 'aiui.config.json' }) {
    Move-IfPresent $f.FullName (Join-Path $f.DirectoryName 'steptix.config.json')
  }
  foreach ($f in $items | Where-Object { -not $_.PSIsContainer -and $_.Name -eq '.aiui-profile' }) {
    Rename-ProfileMarker $f.FullName
  }
  # Deepest first, so a parent's move cannot strand a child's path.
  $dirs = $items | Where-Object { $_.PSIsContainer } | Sort-Object { $_.FullName.Length } -Descending
  foreach ($d in $dirs) {
    # Renamed rather than deleted: the code-behind cache also holds unfinished
    # Record Steps recordings and last-run files.
    if ($d.Name -in '.aiui-codebehind-cache', '.aiui-tool-cache') {
      Merge-Into $d.FullName (Join-Path $d.Parent.FullName ($d.Name -replace '^\.aiui-', '.steptix-'))
    } elseif ($d.Name -in '.aiui', '.testbench') {
      Merge-Into $d.FullName (Join-Path $d.Parent.FullName '.steptix')
    }
  }
}

# 5. The old extension.
if ($UninstallOldExtension -and -not $ProjectsOnly) {
  Write-Host '5. Old extension'
  $code = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'
  if ($PSCmdlet.ShouldProcess('pkent.testbench-native', 'uninstall')) {
    & $code --uninstall-extension pkent.testbench-native
  }
}

if (-not $ProjectsOnly) { Write-Host @'

Still yours to do:
  - Install the new extension: cd steptix-vscode; npm run build; npm run package;
    code.cmd --install-extension steptix-vscode-<version>.vsix --force
  - Claude Code will ask to approve the project MCP server again: .mcp.json now
    names it "steptix" instead of "aiui".
  - Restart open terminals and VS Code so they see the renamed variables.
'@ }
