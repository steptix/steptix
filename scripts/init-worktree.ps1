# Seed a git worktree with the gitignored files/dirs needed to run things.
#
# Usage:
#   .\scripts\init-worktree.ps1 -Destination C:\path\to\worktree -AutoPort
#   .\scripts\init-worktree.ps1 -Destination C:\path\to\worktree -Port 3101
#   .\scripts\init-worktree.ps1 -Destination C:\path\to\worktree -SkipBuilds
#
# A fresh worktree contains only tracked files, so it is missing:
#
#   .env, templates/.env       API keys, SERVER_URL, site credentials
#   node_modules x5            root, flick-vscode, steptix-vscode, runner-core,
#                              fixtures/tools
#   dist/                      the compiled server, and the target of the package
#                              self-import `steptix/tools`
#   steptix-vscode/dist/     the built extension
#
# Everything is COPIED rather than symlinked, so the worktree is fully
# independent — safe when package.json diverges between branches. The trade-off
# is disk: a full seed is ~1.1 GB of node_modules.
#
# THE JUNCTION
# `steptix-vscode/node_modules/steptix-runner-core` is the
# `file:../runner-core` dep, which npm materialises as a junction holding an
# ABSOLUTE path to whichever checkout ran `npm install`. robocopy follows that
# junction and writes a real directory, so a naively-seeded worktree ends up
# holding a frozen copy of the SOURCE checkout's runner-core. `npm run build`
# then reports success while esbuild silently bundles the stale code: esbuild
# resolves the import through node_modules, whereas `build:runner-core` compiles
# `../runner-core` — a different place. This script re-points the junction at
# the worktree's own runner-core after copying.
#
# `fixtures/tools/node_modules/steptix` is the second such junction —
# the `file:../..` dep — but its target is the WHOLE repo root, whose tree
# contains this very node_modules. Letting robocopy follow it would recurse
# the entire source checkout into the copy, so unlike runner-core's it is
# EXCLUDED from the copy (/XD by name) and created fresh, pointed at the
# worktree. Without this tree, every fixture tool's
# `import 'steptix/tools'` fails to resolve (fixtures/tools has its
# own package.json, so the package self-reference resolves against THAT
# package and falls through to a node_modules lookup) and 22 root tests fail.
#
# THE PORT
# A bare `serve` listens on the machine .env's SERVER_URL port, else 3100
# (stories/machine-server-url.md), so two checkouts cannot both serve bare; the
# second exits naming the taken port (deliberately fatal — see
# src/server/api-server.ts). You only need a second server if you
# changed `src/`. A running server resolves each request's project bundle from
# the test file's path (src/server/project-bundle.ts), so it already honours a
# worktree's own steptix.config.json and .env — but it executes whatever `src/`
# build it booted from. Pass -Port to move the worktree's clients onto their own
# server: it rewrites SERVER_URL in the worktree's .env files (gitignored, so no
# diff noise) and prints the matching `serve` command.
#
# Don't try to junction node_modules back to the source checkout to "save time":
# it has no effect on the package self-import `steptix/tools` (resolved
# by path, not via node_modules), and a shared node_modules means a worktree
# `npm install` writes through to the source. Copy + a worktree-local install is
# both correct and fast (the install is incremental on top of the copied tree).

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Destination,

    # Copy only the env files: no node_modules, and no compile step (there would
    # be nothing to compile with). Useful for a docs-only change.
    [switch]$SkipBuilds,

    # Point this worktree's clients at a server on <port> instead of the default
    # 3100, by rewriting SERVER_URL in the seeded .env files.
    [ValidateRange(1, 65535)]
    [int]$Port,

    # Pick the port instead of being told it: the lowest free one from 3101 up
    # that no other checkout has already been seeded with. Re-running on an
    # already-ported worktree keeps the port it had.
    [switch]$AutoPort,

    # Run `npm install` in the worktree after copying. Needed when this branch
    # changed dependencies — the copied node_modules is a snapshot of the
    # source checkout's.
    [switch]$Install,

    # Also copy the cached VS Code build used by the steptix-vscode
    # integration tests (~390 MB). Without it the first
    # `npm run test:integration` in the worktree re-downloads it.
    [switch]$SeedVSCodeTest
)

$ErrorActionPreference = 'Stop'

# PowerShell 7.4 turns native-command stderr into a terminating error under
# $ErrorActionPreference = 'Stop'. robocopy writes progress to stderr and exits
# non-zero on success (1 = files copied), and npm warns constantly — both would
# abort the script. Exit codes are checked explicitly instead.
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

$source = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dest = Resolve-Path $Destination -ErrorAction SilentlyContinue
if (-not $dest) {
    throw "Destination does not exist: $Destination"
}
$dest = $dest.Path

if ($dest -eq $source) {
    throw "Destination is the source checkout ($source) — nothing to seed."
}

if ($AutoPort -and $PSBoundParameters.ContainsKey('Port')) {
    throw "-Port and -AutoPort are mutually exclusive; -AutoPort picks the port for you."
}

Write-Host "Source:      $source"
Write-Host "Destination: $dest"
Write-Host ""

# --- helpers ---------------------------------------------------------------

function Invoke-Npm {
    param(
        [Parameter(Mandatory)][string]$Dir,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    if (-not (Test-Path $Dir)) {
        Write-Host "  skip  npm $($Arguments -join ' ') (no $Dir)"
        return
    }
    Write-Host "  run   npm $($Arguments -join ' ')  [$Dir]"
    Push-Location $Dir
    try {
        & npm @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "npm $($Arguments -join ' ') failed (exit $LASTEXITCODE) in $Dir"
        }
    } finally {
        Pop-Location
    }
}

function Copy-Tree {
    param(
        [Parameter(Mandatory)][string]$From,
        [Parameter(Mandatory)][string]$To
    )
    # /MIR mirrors; /NFL /NDL /NJH /NJS /NP quiet the output; /MT:16 uses 16
    # threads, much faster on Windows for trees with many small files.
    $roboArgs = @($From, $To, '/MIR', '/MT:16', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    $null = & robocopy @roboArgs
    # robocopy exit codes 0-7 are success; 8+ are errors.
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy failed for $From -> $To (exit $LASTEXITCODE)"
    }
}

# Delete a path whether it is a real directory or a reparse point. Remove-Item
# -Recurse on a junction has historically deleted the TARGET's contents, which
# here would mean wiping the worktree's runner-core source.
function Remove-DirOrLink {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path $Path)) { return }
    $item = Get-Item $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        [IO.Directory]::Delete($Path, $false)
    } else {
        Remove-Item -Path $Path -Recurse -Force
    }
}

# Rewrite (or append) SERVER_URL without disturbing anything else in the file.
#
# Written with an explicit BOM-less UTF-8 encoder: Set-Content -Encoding UTF8
# emits a BOM on Windows PowerShell 5.1, and a BOM in front of the first key
# makes dotenv parse it as part of that key's name.
#
# The match stops at [^\r\n] rather than `.*$` so a CRLF file keeps its CR:
# in .NET multiline mode `$` asserts before the \n, and a greedy `.` would eat
# the \r on the way there, silently converting just that one line to LF.
function Set-ServerUrl {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Url
    )
    if (-not (Test-Path $Path)) { return $false }

    $text = [IO.File]::ReadAllText($Path)
    # '$' is the substitution marker in a .NET replacement string.
    $replacement = "SERVER_URL=$Url".Replace('$', '$$')
    $pattern = '(?m)^[ \t]*SERVER_URL[ \t]*=[^\r\n]*'

    if ([regex]::IsMatch($text, $pattern)) {
        $text = [regex]::Replace($text, $pattern, $replacement)
    } else {
        # Match the file's existing newline style rather than imposing one.
        $nl = if ($text -match "`r`n") { "`r`n" } else { "`n" }
        if ($text.Length -gt 0 -and -not $text.EndsWith("`n")) { $text += $nl }
        $text += "SERVER_URL=$Url$nl"
    }

    $utf8NoBom = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText($Path, $text, $utf8NoBom)
    return $true
}

# The port a checkout has been seeded with, read back off its SERVER_URL.
function Get-EnvPort {
    param([Parameter(Mandatory)][string]$EnvPath)
    if (-not (Test-Path $EnvPath)) { return 0 }
    $text = [IO.File]::ReadAllText($EnvPath)
    $m = [regex]::Match($text, '(?m)^[ \t]*SERVER_URL[ \t]*=[ \t]*[A-Za-z]+://[^:/\s]+:(\d+)')
    if ($m.Success) { return [int]$m.Groups[1].Value }
    return 0
}

function Test-PortFree {
    param([Parameter(Mandatory)][int]$Candidate)
    $listener = $null
    try {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Candidate)
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($listener) { try { $listener.Stop() } catch { } }
    }
}

# Lowest free port from $Start up.
#
# A port another checkout was seeded with counts as taken even when nothing is
# listening on it right now — that worktree's server is merely stopped, and
# handing the same port to two worktrees defers the collision rather than
# avoiding it. So the claim comes from every registered worktree's .env, not
# from a bind test alone.
#
# $Preferred (the port this worktree already had, captured before its .env was
# overwritten) wins outright when no sibling claims it, which makes re-running
# the script idempotent — deliberately WITHOUT a bind test, since a bound
# $Preferred is almost certainly this worktree's own server still running.
function Find-FreePort {
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [int]$Preferred = 0,
        [int]$Start = 3101
    )
    $claimed = [Collections.Generic.HashSet[int]]::new()
    $paths = @()
    Push-Location $SourceRoot
    try {
        foreach ($line in (& git worktree list --porcelain)) {
            if ($line -match '^worktree\s+(.+)$') { $paths += $Matches[1] }
        }
    } finally {
        Pop-Location
    }
    foreach ($p in $paths) {
        $port = Get-EnvPort -EnvPath (Join-Path ($p -replace '/', '\') '.env')
        if ($port -gt 0) { $null = $claimed.Add($port) }
    }

    if ($Preferred -ge $Start -and -not $claimed.Contains($Preferred)) {
        return $Preferred
    }
    for ($c = $Start; $c -le 65535; $c++) {
        if ($claimed.Contains($c)) { continue }
        if (Test-PortFree -Candidate $c) { return $c }
    }
    throw "No free port found at or above $Start."
}

# Captured BEFORE the copy below overwrites this worktree's .env with the
# source's — otherwise a re-run would forget the port it handed out last time.
$previousPort = Get-EnvPort -EnvPath (Join-Path $dest '.env')

# --- 1. env files and local settings ---------------------------------------

# Small files, copied individually. `templates/.env` is load-bearing: the
# steptix-vscode live harness (tests/integration/runLiveTest.cjs) opens
# templates/ as its workspace and hard-throws when that file is absent.
$files = @(
    '.env',
    '.env.local',
    '.env.uat',
    'templates/.env',
    '.claude/settings.local.json',
    'steptix-vscode/tests/integration/fixtures/.env'
)

$copied = 0
$skipped = 0

Write-Host "Env files and local settings:"
foreach ($rel in $files) {
    $src = Join-Path $source $rel
    $dst = Join-Path $dest $rel
    if (-not (Test-Path $src)) {
        Write-Host "  skip  $rel (not in source)"
        $skipped++
        continue
    }
    $dstDir = Split-Path $dst -Parent
    if (-not (Test-Path $dstDir)) {
        New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
    }
    Copy-Item -Path $src -Destination $dst -Force
    Write-Host "  copy  $rel"
    $copied++
}

# --- 2. node_modules trees --------------------------------------------------

$dirs = @(
    'node_modules',
    'flick-vscode/node_modules',
    'steptix-vscode/node_modules',
    'runner-core/node_modules'
)

if ($SkipBuilds) {
    Write-Host ""
    Write-Host "Skipping node_modules and the build (-SkipBuilds)."
} else {
    Write-Host ""
    Write-Host "Dependency trees (~1.1 GB):"
    foreach ($rel in $dirs) {
        $src = Join-Path $source $rel
        $dst = Join-Path $dest $rel
        if (-not (Test-Path $src)) {
            Write-Host "  skip  $rel/ (not in source)"
            $skipped++
            continue
        }
        Write-Host "  copy  $rel/ ..."
        Copy-Tree -From $src -To $dst
        $copied++
    }

    # --- 3. re-point the runner-core junction (see THE JUNCTION above) ------

    $linkPath = Join-Path $dest 'steptix-vscode\node_modules\steptix-runner-core'
    $linkTarget = Join-Path $dest 'runner-core'
    if (Test-Path $linkTarget) {
        Write-Host ""
        Write-Host "Re-pointing the runner-core junction at this worktree:"
        Remove-DirOrLink -Path $linkPath
        $linkParent = Split-Path $linkPath -Parent
        if (-not (Test-Path $linkParent)) {
            New-Item -ItemType Directory -Path $linkParent -Force | Out-Null
        }
        New-Item -ItemType Junction -Path $linkPath -Target $linkTarget | Out-Null
        Write-Host "  link  steptix-vscode/node_modules/steptix-runner-core -> $linkTarget"
    }

    # --- 3b. fixture tools tree (see THE JUNCTION above: this one is
    #         excluded from the copy, never followed-then-repaired) ----------

    $ftRel = 'fixtures\tools\node_modules'
    $ftSrc = Join-Path $source $ftRel
    $ftDst = Join-Path $dest $ftRel
    if (Test-Path $ftSrc) {
        Write-Host ""
        Write-Host "Fixture tools dependency tree:"
        Write-Host "  copy  fixtures/tools/node_modules/ ..."
        # /XD by bare name so the junction is skipped in the source AND left
        # alone in the destination on a /MIR re-run.
        $roboArgs = @($ftSrc, $ftDst, '/MIR', '/MT:16', '/NFL', '/NDL', '/NJH', '/NJS', '/NP',
            '/XD', 'steptix')
        $null = & robocopy @roboArgs
        if ($LASTEXITCODE -ge 8) {
            throw "robocopy failed for $ftSrc -> $ftDst (exit $LASTEXITCODE)"
        }
        $copied++
        $ftLink = Join-Path $ftDst 'steptix'
        Remove-DirOrLink -Path $ftLink
        New-Item -ItemType Junction -Path $ftLink -Target $dest | Out-Null
        Write-Host "  link  fixtures/tools/node_modules/steptix -> $dest"
    } else {
        Write-Host "  skip  fixtures/tools/node_modules/ (not in source — run npm install in fixtures/tools first)"
        $skipped++
    }

    # --- 4. optional: cached VS Code for the integration tests --------------

    if ($SeedVSCodeTest) {
        Write-Host ""
        Write-Host "VS Code test cache:"
        $cacheRoot = Join-Path $source 'steptix-vscode\.vscode-test'
        if (-not (Test-Path $cacheRoot)) {
            Write-Host "  skip  .vscode-test/ (not in source — it downloads on first test run)"
            $skipped++
        } else {
            # Copy only the version the harness actually asks for; the cache can
            # hold stale ones. `user-data*` and `extensions*` are per-run state
            # and are deliberately left behind.
            $runTest = Join-Path $source 'steptix-vscode\tests\integration\runTest.cjs'
            $wanted = @()
            if (Test-Path $runTest) {
                $m = Select-String -Path $runTest -Pattern "VERSION\s*=\s*'([^']+)'" |
                    Select-Object -First 1
                if ($m) { $wanted = @($m.Matches[0].Groups[1].Value) }
            }
            $archives = @(Get-ChildItem $cacheRoot -Directory -Filter 'vscode-*-archive-*')
            if ($wanted.Count -gt 0) {
                $archives = @($archives | Where-Object {
                    $name = $_.Name
                    ($wanted | Where-Object { $name.EndsWith("-$_") }).Count -gt 0
                })
            }
            if ($archives.Count -eq 0) {
                Write-Host "  skip  .vscode-test/ (no cached archive for $($wanted -join ', '))"
                $skipped++
            }
            foreach ($a in $archives) {
                Write-Host "  copy  .vscode-test/$($a.Name)/ ..."
                Copy-Tree -From $a.FullName `
                    -To (Join-Path $dest "steptix-vscode\.vscode-test\$($a.Name)")
                $copied++
            }
        }
    }

    # --- 5. optional: refresh dependencies ----------------------------------

    if ($Install) {
        Write-Host ""
        Write-Host "Refreshing dependencies (-Install):"
        Invoke-Npm -Dir $dest -Arguments @('install')
        Invoke-Npm -Dir (Join-Path $dest 'steptix-vscode') -Arguments @('install')
    }

    # --- 6. build -----------------------------------------------------------

    # dist/ must exist before the worktree's fixtures can resolve the package
    # self-import `steptix/tools` — that resolves via the `exports`
    # field plus the NEAREST package.json, so it lands in the worktree's own
    # dist/tools/index.js, and only once it has been built.
    Write-Host ""
    Write-Host "Building:"
    Invoke-Npm -Dir $dest -Arguments @('run', 'build')
    Invoke-Npm -Dir (Join-Path $dest 'steptix-vscode') -Arguments @('run', 'build')
    Invoke-Npm -Dir (Join-Path $dest 'flick-vscode') -Arguments @('run', 'build')
}

# --- 7. server URL ----------------------------------------------------------

$serverUrl = $null

if ($AutoPort) {
    $Port = Find-FreePort -SourceRoot $source -Preferred $previousPort
    Write-Host ""
    if ($Port -eq $previousPort) {
        Write-Host "Auto-allocated port: $Port (unchanged — this worktree already had it)"
    } else {
        Write-Host "Auto-allocated port: $Port"
    }
}

if ($Port -gt 0) {
    $serverUrl = "http://localhost:$Port"
    Write-Host ""
    Write-Host "Pointing this worktree's clients at ${serverUrl}:"
    foreach ($rel in @('.env', 'templates/.env')) {
        # Deliberately NOT steptix-vscode/tests/integration/fixtures/.env —
        # its SERVER_URL is a dead port for the FakeApiClient, not a real server.
        $p = Join-Path $dest $rel
        if (Set-ServerUrl -Path $p -Url $serverUrl) {
            Write-Host "  edit  $rel  SERVER_URL=$serverUrl"
        } else {
            Write-Host "  skip  $rel (not present)"
        }
    }
}

# --- summary ----------------------------------------------------------------

Write-Host ""
Write-Host "Done. Copied $copied, skipped $skipped."
Write-Host ""

if ($SkipBuilds) {
    Write-Host "Env files only. Run 'npm install' and 'npm run build' in the worktree"
    Write-Host "before anything will actually run."
    Write-Host ""
}

Write-Host "Start the Sessions API server for this worktree:"
Write-Host ""
if ($serverUrl) {
    Write-Host "    cd `"$dest`"; node dist/index.js serve -p $Port --idle-timeout 60"
} else {
    Write-Host "    cd `"$dest`"; node dist/index.js serve --idle-timeout 60"
    Write-Host ""
    Write-Host "NOTE: that binds the default port (3100, unless SERVER_URL in the machine"
    Write-Host ".env names another). If another checkout is already serving there this"
    Write-Host "exits naming the taken port — re-run this script with"
    Write-Host "-Port <n> to give the worktree its own server."
}
Write-Host ""
Write-Host "Steptix: 'steptix.serverAutoStart.cwd' is machine-scoped (User"
Write-Host "settings only, by design), so a worktree window auto-starts the server from"
Write-Host "whichever checkout that setting names — not from this one. Start the server"
Write-Host "yourself with the command above and Steptix will use it."

if ($serverUrl) {
    Write-Host ""
    Write-Host "That matters more on a non-default port: the auto-start command carries no"
    Write-Host "-p flag, so it would listen on the default port rather than $Port, and"
    Write-Host "Steptix refuses to start it (STX033). Start this worktree's server first."
    Write-Host ""
    Write-Host "Live integration tests read LIVE_SERVER_URL and fall back to :3100 in every"
    Write-Host "suite, so point them at this worktree's server explicitly:"
    Write-Host ""
    Write-Host "    cd `"$dest\steptix-vscode`""
    Write-Host "    `$env:LIVE_SERVER_URL = `"$serverUrl`"; npm run test:live"
}
