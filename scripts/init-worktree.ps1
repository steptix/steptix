# Seed a git worktree with the gitignored files/dirs needed to run things.
#
# Usage:
#   .\scripts\init-worktree.ps1 -Destination C:\path\to\worktree
#   .\scripts\init-worktree.ps1 -Destination ..\.claude\worktrees\foo -SkipBuilds
#
# Copies (rather than symlinks/junctions) so the worktree is fully independent
# — safe when package.json diverges between branches. The trade-off is disk: a
# full seed is ~1.1 GB of node_modules.
#
# NOTE: this seeds node_modules, NOT dist/. The package
# self-import `ai-ui-automation/tools` resolves (via the package `exports`
# field + nearest package.json) to dist/tools/index.js *under the worktree
# root*, so the worktree's fixtures use the worktree's own tool code — but only
# once dist/ exists. dist/ is gitignored and not copied, so after seeding you
# MUST build it in the worktree:
#
#   cd <worktree>; npm run build
#
# Don't junction node_modules back to the main checkout to "save time": it
# doesn't affect the self-import (that's resolved by path, not node_modules),
# and a shared node_modules means `npm install` in the worktree writes through
# to main. Copy + a worktree-local `npm install`/`npm run build` is both
# correct and fast (the install is incremental on top of the copied tree).

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Destination,

    # Skip the heavy build dirs (the node_modules trees). Useful if you
    # want a fast seed and don't mind rebuilding in the worktree.
    [switch]$SkipBuilds
)

$ErrorActionPreference = 'Stop'

$source = Resolve-Path (Join-Path $PSScriptRoot '..')
$dest = Resolve-Path $Destination -ErrorAction SilentlyContinue
if (-not $dest) {
    throw "Destination does not exist: $Destination"
}

Write-Host "Source:      $source"
Write-Host "Destination: $dest"
Write-Host ""

# Individual files — small, copy with Copy-Item.
$files = @(
    '.env',
    '.env.local',
    '.env.uat',
    '.claude/settings.local.json',
    'testbench-native/tests/integration/fixtures/.env'
)

# Directories — large, copy with robocopy for speed.
$dirs = @(
    'node_modules',
    'flick-vscode/node_modules',
    'testbench-native/node_modules',
    'runner-core/node_modules'
)

$copied = 0
$skipped = 0

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

if ($SkipBuilds) {
    Write-Host ""
    Write-Host "Skipping build dirs (-SkipBuilds). Run 'npm install' in each project as needed."
} else {
    foreach ($rel in $dirs) {
        $src = Join-Path $source $rel
        $dst = Join-Path $dest $rel
        if (-not (Test-Path $src)) {
            Write-Host "  skip  $rel/ (not in source)"
            $skipped++
            continue
        }
        Write-Host "  copy  $rel/ ..."
        # /MIR mirrors; /NFL /NDL /NJH /NJS /NP quiet the output.
        # /MT:16 uses 16 threads — much faster on Windows for trees with many small files.
        $null = robocopy $src $dst /MIR /MT:16 /NFL /NDL /NJH /NJS /NP
        # robocopy exit codes 0-7 are success; 8+ are errors.
        if ($LASTEXITCODE -ge 8) {
            throw "robocopy failed for $rel (exit $LASTEXITCODE)"
        }
        $copied++
    }
}

Write-Host ""
Write-Host "Done. Copied $copied, skipped $skipped."
Write-Host ""
Write-Host "Next: build dist/ in the worktree so the package self-import"
Write-Host "('ai-ui-automation/tools' -> dist/tools/index.js) resolves to this"
Write-Host "worktree's code, not the main checkout's:"
Write-Host ""
Write-Host "    cd `"$dest`"; npm run build"
