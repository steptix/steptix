@echo off
setlocal
if defined STEPTIX_NODE (
  "%STEPTIX_NODE%" "%~dp0run-newest-runtime.cjs" %*
) else (
  node "%~dp0run-newest-runtime.cjs" %*
)
exit /b %errorlevel%
