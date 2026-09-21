; Hooks NSIS electron-builder (build.nsis.include).
;
; À la désinstallation : prévient l'API Packspace que ce poste est
; désinstallé (le B2B affiche la session « Désinstallée ») et retire le
; service Windows s'il avait été installé — voir src/uninstallHook.js.
; Exécuté AVANT la suppression des fichiers, avec le binaire de l'app en
; mode Node (ELECTRON_RUN_AS_NODE=1, sans fenêtre). Best effort : le hook
; se termine seul en moins de 30 s, quoi qu'il arrive.
!macro customUnInstall
  DetailPrint "Packspace : signalement de la désinstallation…"
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1") i.r0'
  ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\app\src\uninstallHook.js"' $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", i 0) i.r0'
  DetailPrint "Packspace : hook terminé (code $0)"
!macroend
