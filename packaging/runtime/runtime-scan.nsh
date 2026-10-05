; What installing or uninstalling would disturb, and the older runtimes an
; install replaces (README.md, "Upgrades"), asked of runtime-scan.ps1.
; Included by runtime.nsi after user-path.nsh, since it defines functions and
; uses SteptixUserRoot.
;
; A runtime folder must not change under a running Steptix: Node does not lock
; the files it has loaded, so the server does not stop the change. It breaks
; later instead, the next time it loads a file. So an install or uninstall
; that would change a folder Steptix runs from waits until it is stopped.

!include "LogicLib.nsh"
!include "FileFunc.nsh"

; The exit code of an install or uninstall refused because Steptix is running
; from a runtime folder it would change.
!define EXIT_STEPTIX_RUNNING 3

; SteptixScan's answer: whether the scan ran and finished, and what is
; running, one line per folder ("" when nothing is).
Var ScanOk
Var ScanRunning
; Set when a scan could not answer. The install then goes ahead, as before
; this check existed, but removes nothing it could not check.
Var ScanFailed

; Strips trailing spaces, tabs, CRs and LFs from var, in place. Uses $9.
!macro SteptixTrimEnd var
  ${Do}
    StrCpy $9 ${var} 1 -1
    ${If} $9 == " "
    ${OrIf} $9 == "$\t"
    ${OrIf} $9 == "$\r"
    ${OrIf} $9 == "$\n"
      StrCpy ${var} ${var} -1
    ${Else}
      ${ExitDo}
    ${EndIf}
  ${Loop}
!macroend

; Runs the scan script with args, by Windows PowerShell's full path so nothing
; on PATH chooses it. Sets $ScanOk and $ScanRunning. Uses $0, $1 and $9.
!macro SteptixScan script args
  nsExec::ExecToStack /TIMEOUT=60000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}" ${args}'
  Pop $0
  Pop $ScanRunning
  StrCpy $ScanOk 0
  !insertmacro SteptixTrimEnd $ScanRunning
  StrCpy $1 $ScanRunning 2 -2
  ${If} $0 == 0
  ${AndIf} $1 S== "ok"
    StrCpy $ScanOk 1
    StrCpy $ScanRunning $ScanRunning -2
    !insertmacro SteptixTrimEnd $ScanRunning
  ${Else}
    StrCpy $ScanFailed 1
    DetailPrint "Could not check whether Steptix is running (exit $0): $ScanRunning"
  ${EndIf}
!macroend

; Waits until nothing this install would change, the folder it installs into
; or an older runtime it removes, has Steptix running from it. Interactive:
; Retry or Cancel. Silent: refuses with EXIT_STEPTIX_RUNNING. A scan that
; cannot answer lets the install go ahead.
Function CheckSteptixNotRunning
  !insertmacro SteptixUserRoot $R0
  ${Do}
    !insertmacro SteptixScan "$PLUGINSDIR\runtime-scan.ps1" '-Mode blocking -RuntimesDir "$R0\runtimes" -Version "${VERSION}" -Folder "$INSTDIR"'
    ${If} $ScanOk != 1
    ${OrIf} $ScanRunning == ""
      ${ExitDo}
    ${EndIf}
    ${If} ${Cmd} `MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Steptix is running from a runtime this install would replace:$\r$\n$\r$\n$ScanRunning$\r$\n$\r$\nStop it, then press Retry. In VS Code, run Steptix: Stop Server, or in a terminal run: steptix stop" /SD IDCANCEL IDCANCEL`
      SetErrorLevel ${EXIT_STEPTIX_RUNNING}
      Quit
    ${EndIf}
  ${Loop}
FunctionEnd

; The same for the uninstaller and its own folder, with the scan script it
; installed there. An uninstaller from before this check has none, and the
; scan's failure lets it go ahead.
Function un.CheckSteptixNotRunning
  ${Do}
    !insertmacro SteptixScan "$INSTDIR\runtime-scan.ps1" '-Mode blocking -Folder "$INSTDIR"'
    ${If} $ScanOk != 1
    ${OrIf} $ScanRunning == ""
      ${ExitDo}
    ${EndIf}
    ${If} ${Cmd} `MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Steptix is running from this runtime:$\r$\n$\r$\n$ScanRunning$\r$\n$\r$\nStop it, then press Retry. In VS Code, run Steptix: Stop Server, or in a terminal run: steptix stop" /SD IDCANCEL IDCANCEL`
      SetErrorLevel ${EXIT_STEPTIX_RUNNING}
      Quit
    ${EndIf}
  ${Loop}
FunctionEnd

; Removes the installed runtimes older than this one, each by its own
; uninstaller, run in place and waited for. That uninstaller takes its
; Installed Apps entry with it, and keeps the PATH folder, since this runtime
; is installed by now. Nothing older is running: CheckSteptixNotRunning saw to
; that, and when it could not tell, nothing is removed.
Function RemoveOlderRuntimes
  ${If} $ScanFailed == 1
    DetailPrint "Older Steptix runtimes were left in place: whether they are running could not be checked."
    Return
  ${EndIf}
  !insertmacro SteptixUserRoot $R0
  !insertmacro SteptixScan "$PLUGINSDIR\runtime-scan.ps1" '-Mode older -RuntimesDir "$R0\runtimes" -Version "${VERSION}" -Out "$PLUGINSDIR\older-runtimes.txt"'
  ${If} $ScanOk != 1
    DetailPrint "Older Steptix runtimes were left in place: they could not be listed."
    Return
  ${EndIf}
  ClearErrors
  FileOpen $R1 "$PLUGINSDIR\older-runtimes.txt" r
  ${If} ${Errors}
    Return
  ${EndIf}
  ${Do}
    ClearErrors
    FileReadUTF16LE $R1 $R2
    ${If} ${Errors}
      ${ExitDo}
    ${EndIf}
    !insertmacro SteptixTrimEnd $R2
    ${If} $R2 == ""
      ${Continue}
    ${EndIf}
    ${GetFileName} "$R2" $R3
    DetailPrint "Removing the older runtime $R3"
    ; _?= runs the uninstaller in place and waits for it. It must come last,
    ; unquoted. The uninstaller cannot remove itself that way, so its file
    ; and the then-empty folder are removed here.
    ClearErrors
    ExecWait '"$R2\Uninstall.exe" /S _?=$R2' $R4
    ${If} ${Errors}
    ${OrIf} $R4 != 0
      DetailPrint "Could not remove the older runtime $R3 (exit $R4)."
    ${Else}
      Delete "$R2\Uninstall.exe"
      RMDir "$R2"
    ${EndIf}
  ${Loop}
  FileClose $R1
FunctionEnd
