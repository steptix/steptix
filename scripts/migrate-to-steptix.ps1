<#
.SYNOPSIS
  Moves one machine's state from the old names (ai-ui-automation / aiui /
  TestBench) to Steptix. Run once, after pulling the rename, with every
  server stopped and every Chrome/Edge the framework launched over CDP closed.

.DESCRIPTION
  The repo rename changes what the code looks for; this script changes what is
  already on disk so the code finds it:

    1. %LOCALAPPDATA%\aiui            -> merged into %LOCALAPPDATA%\steptix
                                         (machine .env, stats, logs; a month's
                                         stats file on both sides is joined),
                                         its .aiui\ -> .steptix\, its
                                         aiui.config.json -> steptix.config.json,
                                         AIUI_*/TESTBENCH_* .env keys -> STEPTIX_*
    2. User environment variables       AIUI_* / TESTBENCH_* -> STEPTIX_*
    3. VS Code user settings            "testbench-native.*" / "testbench.*"
                                         keys -> "steptix.*", and keybindings'
                                         command ids (backups beside them)
    4. Each -Path (a checkout or test project, default the main checkout):
         testbench-native\ leftovers    (ignored files git did not move) ->
                                         steptix-vscode\; node_modules, dist and
                                         .vscode-test are dropped instead when
                                         steptix-vscode\ already has its own
         old-name junctions             unlinked; npm install re-creates them
         .env* files                    AIUI_* / TESTBENCH_* keys -> STEPTIX_*
         aiui.config.json               -> steptix.config.json
         .aiui\, .testbench\            -> .steptix\ (merged)
         .aiui-profile (CDP profiles)   -> .steptix-profile
         .aiui-codebehind-cache\, .aiui-tool-cache\   -> .steptix-*
         .vscode\settings.json          workspace keys -> steptix.* (the
                                         selected environment lives there)
         code (.ts/.js/...)             imports of 'ai-ui-automation/...' ->
                                         'steptix/...'; any other old name
                                         in code is listed for a hand check
    5. -UninstallOldExtension           uninstalls pkent.testbench-native

  Nothing is overwritten: where the new name already exists (a file, a key, a
  variable, a setting) the old one is left in place with a warning. A run
  that stops partway (a locked file, a failed npm install) can be re-run and
  picks up where it stopped; a run with nothing left to do changes nothing.
  -WhatIf shows the plan without touching anything.

  A checkout that has not pulled the rename yet is refused: renaming its
  tracked aiui.config.json would make the pull fail.

.EXAMPLE
  .\scripts\migrate-to-steptix.ps1 -WhatIf
  .\scripts\migrate-to-steptix.ps1 -UninstallOldExtension
  .\scripts\migrate-to-steptix.ps1 -ProjectsOnly -Path D:\my-tests
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string[]] $Path = @('C:\Projects\vibe\ai-ui-automation'),
  [switch] $UninstallOldExtension,
  # Only step 4, on -Path: for migrating another test project later.
  [switch] $ProjectsOnly
)
$ErrorActionPreference = 'Stop'

function Test-Link([string] $p) {
  $item = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
  return [bool]($item -and $item.LinkType)
}

# Renames AIUI_X= / TESTBENCH_X= lines to STEPTIX_X=, except where the file
# already defines STEPTIX_X — that line stays, so the file never ends up with
# two definitions of one key.
function Rename-EnvKeys([string] $file) {
  $lines = [IO.File]::ReadAllLines($file)
  $keyRe = '^(\s*(?:export\s+)?)(AIUI|TESTBENCH)_(\w+)(\s*=)'
  $defined = @{}
  foreach ($l in $lines) { if ($l -match '^\s*(?:export\s+)?(STEPTIX_\w+)\s*=') { $defined[$Matches[1]] = $true } }
  $changed = $false
  $out = foreach ($l in $lines) {
    if ($l -match $keyRe) {
      $target = "STEPTIX_$($Matches[3])"
      if ($defined.ContainsKey($target)) {
        Write-Warning "$file already defines $target; left $($Matches[2])_$($Matches[3]) as it is"
        $l
      } else {
        $defined[$target] = $true
        $changed = $true
        $l -replace $keyRe, ('${1}' + $target + '${4}')
      }
    } else { $l }
  }
  if ($changed -and $PSCmdlet.ShouldProcess($file, 'rename AIUI_/TESTBENCH_ keys to STEPTIX_')) {
    [IO.File]::WriteAllLines($file, [string[]]$out)
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
# two old folders became one new one (.aiui\ and .testbench\ -> .steptix\), for
# the user root when the new one already exists, and for a checkout's leftover
# testbench-native\. Never enumerates through a link on either side: merging a
# junction would move files out of whatever it points at.
function Merge-Into([string] $from, [string] $to, [string[]] $skipNames = @()) {
  if (-not (Test-Path -LiteralPath $from)) { return }
  if ((Test-Link $from) -or (Test-Link $to)) {
    Write-Warning "a link is involved, leaving it alone: $from -> $to"
    return
  }
  if (-not (Test-Path -LiteralPath $to)) { Move-IfPresent $from $to; return }
  foreach ($child in Get-ChildItem -LiteralPath $from -Force | Where-Object { $_.Name -notin $skipNames }) {
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

# Deletes a folder that a build or install re-creates (node_modules, dist,
# .vscode-test). Links inside it are unlinked first, without recursing, so the
# delete cannot reach whatever they point at.
function Remove-Rebuildable([string] $dir) {
  if (-not (Test-Path -LiteralPath $dir)) { return }
  if (-not $PSCmdlet.ShouldProcess($dir, 'delete (steptix-vscode already has its own)')) { return }
  Get-ChildItem -LiteralPath $dir -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue |
    Sort-Object { $_.FullName.Length } -Descending |
    ForEach-Object {
      if ($_.PSIsContainer) { [IO.Directory]::Delete($_.FullName, $false) } else { [IO.File]::Delete($_.FullName) }
    }
  Remove-Item -LiteralPath $dir -Recurse -Force
  Write-Host "  deleted: $dir"
}

# A month's scoreboard file can exist on both sides: the renamed code starts
# writing %LOCALAPPDATA%\steptix\stats\actions-YYYY-MM.jsonl the first time it
# runs. The reader only knows that exact name, so the old lines are put in
# front of the new ones rather than kept under another name.
function Join-StatsFiles([string] $oldStats, [string] $newStats) {
  if (-not (Test-Path -LiteralPath $oldStats) -or -not (Test-Path -LiteralPath $newStats)) { return }
  foreach ($f in Get-ChildItem -LiteralPath $oldStats -Filter 'actions-*.jsonl' -File) {
    $dest = Join-Path $newStats $f.Name
    if (-not (Test-Path -LiteralPath $dest)) { continue }
    if ($PSCmdlet.ShouldProcess($dest, "put the lines of $($f.FullName) in front")) {
      $old = [IO.File]::ReadAllText($f.FullName)
      if ($old.Length -gt 0 -and -not $old.EndsWith("`n")) { $old += "`n" }
      [IO.File]::WriteAllText($dest, $old + [IO.File]::ReadAllText($dest))
      Remove-Item -LiteralPath $f.FullName
      Write-Host "  stats joined: $($f.Name)"
    }
  }
}

# Renames "testbench-native.X" / "testbench.X" setting keys to "steptix.X" in a
# VS Code settings file (user or workspace). Only keys ("name": ...), and never
# one whose steptix.X is already set or was produced a moment ago from the
# other old prefix — either would leave two copies of one key.
function Rename-SettingsKeys([string] $file) {
  if (-not (Test-Path -LiteralPath $file)) { return }
  $text = [IO.File]::ReadAllText($file)
  $taken = @{}
  foreach ($m in [regex]::Matches($text, '"(steptix\.[^"]+)"(?=\s*:)')) { $taken[$m.Groups[1].Value] = $true }
  $new = [regex]::Replace($text, '"testbench(?:-native)?\.([^"]+)"(?=\s*:)', {
    param($m)
    $target = 'steptix.' + $m.Groups[1].Value
    if ($taken.ContainsKey($target)) {
      Write-Warning "$file already has `"$target`"; left $($m.Value) as it is"
      return $m.Value
    }
    $taken[$target] = $true
    return "`"$target`""
  })
  if ($new -ne $text -and $PSCmdlet.ShouldProcess($file, 'rename testbench settings to steptix.*')) {
    Copy-Item -LiteralPath $file -Destination "$file.pre-steptix.bak"
    [IO.File]::WriteAllText($file, $new)
    Write-Host "  settings renamed: $file (backup beside it)"
  }
}

# Tool files and code-behind (.steps.ts) import the framework by package name;
# the old name no longer resolves, and a code-behind that fails to load falls
# back to AI without failing the run. Only import specifiers are rewritten.
$CodeFile = '\.(ts|mts|cts|js|mjs|cjs)$'
# The checkout folder keeps its old name for now, so a path to it is not a leftover.
$OldNamePattern = '(?<!vibe[\\/]+)ai-ui-automation|aiui|testbench'
function Rename-Imports([string] $file) {
  $text = [IO.File]::ReadAllText($file)
  $new = [regex]::Replace($text, '(?<q>[''"`])ai-ui-automation(?=[/''"`])', '${q}steptix')
  if ($new -ne $text -and $PSCmdlet.ShouldProcess($file, "import from 'steptix' instead of 'ai-ui-automation'")) {
    [IO.File]::WriteAllText($file, $new)
    Write-Host "  imports renamed: $file"
  }
}

# Every CDP profile the framework made carries this marker, and `reset`
# refuses to delete a profile without it, so it is renamed, not dropped.
function Rename-ProfileMarker([string] $file) {
  Move-IfPresent $file (Join-Path (Split-Path $file -Parent) '.steptix-profile')
}

# Everything under $root except what must not be touched, without descending
# into links. Worktrees under .claude\worktrees are other branches, still on
# the old names until they merge main. Skips are judged below $root, so a
# -Path that is itself inside a worktree still works.
function Get-ProjectTree([string] $root) {
  $skipNames = @('node_modules', '.git', '.vscode-test', '.live-shards')
  $stack = [System.Collections.Generic.Stack[string]]::new()
  $stack.Push($root)
  while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    foreach ($item in Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue) {
      $item
      if (-not $item.PSIsContainer -or $item.LinkType) { continue }
      if ($item.Name -in $skipNames) { continue }
      if ($item.Name -eq 'worktrees' -and (Split-Path $dir -Leaf) -eq '.claude') { continue }
      $stack.Push($item.FullName)
    }
  }
}

if (-not $ProjectsOnly) {
  # 1. Machine-wide user root.
  Write-Host '1. Machine user root'
  $oldRoot = Join-Path $env:LOCALAPPDATA 'aiui'
  $newRoot = Join-Path $env:LOCALAPPDATA 'steptix'
  try {
    if (Test-Path -LiteralPath $newRoot) {
      Join-StatsFiles (Join-Path $oldRoot 'stats') (Join-Path $newRoot 'stats')
      Merge-Into $oldRoot $newRoot
    } else {
      Move-IfPresent $oldRoot $newRoot
    }
  } catch {
    throw ("Could not finish moving $oldRoot to $newRoot — a file is locked, most likely by a " +
      "Chrome or Edge the framework launched with one of its profiles. Close it and re-run; " +
      "the move picks up where it stopped. $_")
  }
  # Under -WhatIf nothing moved, so show the fixups against the old root.
  $rootForFixups = if (Test-Path -LiteralPath $newRoot) { $newRoot } else { $oldRoot }
  foreach ($dot in '.aiui', '.steptix') {
    Get-ChildItem -Path (Join-Path $rootForFixups "$dot\cdp-profiles\*\.aiui-profile") -Force -ErrorAction SilentlyContinue |
      ForEach-Object { Rename-ProfileMarker $_.FullName }
  }
  Merge-Into (Join-Path $rootForFixups '.aiui') (Join-Path $rootForFixups '.steptix')
  Move-IfPresent (Join-Path $rootForFixups 'aiui.config.json') (Join-Path $rootForFixups 'steptix.config.json')
  $machineEnv = Join-Path $rootForFixups '.env'
  if (Test-Path -LiteralPath $machineEnv) { Rename-EnvKeys $machineEnv }

  # 2. User environment variables. An expandable (REG_EXPAND_SZ) value is left
  # for a hand move: the .NET API would store it expanded, freezing any %VAR%.
  Write-Host '2. User environment variables'
  $envKey = Get-Item -LiteralPath 'HKCU:\Environment'
  foreach ($name in @($envKey.GetValueNames())) {
    if ($name -notmatch '^(AIUI|TESTBENCH)_') { continue }
    $target = $name -replace '^(AIUI|TESTBENCH)_', 'STEPTIX_'
    if ($null -ne $envKey.GetValue($target)) {
      Write-Warning "user variable $target already exists; left $name as it is"
      continue
    }
    if ($envKey.GetValueKind($name) -ne [Microsoft.Win32.RegistryValueKind]::String) {
      Write-Warning "user variable $name is not a plain string (expandable?); rename it by hand to $target"
      continue
    }
    if ($PSCmdlet.ShouldProcess("user variable $name", "rename to $target")) {
      [Environment]::SetEnvironmentVariable($target, $envKey.GetValue($name), 'User')
      [Environment]::SetEnvironmentVariable($name, $null, 'User')
      Write-Host "  $name -> $target (new terminals pick it up)"
    }
  }

  # 3. VS Code user settings and keybindings.
  Write-Host '3. VS Code user settings'
  $userDir = Join-Path $env:APPDATA 'Code\User'
  Rename-SettingsKeys (Join-Path $userDir 'settings.json')
  $keys = Join-Path $userDir 'keybindings.json'
  if (Test-Path -LiteralPath $keys) {
    $text = [IO.File]::ReadAllText($keys)
    # Command ids are values here ("command": "testbench-native.runAll"; a
    # leading - removes a default binding).
    $new = [regex]::Replace($text, '("command"\s*:\s*"-?)testbench(?:-native)?\.', '${1}steptix.')
    if ($new -ne $text -and $PSCmdlet.ShouldProcess($keys, 'point keybindings at steptix.* commands')) {
      Copy-Item -LiteralPath $keys -Destination "$keys.pre-steptix.bak"
      [IO.File]::WriteAllText($keys, $new)
      Write-Host "  keybindings renamed (backup: $keys.pre-steptix.bak)"
    }
  }
}

# 4. Checkouts and test projects.
foreach ($given in $Path) {
  Write-Host "4. $given"
  if (-not (Test-Path -LiteralPath $given)) { Write-Warning "not found: $given"; continue }
  # .NET calls below resolve relative paths against the process directory,
  # not the PowerShell location, so work with the full path from here on.
  $p = (Resolve-Path -LiteralPath $given).ProviderPath

  $oldExt = Join-Path $p 'testbench-native'
  $newExt = Join-Path $p 'steptix-vscode'
  if (Test-Path -LiteralPath (Join-Path $oldExt 'package.json')) {
    Write-Warning "$p has not pulled the rename yet (testbench-native\package.json is still tracked there). Pull first, then re-run."
    continue
  }

  # A checkout that pulled the rename: git moved the tracked files into
  # steptix-vscode\ and left the ignored ones in testbench-native\. Two
  # junctions carry the old package names; unlink them without recursing —
  # the fixtures one points at the repo root.
  foreach ($link in (Join-Path $oldExt 'node_modules\ai-ui-automation-runner-core'),
                    (Join-Path $p 'fixtures\tools\node_modules\ai-ui-automation')) {
    if ((Test-Link $link) -and $PSCmdlet.ShouldProcess($link, 'unlink old-name junction')) {
      [IO.Directory]::Delete($link, $false)
      Write-Host "  unlinked: $link"
    }
  }
  if ((Test-Path -LiteralPath $oldExt) -and (Test-Path -LiteralPath $newExt)) {
    # Two package trees must not be mixed file by file: keep the new side's.
    # Excluded from the merge too, so -WhatIf (which deletes nothing) shows
    # the same plan as a real run.
    $replaced = @('node_modules', 'dist', '.vscode-test') |
      Where-Object { Test-Path -LiteralPath (Join-Path $newExt $_) }
    foreach ($name in $replaced) { Remove-Rebuildable (Join-Path $oldExt $name) }
    Merge-Into $oldExt $newExt $replaced
  }

  # Re-link from what is on disk, not from whether the merge ran, so a failed
  # install is retried by the next run.
  $installs = @(
    @{ Dir = $newExt; Link = 'node_modules\steptix-runner-core' },
    @{ Dir = (Join-Path $p 'fixtures\tools'); Link = 'node_modules\steptix' }
  ) | Where-Object {
    (Test-Path -LiteralPath (Join-Path $_.Dir 'package.json')) -and
    -not (Test-Path -LiteralPath (Join-Path $_.Dir $_.Link))
  }
  foreach ($i in $installs) {
    if ($PSCmdlet.ShouldProcess($i.Dir, 'npm install (re-creates the renamed junction)')) {
      Push-Location -LiteralPath $i.Dir
      try {
        npm install --no-audit --no-fund | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "npm install failed in $($i.Dir) (exit $LASTEXITCODE). Fix it and re-run." }
        Write-Host "  npm install: $($i.Dir)"
      } finally { Pop-Location }
    }
  }

  $items = @(Get-ProjectTree $p)
  foreach ($f in $items | Where-Object { -not $_.PSIsContainer -and $_.Name -like '.env*' }) {
    Rename-EnvKeys $f.FullName
  }
  foreach ($f in $items | Where-Object { -not $_.PSIsContainer -and $_.Name -eq 'aiui.config.json' }) {
    Move-IfPresent $f.FullName (Join-Path $f.DirectoryName 'steptix.config.json')
  }
  foreach ($f in $items | Where-Object { -not $_.PSIsContainer -and $_.Name -eq '.aiui-profile' }) {
    Rename-ProfileMarker $f.FullName
  }
  # A workspace's settings hold its selected environment (steptix.activeEnv).
  foreach ($f in $items | Where-Object { -not $_.PSIsContainer -and $_.Name -eq 'settings.json' -and $_.Directory.Name -eq '.vscode' }) {
    Rename-SettingsKeys $f.FullName
  }
  $code = @($items | Where-Object { -not $_.PSIsContainer -and $_.Name -match $CodeFile })
  foreach ($f in $code) { Rename-Imports $f.FullName }
  # Anything else in code that still names the old product is the author's
  # call (a hard-coded aiui.config.json, say), so it is listed, not rewritten.
  if (-not $WhatIfPreference) {
    $left = $code | Where-Object { Select-String -LiteralPath $_.FullName -Pattern $OldNamePattern -Quiet }
    foreach ($f in $left) {
      $hits = Select-String -LiteralPath $f.FullName -Pattern $OldNamePattern |
        ForEach-Object { "line $($_.LineNumber)" }
      Write-Warning "still names the old product, check by hand: $($f.FullName) ($($hits -join ', '))"
    }
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

Still yours to do, in the checkout:
  - Rebuild what the old names were compiled into:
      npm run build                  (root dist\ — the server auto-start runs it)
      cd steptix-vscode; npm run build; npm run package
  - Install the new extension with the CLI shim, not plain `code`:
      & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd" `
          --install-extension steptix-vscode-<version>.vsix --force
  - Run "Steptix: Use Copilot for AI" once. The bridge token lived in the old
    extension's storage, so any .env that command wrote gets 401s until then.
  - Claude Code will ask to approve the project MCP server again: .mcp.json now
    names it "steptix" instead of "aiui".
  - Restart open terminals and VS Code so they see the renamed variables.
'@ }
