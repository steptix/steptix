Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!define PRODUCT "Steptix Runtime"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\SteptixRuntime-${VERSION}"
Name "${PRODUCT} ${VERSION}"
OutFile "${OUTPUT}\SteptixRuntimeSetup-${VERSION}-win-x64.exe"
InstallDir "$LOCALAPPDATA\steptix\runtimes\${VERSION}"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 32
VIProductVersion "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "ProductName" "${PRODUCT}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "FileDescription" "Steptix per-user runtime installer (Node.js required)"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright 2026 Paul Kent"
Var TestMode
Var NodeExe
!define MUI_WELCOMEPAGE_TEXT "Install the Steptix server and CLI for your Windows user account.$\r$\n$\r$\nRequires an existing x64 Node.js 22.21+ installation. Node.js and browsers are not included.$\r$\n$\r$\nUse installed Chrome/Edge or install Playwright browsers afterwards. The VS Code extension currently needs its server command configured; automatic runtime discovery is planned."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${PAYLOAD}\server\LICENSE"
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open runtime setup instructions"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenReadme
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  SetShellVarContext current
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "This installer requires 64-bit Windows."
    Abort
  ${EndIf}
  StrCpy $TestMode "0"
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/TESTMODE" $1
  ${IfNot} ${Errors}
    StrCpy $TestMode "1"
  ${EndIf}
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "${PAYLOAD}\node-check.cjs"
  ReadEnvStr $NodeExe "STEPTIX_NODE"
  ${If} $NodeExe == ""
    StrCpy $NodeExe "node"
  ${EndIf}
  nsExec::ExecToStack '"$NodeExe" "$PLUGINSDIR\node-check.cjs"'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    IfSilent +2
    MessageBox MB_ICONINFORMATION "Node.js x64 22.21+ was not found or is incompatible. Install it and restart VS Code before using this runtime. Alternatively set STEPTIX_NODE to your node.exe path.$\r$\n$\r$\nThe runtime can still be installed now."
  ${EndIf}
FunctionEnd

Section "Steptix Runtime" Main
  SectionIn RO
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}\*"
  FileOpen $0 "$INSTDIR\.steptix-runtime-install" w
  FileWrite $0 "${VERSION}"
  FileClose $0
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  ${If} $TestMode != "1"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT} ${VERSION}"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Paul Kent"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
    WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
    WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
    CreateDirectory "$SMPROGRAMS\Steptix Runtime ${VERSION}"
    CreateShortCut "$SMPROGRAMS\Steptix Runtime ${VERSION}\Setup instructions.lnk" "$INSTDIR\README.txt"
    CreateShortCut "$SMPROGRAMS\Steptix Runtime ${VERSION}\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  ${EndIf}
SectionEnd

Function OpenReadme
  ExecShell "open" "$INSTDIR\README.txt"
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  IfFileExists "$INSTDIR\.steptix-runtime-install" +3
    MessageBox MB_ICONSTOP "Runtime installation marker is missing. Refusing to remove files."
    Abort
  FileOpen $0 "$INSTDIR\.steptix-runtime-install" r
  FileRead $0 $1
  FileClose $0
  ${If} $1 != "${VERSION}"
    MessageBox MB_ICONSTOP "Runtime installation marker does not match this version."
    Abort
  ${EndIf}
  ; Remove only this version's packaged directories. Never remove the shared user root or browser cache.
  RMDir /r "$INSTDIR\server"
  Delete "$INSTDIR\steptix.cmd"
  Delete "$INSTDIR\runtime-launcher.cjs"
  Delete "$INSTDIR\runtime-bootstrap.mjs"
  Delete "$INSTDIR\node-check.cjs"
  Delete "$INSTDIR\runtime-manifest.json"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\.steptix-runtime-install"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  ${If} $0 == $INSTDIR
    DeleteRegKey HKCU "${UNINSTALL_KEY}"
    RMDir /r "$SMPROGRAMS\Steptix Runtime ${VERSION}"
  ${EndIf}
SectionEnd
