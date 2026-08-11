; Catalyst NSIS install hooks.
; The app runs a bundled Node "sidecar" (catalyst-server.exe) that loads native
; modules (node-pty, native-file-dialog). Tauri's installer closes the main app
; window but not the sidecar, so on an upgrade the sidecar keeps those .node
; files locked and extraction fails with "Error opening file for writing".
; Stop both before install/uninstall so files can be overwritten cleanly.

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /T /IM catalyst-server.exe'
  nsExec::Exec 'taskkill /F /T /IM catalyst.exe'
  Sleep 600
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /T /IM catalyst-server.exe'
  nsExec::Exec 'taskkill /F /T /IM catalyst.exe'
  Sleep 600
!macroend
