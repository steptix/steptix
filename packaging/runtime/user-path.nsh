; `steptix` on PATH (README.md, "On PATH"). Included by runtime.nsi after
; SetCompressor, since it defines functions.
;
; One folder for every version, <user root>\bin, holds a steptix.cmd that runs
; the newest installed runtime (bin\run-newest-runtime.cjs). Each version
; installs into runtimes\<version> and the older ones stay, so putting those
; folders on PATH would add an entry per version, and Windows would run the
; first one: the oldest.
;
; The folder goes in the user's own Path value, which needs no elevation.
; Never the PATH this process sees: that is the system and user values merged
; and expanded, and writing it back would copy the system's entries into the
; user's. The value is written as REG_EXPAND_SZ, the type Windows keeps it as,
; so entries like %USERPROFILE%\... stay unexpanded.

!include "LogicLib.nsh"
!include "WinMessages.nsh"

; The HKCU key whose Path value is the user's: Environment, or in /TESTMODE a
; key of the test's own, so a test never touches the PATH of whoever runs it.
Var PathKey
; FindPathEntry's arguments and results.
Var PathValue
Var PathFolder
Var PathFound
Var PathRest

; The user root, as node derives it (userRootDir, src/env/user-root.ts):
; %LOCALAPPDATA%\steptix, reading %LOCALAPPDATA% from the environment. NSIS's
; own $LOCALAPPDATA is the shell folder, which the end-to-end test's scratch
; %LOCALAPPDATA% does not move.
!macro SteptixUserRoot out
  ReadEnvStr ${out} "LOCALAPPDATA"
  ${If} ${out} == ""
    StrCpy ${out} "$PROFILE\AppData\Local"
  ${EndIf}
  StrCpy ${out} "${out}\steptix"
!macroend

; Tells running programs the environment changed, as the Environment Variables
; dialog does, so terminals started from now on see the new PATH. Not for a
; test's key: nothing reads it.
!macro SteptixPathChanged
  ${If} $PathKey == "Environment"
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
!macroend

!macro SteptixPathHelpers un
  ; A Path entry in the form two entries are compared in: %VARIABLES%
  ; expanded, and surrounding quotes and a trailing backslash dropped. The
  ; callers compare with ==, which ignores case, as Windows paths do.
  Function ${un}NormalizePathEntry
    Exch $0
    Push $1
    ExpandEnvStrings $0 $0
    StrCpy $1 $0 1
    ${If} $1 == '"'
      StrCpy $1 $0 1 -1
      ${If} $1 == '"'
        StrCpy $0 $0 -1 1
      ${EndIf}
    ${EndIf}
    StrCpy $1 $0 1 -1
    ${If} $1 == "\"
      StrCpy $0 $0 -1
    ${EndIf}
    Pop $1
    Exch $0
  FunctionEnd

  ; Walks $PathValue entry by entry. $PathFound is 1 when an entry names
  ; $PathFolder. $PathRest is $PathValue without those entries, with every
  ; other entry, empty ones included, kept as written.
  Function ${un}FindPathEntry
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    Push $PathFolder
    Call ${un}NormalizePathEntry
    Pop $0
    StrCpy $PathFound 0
    StrCpy $PathRest ""
    StrCpy $1 0  ; whether $PathRest holds an entry yet
    StrCpy $2 "" ; the entry being read
    StrLen $3 $PathValue
    StrCpy $4 0  ; the position
    ${Do}
      ${If} $4 < $3
        StrCpy $5 $PathValue 1 $4
      ${Else}
        StrCpy $5 ";" ; the end closes the last entry
      ${EndIf}
      ${If} $5 == ";"
        Push $2
        Call ${un}NormalizePathEntry
        Pop $6
        ${If} $6 == $0
          StrCpy $PathFound 1
        ${ElseIf} $1 == 1
          StrCpy $PathRest "$PathRest;$2"
        ${Else}
          StrCpy $PathRest $2
          StrCpy $1 1
        ${EndIf}
        StrCpy $2 ""
        ${If} $4 >= $3
          ${ExitDo}
        ${EndIf}
      ${Else}
        StrCpy $2 "$2$5"
      ${EndIf}
      IntOp $4 $4 + 1
    ${Loop}
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd
!macroend
!insertmacro SteptixPathHelpers ""
!insertmacro SteptixPathHelpers "un."

; Puts steptix.cmd and run-newest-runtime.cjs in <user root>\bin, then that
; folder at the end of the user's Path, unless an entry already names it.
Function AddSteptixToPath
  !insertmacro SteptixUserRoot $R0
  StrCpy $R1 "$R0\bin"
  SetOutPath "$R1"
  File "${__FILEDIR__}\bin\steptix.cmd"
  File "${__FILEDIR__}\bin\run-newest-runtime.cjs"

  ClearErrors
  ReadRegStr $R2 HKCU "$PathKey" "Path"
  ${If} ${Errors}
    ; No Path value, or one NSIS cannot read: longer than its string limit,
    ; or not a string. Only a missing one may be created. Writing over the
    ; others would destroy the user's PATH.
    StrCpy $R3 0
    ${Do}
      ClearErrors
      EnumRegValue $R4 HKCU "$PathKey" $R3
      ${If} ${Errors}
      ${OrIf} $R4 == ""
        ${ExitDo}
      ${EndIf}
      ${If} $R4 == "Path"
        MessageBox MB_ICONINFORMATION|MB_OK "Steptix was not added to your PATH, because this installer cannot safely change your Path variable (it may be too long).$\r$\n$\r$\nTo add it yourself, add this folder to Path in $\"Edit environment variables for your account$\":$\r$\n$R1" /SD IDOK
        DetailPrint "Not added to PATH: the user Path value could not be read."
        Return
      ${EndIf}
      IntOp $R3 $R3 + 1
    ${Loop}
    StrCpy $R2 ""
  ${EndIf}

  StrCpy $PathValue $R2
  StrCpy $PathFolder $R1
  Call FindPathEntry
  ${If} $PathFound == 1
    DetailPrint "Already on PATH: $R1"
    Return
  ${EndIf}

  ; The new value must fit in an NSIS string, or it would be cut short.
  StrLen $R3 $R2
  StrLen $R4 $R1
  IntOp $R3 $R3 + $R4
  IntOp $R3 $R3 + 1
  ${If} $R3 >= ${NSIS_MAX_STRLEN}
    MessageBox MB_ICONINFORMATION|MB_OK "Steptix was not added to your PATH, because your Path variable is too long for this installer to change safely.$\r$\n$\r$\nTo add it yourself, add this folder to Path in $\"Edit environment variables for your account$\":$\r$\n$R1" /SD IDOK
    DetailPrint "Not added to PATH: the user Path value is too long."
    Return
  ${EndIf}
  StrCpy $R3 $R2 1 -1
  ${If} $R2 == ""
  ${OrIf} $R3 == ";"
    StrCpy $R2 "$R2$R1"
  ${Else}
    StrCpy $R2 "$R2;$R1"
  ${EndIf}
  ClearErrors
  WriteRegExpandStr HKCU "$PathKey" "Path" "$R2"
  ${If} ${Errors}
    MessageBox MB_ICONINFORMATION|MB_OK "Steptix was not added to your PATH: writing your Path variable failed.$\r$\n$\r$\nTo add it yourself, add this folder to Path in $\"Edit environment variables for your account$\":$\r$\n$R1" /SD IDOK
    DetailPrint "Not added to PATH: writing the user Path value failed."
    Return
  ${EndIf}
  !insertmacro SteptixPathChanged
  DetailPrint "Added to PATH: $R1"
FunctionEnd

; Once no runtime is left: removes the two files from <user root>\bin, the
; folder itself if nothing else is in it, and every entry naming it from the
; user's Path. While another runtime remains, the folder still runs it, so it
; stays. A runtime counts if the extension would start it: the same three
; files (runtimeLaunchFiles, steptix-vscode/src/extension/server-manager.ts).
; A macro, so the uninstaller's function and a test harness's share one body.
!macro SteptixRemoveFromPathBody un
  !insertmacro SteptixUserRoot $R0
  StrCpy $R1 "$R0\bin"
  FindFirst $R2 $R3 "$R0\runtimes\*"
  ${DoWhile} $R3 != ""
    ${If} $R3 != "."
    ${AndIf} $R3 != ".."
    ${AndIf} ${FileExists} "$R0\runtimes\$R3\runtime-launcher.cjs"
    ${AndIf} ${FileExists} "$R0\runtimes\$R3\server\dist\index.js"
    ${AndIf} ${FileExists} "$R0\runtimes\$R3\steptix.cmd"
      FindClose $R2
      DetailPrint "Kept on PATH, for runtime $R3: $R1"
      Return
    ${EndIf}
    FindNext $R2 $R3
  ${Loop}
  FindClose $R2

  Delete "$R1\steptix.cmd"
  Delete "$R1\run-newest-runtime.cjs"
  RMDir "$R1"

  ClearErrors
  ReadRegStr $R2 HKCU "$PathKey" "Path"
  ${If} ${Errors}
    DetailPrint "No PATH entry removed: the user Path value is missing or could not be read."
    Return
  ${EndIf}
  StrCpy $PathValue $R2
  StrCpy $PathFolder $R1
  Call ${un}FindPathEntry
  ${If} $PathFound != 1
    Return
  ${EndIf}
  ${If} $PathRest == ""
    DeleteRegValue HKCU "$PathKey" "Path"
  ${Else}
    WriteRegExpandStr HKCU "$PathKey" "Path" "$PathRest"
  ${EndIf}
  !insertmacro SteptixPathChanged
  DetailPrint "Removed from PATH: $R1"
!macroend

Function un.RemoveSteptixFromPath
  !insertmacro SteptixRemoveFromPathBody "un."
FunctionEnd
