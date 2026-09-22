const Conf = require("conf")
const os = require("os")
const path = require("path")

// Config persistée sur le poste (fichier JSON `packspace-s3-sync-config.json`).
//
// Le dossier de données dépend du MODE d'exécution :
//   - mode session (fenêtre Electron lancée par l'utilisateur) : dossier de
//     données utilisateur d'Electron (%APPDATA%\PackSpace S3 Sync, …)
//   - mode service (src/service.js lancé par le gestionnaire de services,
//     sans session ouverte) : dossier machine passé par la variable
//     d'environnement PACKSPACE_SYNC_DATA_DIR (posée par l'installateur,
//     voir serviceInstaller.js), sinon un dossier machine par défaut.
// On utilise `conf` (la lib sous electron-store) directement parce que
// electron-store exige `electron.app`, absent quand le service tourne
// en Node pur (ELECTRON_RUN_AS_NODE=1).
//
// serverUrl        : base de l'API Packspace (ex: https://api.om.packspace.ma/api)
// token            : token Sanctum 'desktop-agent' (1 an, voir
//                    DesktopFilesController::agentToken côté API2) — jamais
//                    le mot de passe.
// pollIntervalMs   : fréquence d'interrogation des dossiers S3
// maxParallelFiles : nombre de fichiers téléchargés EN MÊME TEMPS (= nombre
//                    de worker threads dans le pool, voir syncManager.js)
// maxParallelChunks: nombre de morceaux (requêtes Range) en parallèle PAR
//                    fichier, à l'intérieur d'un worker
// chunkSizeMb      : taille d'un morceau
// chunkThresholdMb : en dessous de cette taille, un fichier est téléchargé
//                    en un seul flux (pas de découpage)
// maxRetries       : tentatives par fichier avant de le marquer en échec
// mode             : "session" | "service" — côté GUI : faut-il piloter le
//                    service installé plutôt que faire tourner le moteur
//                    dans le processus Electron ?
// controlPort/Token: API de contrôle locale du service (127.0.0.1) ; le
//                    jeton est partagé entre la config GUI et celle du
//                    service au moment de l'installation.
const cpuCount = Math.max(1, os.cpus()?.length || 2)

function defaultServiceDataDir() {
  if (process.platform === "win32") {
    return path.join(process.env.ProgramData || "C:\\ProgramData", "PackSpace S3 Sync")
  }
  if (process.platform === "darwin") return "/Library/Application Support/PackSpace S3 Sync"
  return "/var/lib/packspace-s3-sync"
}

function resolveDataDir() {
  if (process.env.PACKSPACE_SYNC_DATA_DIR) return path.resolve(process.env.PACKSPACE_SYNC_DATA_DIR)
  if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
    try {
      const { app } = require("electron")
      if (app && typeof app.getPath === "function") return app.getPath("userData")
    } catch {
      /* pas dans Electron */
    }
  }
  return defaultServiceDataDir()
}

const dataDir = resolveDataDir()

const store = new Conf({
  cwd: dataDir,
  configName: "packspace-s3-sync-config",
  defaults: {
    serverUrl: "",
    token: "",
    userLabel: "",
    downloadDir: "",
    pollIntervalMs: 5000,
    maxParallelFiles: Math.min(4, cpuCount),
    maxParallelChunks: 4,
    chunkSizeMb: 8,
    chunkThresholdMb: 16,
    maxRetries: 3,
    // Minutes avant remise en file automatique des fichiers en échec
    // définitif (0 = jamais, retry manuel seulement).
    failedRetryDelayMin: 15,
    // 1 = installe seul les nouvelles versions (réglage partagé B2B/agent)
    autoUpdate: 0,
    autoLaunch: true,
    // Instances de synchronisation : [{ id, name, prefix, localDir, enabled }]
    // (voir syncManager.js) + manifestes { instanceId: { s3Key: {size, etag, at} } }
    instances: [],
    manifests: {},
    // Pilotage serveur (DesktopSyncController) : id du poste côté API2,
    // libellé choisi dans le B2B, et cache des réglages serveur.
    agentId: null,
    agentLabel: "",
    machineId: "", // UUID du poste, généré au premier lancement (voir api.js)
    serverSettings: {},
    // Mode service (voir en-tête)
    mode: "session",
    controlPort: 47831,
    controlToken: "",
  },
})

store.dataDir = dataDir
store.defaultServiceDataDir = defaultServiceDataDir

module.exports = store
