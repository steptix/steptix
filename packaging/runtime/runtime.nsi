Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!define PRODUCT "Steptix Runtime"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\SteptixRuntime-${VERSION}"
; Names this folder's Installed Apps entry, for the uninstaller: a test install
; registers under its own key, and the uninstaller must remove that one.
!define KEY_FILE ".steptix-runtime-uninstall-key"
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
Var UninstallKey
Var DisplayName
Var NodeExe
!define MUI_WELCOMEPAGE_TEXT "Install the Steptix server and CLI for your Windows user account.$\r$\n$\r$\nRequires an existing x64 Node.js 22.21+ installation. Node.js and browsers are not included.$\r$\n$\r$\nUse installed Chrome/Edge or install Playwright browsers afterwards. The Steptix VS Code extension finds this runtime and starts its server when you run a test."
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
  StrCpy $UninstallKey "${UNINSTALL_KEY}"
  StrCpy $DisplayName "${PRODUCT} ${VERSION}"
  ; /TESTMODE=<id> is the end-to-end test's install (scripts/verify-runtime.mjs).
  ; It still registers with Installed Apps, because uninstalling through that
  ; entry is part of what the test proves, but under a key of its own: a real
  ; install of the same version on the same machine is never touched. It
  ; creates no Start menu folder.
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/TESTMODE=" $1
  ${IfNot} ${Errors}
    ${If} $1 == ""
      MessageBox MB_ICONSTOP "/TESTMODE needs an id: /TESTMODE=<id>."
      Abort
    ${EndIf}
    StrCpy $TestMode "1"
    StrCpy $UninstallKey "${UNINSTALL_KEY}-test-$1"
    StrCpy $DisplayName "${PRODUCT} ${VERSION} (installer test $1)"
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
  FileOpen $0 "$INSTDIR\${KEY_FILE}" w
  FileWrite $0 "$UninstallKey"
  FileClose $0
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "$UninstallKey" "DisplayName" "$DisplayName"
  WriteRegStr HKCU "$UninstallKey" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "$UninstallKey" "Publisher" "Paul Kent"
  WriteRegStr HKCU "$UninstallKey" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "$UninstallKey" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegDWORD HKCU "$UninstallKey" "NoModify" 1
  WriteRegDWORD HKCU "$UninstallKey" "NoRepair" 1
  ${If} $TestMode != "1"
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
  StrCpy $UninstallKey "${UNINSTALL_KEY}"
  ${If} ${FileExists} "$INSTDIR\${KEY_FILE}"
    FileOpen $0 "$INSTDIR\${KEY_FILE}" r
    FileRead $0 $UninstallKey
    FileClose $0
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
  Delete "$INSTDIR\${KEY_FILE}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  ReadRegStr $0 HKCU "$UninstallKey" "InstallLocation"
  ${If} $0 == $INSTDIR
    DeleteRegKey HKCU "$UninstallKey"
    ; The Start menu folder belongs to the real entry only. A test install made
    ; none, and must not remove a real install's.
    ${If} $UninstallKey == "${UNINSTALL_KEY}"
      RMDir /r "$SMPROGRAMS\Steptix Runtime ${VERSION}"
    ${EndIf}
  ${EndIf}
SectionEnd
