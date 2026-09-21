const Store = require("electron-store")
const os = require("os")

// Config persistée sur le poste (fichier JSON dans le dossier de données
// de l'app, par OS — voir electron-store).
//
// serverUrl        : base de l'API Packspace (ex: https://api.om.packspace.ma/api)
// token            : token Sanctum 'desktop-agent' (1 an, voir
//                    DesktopFilesController::agentToken côté API2) — jamais
//                    le mot de passe.
// downloadDir      : dossier local où déposer les fichiers synchronisés
// pollIntervalMs   : fréquence d'interrogation de /desktop/print-files
// maxParallelFiles : nombre de fichiers téléchargés EN MÊME TEMPS (= nombre
//                    de worker threads dans le pool, voir syncManager.js)
// maxParallelChunks: nombre de morceaux (requêtes Range) en parallèle PAR
//                    fichier, à l'intérieur d'un worker
// chunkSizeMb      : taille d'un morceau
// chunkThresholdMb : en dessous de cette taille, un fichier est téléchargé
//                    en un seul flux (pas de découpage)
// maxRetries       : tentatives par fichier avant de le marquer en échec
const cpuCount = Math.max(1, os.cpus()?.length || 2)

const store = new Store({
  name: "packspace-s3-sync-config",
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
    autoLaunch: true,
    // Instances de synchronisation : [{ id, name, prefix, localDir, enabled }]
    // (voir syncManager.js) + manifestes { instanceId: { s3Key: {size, etag, at} } }
    instances: [],
    manifests: {},
    // Pilotage serveur (DesktopSyncController) : id du poste côté API2,
    // libellé choisi dans le B2B, et cache des réglages serveur.
    agentId: null,
    agentLabel: "",
    serverSettings: {},
  },
})

module.exports = store
