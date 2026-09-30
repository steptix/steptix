# Creates a symbolic link inside a node_modules folder pointing at a package
# source tree, so a consumer project can import the package by name (like
# `npm link`, but done manually).
#
# Note: creating symlinks on Windows needs Developer Mode enabled or an
# elevated shell, otherwise New-Item -ItemType SymbolicLink fails.

# --- Configure these ---------------------------------------------------------

# The Steptix checkout this script sits in. Change it only to link a different one.
$PackagePath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# Change this path to be the root folder where the test project is in.
# This is the folder where the symbolic/junction link should be created.
# If the node_modules folder does not exist, it will be created
$NodeModulesPath = "C:\Projects\AITests\node_modules"

# -----------------------------------------------------------------------------

# Fail early if the package source tree doesn't exist, rather than creating a
# dangling symlink to a nonexistent target.
if (-not (Test-Path $PackagePath -PathType Container)) {
    throw "PackagePath does not exist (or is not a directory): $PackagePath"
}

# Name the link after the package, not its folder: consumers import it by
# package name, and a checkout's folder (e.g. a worktree's) can be called
# anything.
$linkName = (Get-Content (Join-Path $PackagePath 'package.json') -Raw | ConvertFrom-Json).name
$linkPath = Join-Path $NodeModulesPath $linkName

if (-not (Test-Path $NodeModulesPath)) {
    New-Item -ItemType Directory -Path $NodeModulesPath | Out-Null
}

try {
    New-Item -ItemType SymbolicLink -Path $linkPath -Target $PackagePath -ErrorAction Stop | Out-Null
    "symlink created: $linkPath -> $PackagePath"
} catch {
    "FAILED: $($_.Exception.Message)"
}
