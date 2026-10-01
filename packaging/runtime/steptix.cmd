@echo off
setlocal
if defined STEPTIX_NODE (
  "%STEPTIX_NODE%" "%~dp0runtime-launcher.cjs" %*
) else (
  node "%~dp0runtime-launcher.cjs" %*
)
exit /b %errorlevel%
