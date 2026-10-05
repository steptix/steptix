# What the runtime installer and uninstaller (runtime.nsi, runtime-scan.nsh)
# need to know about the runtimes on this machine, for Windows PowerShell 5.1.
#
#   -Mode older -RuntimesDir <dir> -Version <v> -Out <file>
#       Writes one line per installed runtime older than <v>, its folder, to
#       <file> as UTF-16LE. These are the runtimes installing <v> removes.
#   -Mode blocking [-RuntimesDir <dir> -Version <v>] [-Folder <dir>]...
#       Prints one line per folder that Steptix is running from, among the
#       runtimes older than <v> and each -Folder: "<name>: node.exe (pid 123)".
#       Prints nothing when none is. These are the folders an install or
#       uninstall would change under a running server.
#
# Prints "ok" last. Anything else, or a non-zero exit code, means the scan
# failed, and the caller must not act on a partial answer.
#
# An installed runtime is a folder the extension would start (the launch files
# of runtimeLaunchFiles, steptix-vscode/src/extension/server-manager.ts) that
# this installer made: its marker and its uninstaller are there too. Nothing
# else under runtimes is ever counted or touched.
#
# Versions compare by the folder name, as compareVersions in server-manager.ts
# compares them. Windows PowerShell 5.1 has no semantic version type, so this
# is a deliberate copy. steptix-vscode/tests/runtime-scan.test.js holds it to
# the same answers.
param(
  [Parameter(Mandatory = $true)][ValidateSet('older', 'blocking')][string]$Mode,
  [string]$RuntimesDir = '',
  [string]$Version = '',
  [string[]]$Folder = @(),
  [string]$Out = ''
)
$ErrorActionPreference = 'Stop'

$VersionPattern = '^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$'

# Semver precedence: a prerelease sorts below its release, and prerelease
# identifiers compare numerically when both are numbers. A name that is not a
# version sorts below every one that is. Returns -1, 0 or 1.
function Compare-RuntimeVersion([string]$a, [string]$b) {
  $va = [regex]::Match($a, $VersionPattern)
  $vb = [regex]::Match($b, $VersionPattern)
  if (-not $va.Success -or -not $vb.Success) {
    if ($va.Success) { return 1 }
    if ($vb.Success) { return -1 }
    return [math]::Sign([string]::CompareOrdinal($a, $b))
  }
  for ($i = 1; $i -le 3; $i++) {
    $diff = [double]$va.Groups[$i].Value - [double]$vb.Groups[$i].Value
    if ($diff -ne 0) { return [math]::Sign($diff) }
  }
  $pa = @()
  $pb = @()
  if ($va.Groups[4].Success) { $pa = $va.Groups[4].Value.Split('.') }
  if ($vb.Groups[4].Success) { $pb = $vb.Groups[4].Value.Split('.') }
  # A release outranks every prerelease of itself.
  if ($pa.Count -eq 0 -or $pb.Count -eq 0) { return [math]::Sign($pb.Count - $pa.Count) }
  for ($i = 0; $i -lt [math]::Min($pa.Count, $pb.Count); $i++) {
    $x = $pa[$i]
    $y = $pb[$i]
    if ([string]::Equals($x, $y, [StringComparison]::Ordinal)) { continue }
    $xNumeric = $x -match '^\d+$'
    $yNumeric = $y -match '^\d+$'
    if ($xNumeric -and $yNumeric) { return [math]::Sign([double]$x - [double]$y) }
    if ($xNumeric -ne $yNumeric) { if ($xNumeric) { return -1 } else { return 1 } }
    return [math]::Sign([string]::CompareOrdinal($x, $y))
  }
  return [math]::Sign($pa.Count - $pb.Count)
}

# A path in its one comparable form: absolute and long. .NET Framework's
# GetFullPath expands 8.3 names of paths that exist, and a command line can
# hold any mix of them: C:\Users\PAULKE~1\...\runtimes\1.0.0 is the same
# folder as C:\Users\Paul Kent\...\runtimes\1.0.0. Null for anything that is
# not an absolute path.
function Get-LongPath([string]$path) {
  if (-not $path) { return $null }
  # Both throw on characters a path cannot hold, which an argument can.
  try {
    if (-not [System.IO.Path]::IsPathRooted($path)) { return $null }
    [System.IO.Path]::GetFullPath($path)
  } catch { $null }
}

$RuntimeFiles = @('runtime-launcher.cjs', 'server\dist\index.js', 'steptix.cmd', '.steptix-runtime-install', 'Uninstall.exe')

# The installed runtimes older than $Version, as folder paths. Plain loops and
# .NET calls throughout: pipelines cost seconds here, and the installer waits.
function Get-OlderRuntimes {
  if ($RuntimesDir -eq '' -or -not [System.IO.Directory]::Exists($RuntimesDir)) { return }
  foreach ($dir in [System.IO.Directory]::GetDirectories($RuntimesDir)) {
    if ((Compare-RuntimeVersion ([System.IO.Path]::GetFileName($dir)) $Version) -ge 0) { continue }
    $installed = $true
    foreach ($file in $RuntimeFiles) {
      if (-not [System.IO.File]::Exists([System.IO.Path]::Combine($dir, $file))) { $installed = $false; break }
    }
    if ($installed) { $dir }
  }
}

try {
  if ($Mode -eq 'older') {
    $lines = [string[]]@(Get-OlderRuntimes)
    [System.IO.File]::WriteAllLines($Out, $lines, (New-Object System.Text.UnicodeEncoding $false, $false))
  } else {
    $folders = @(@(Get-OlderRuntimes) + $Folder | Where-Object { $_ -ne '' })
    if ($folders.Count -gt 0) {
      $long = @(foreach ($dir in $folders) { (Get-LongPath $dir).TrimEnd('\') + '\' })
      $running = @(foreach ($dir in $folders) { , (New-Object System.Collections.Generic.List[string]) })
      $processes = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine)
      # This scan and whatever ran it (the installer or uninstaller, whose
      # command line names these folders) are not Steptix running.
      $ignored = @($PID)
      foreach ($process in $processes) { if ($process.ProcessId -eq $PID) { $ignored += $process.ParentProcessId } }
      foreach ($process in $processes) {
        if ($ignored -contains $process.ProcessId) { continue }
        # Steptix runs as node.exe with a file from the folder on its command
        # line (the launcher, the server, a CLI run), and as executables in
        # the folder (esbuild). A shell or an editor that merely names the
        # folder does not hold it.
        $paths = @()
        if ($process.ExecutablePath) { $paths += $process.ExecutablePath }
        if ($process.Name -ieq 'node.exe' -and $process.CommandLine) {
          foreach ($arg in [regex]::Matches($process.CommandLine, '"([^"]*)"|(\S+)')) {
            if ($arg.Groups[1].Success) { $paths += $arg.Groups[1].Value } else { $paths += $arg.Groups[2].Value }
          }
        }
        foreach ($path in $paths) {
          # Only a path with an 8.3 name or a ".." needs GetFullPath, the slow part.
          if ($path.Contains('~') -or $path.Contains('..')) { $path = Get-LongPath $path }
          if (-not $path) { continue }
          for ($i = 0; $i -lt $long.Count; $i++) {
            $label = "$($process.Name) (pid $($process.ProcessId))"
            if ($path.StartsWith($long[$i], [StringComparison]::OrdinalIgnoreCase) -and -not $running[$i].Contains($label)) {
              $running[$i].Add($label)
            }
          }
        }
      }
      for ($i = 0; $i -lt $long.Count; $i++) {
        if ($running[$i].Count -gt 0) {
          Write-Output "$([System.IO.Path]::GetFileName($long[$i].TrimEnd('\'))): $($running[$i] -join ', ')"
        }
      }
    }
  }
  Write-Output 'ok'
} catch {
  Write-Output "failed: $($_.Exception.Message)"
  exit 1
}
