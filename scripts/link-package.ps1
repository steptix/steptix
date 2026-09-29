# Creates a symbolic link inside a node_modules folder pointing at a package
# source tree, so a consumer project can import the package by name (like
# `npm link`, but done manually).
#
# Note: creating symlinks on Windows needs Developer Mode enabled or an
# elevated shell, otherwise New-Item -ItemType SymbolicLink fails.

# --- Configure these ---------------------------------------------------------

# Change this path to point to the Steptix directory.
$PackagePath = "C:\Projects\vibe\steptix"

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

# Use the package folder's own name as the link name (e.g. "steptix").
$linkName = Split-Path $PackagePath -Leaf
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
