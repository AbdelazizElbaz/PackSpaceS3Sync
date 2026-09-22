; Hooks NSIS electron-builder (build.nsis.include).
;
; À la désinstallation : prévient l'API Packspace que ce poste est
; désinstallé (le B2B affiche la session « Désinstallée ») et retire le
; service Windows s'il avait été installé — voir src/uninstallHook.js.
; Exécuté AVANT la suppression des fichiers, avec le binaire de l'app en
; mode Node (ELECTRON_RUN_AS_NODE=1, sans fenêtre). Best effort : le hook
; se termine seul en moins de 30 s, quoi qu'il arrive.
; IMPORTANT : lors d'une MISE À JOUR (installeur lancé avec /S par
; selfUpdater.js, ou nouvelle version installée par-dessus l'ancienne),
; electron-builder exécute d'abord l'ancien désinstalleur avec le drapeau
; --updated (${isUpdated}). Dans ce cas on NE signale PAS de
; désinstallation et on NE retire PAS le service : la config (jeton,
; instances, manifestes) est dans AppData/ProgramData et n'est jamais
; touchée (/KEEP_APP_DATA) — sur demande : "on ne doit pas perdre les
; credentials déjà sauvegardés".
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DetailPrint "Packspace : signalement de la désinstallation…"
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1") i.r0'
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\app\src\uninstallHook.js"' $0
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", i 0) i.r0'
    DetailPrint "Packspace : hook terminé (code $0)"
  ${else}
    DetailPrint "Packspace : mise à jour en place, configuration et service conservés"
  ${endIf}
!macroend
