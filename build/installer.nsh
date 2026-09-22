; Hooks NSIS electron-builder (build.nsis.include).
;
; ---------------------------------------------------------------------------
; Contrôle de version à l'ouverture d'un installeur quelconque (sur demande :
; "si on veut installer une version quelconque, on doit pouvoir dire qu'il y
; a une version installée si c'est plus récent, sinon on doit lancer un
; update"). Lu dans le registre Windows (DisplayVersion écrit par
; electron-builder, HKCU puis HKLM) :
;   - installée > cet installeur  → message "version plus récente déjà
;     installée" et arrêt (jamais de rétrogradation ; en silencieux /S :
;     arrêt sans fenêtre, code 3) ;
;   - installée = cet installeur  → proposer de réinstaller (Oui/Non) ;
;   - installée < cet installeur  → mise à jour en place, silencieuse pour
;     l'utilisateur (config et service conservés, voir customUnInstall).
; ---------------------------------------------------------------------------
!include "WordFunc.nsh"

!macro customInit
  ; Déclarée ICI (et pas au niveau global) : le désinstalleur est compilé
  ; avec le même script mais sans customInit → une variable globale non
  ; utilisée y déclencherait "warning 6001 … treated as error".
  Var /GLOBAL PS_InstalledVersion
  StrCpy $PS_InstalledVersion ""
  ReadRegStr $PS_InstalledVersion HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${if} $PS_InstalledVersion == ""
    ReadRegStr $PS_InstalledVersion HKLM "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${endif}

  ${if} $PS_InstalledVersion != ""
    ${VersionCompare} "$PS_InstalledVersion" "${VERSION}" $0
    ; $0 : 0 = égales, 1 = installée plus récente, 2 = cet installeur plus récent
    ${if} $0 == 1
      ${ifNot} ${Silent}
        MessageBox MB_OK|MB_ICONEXCLAMATION "Une version plus récente de ${PRODUCT_NAME} (v$PS_InstalledVersion) est déjà installée sur ce poste.$\r$\n$\r$\nCet installeur (v${VERSION}) ne sera pas appliqué. Utilisez la mise à jour depuis l'application ou désinstallez d'abord la version actuelle."
      ${endif}
      SetErrorLevel 3
      Quit
    ${elseif} $0 == 0
      ${ifNot} ${Silent}
        MessageBox MB_YESNO|MB_ICONQUESTION "${PRODUCT_NAME} v${VERSION} est déjà installé sur ce poste.$\r$\n$\r$\nVoulez-vous le réinstaller (votre connexion et vos réglages sont conservés) ?" IDYES +2
        Quit
      ${endif}
    ${else}
      ${ifNot} ${Silent}
        MessageBox MB_OK|MB_ICONINFORMATION "${PRODUCT_NAME} v$PS_InstalledVersion est installé : mise à jour vers v${VERSION}.$\r$\n$\r$\nVotre connexion, vos instances et vos fichiers déjà synchronisés sont conservés."
      ${endif}
    ${endif}
  ${endif}
!macroend

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
