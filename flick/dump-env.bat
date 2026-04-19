@echo off
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat" x64
echo ==== LIB ====
echo %LIB%
echo.
echo ==== INCLUDE ====
echo %INCLUDE%
echo.
echo ==== WindowsSdkDir ====
echo %WindowsSdkDir%
echo ==== WindowsSDKVersion ====
echo %WindowsSDKVersion%
