Add-Type -AssemblyName System.Drawing
$src = "$PSScriptRoot\src-tauri\icons\128x128@2x.png"
$dst = "$PSScriptRoot\src-tauri\icons\icon.ico"
$bmp = [System.Drawing.Bitmap]::FromFile($src)
$hicon = $bmp.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hicon)
$fs = [System.IO.File]::Create($dst)
$icon.Save($fs)
$fs.Close()
$bmp.Dispose()
Write-Host "Wrote $dst"
