# Seed a git worktree with the gitignored files/dirs needed to run things.
#
# Usage:
#   .\scripts\init-worktree.ps1 -Destination C:\path\to\worktree
#   .\scripts\init-worktree.ps1 -Destination ..\.claude\worktrees\foo -SkipBuilds
#
# Copies (rather than symlinks) so the worktree is fully independent — safe
# when package.json / Cargo.toml diverge between branches. The trade-off is
# disk: a full seed is ~5 GB once flick/src-tauri/target is populated.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Destination,

    # Skip the heavy build dirs (node_modules, Rust target). Useful if you
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
    'flick/node_modules',
    'flick/src-tauri/target',
    'flick-vscode/node_modules',
    'testbench-monaco/node_modules',
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
    Write-Host "Skipping build dirs (-SkipBuilds). Run 'npm install' in each project and rebuild Tauri as needed."
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
