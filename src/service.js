// Point d'entrée du MODE SERVICE : l'agent tourne sans fenêtre et sans
// session utilisateur ouverte (service Windows / unité systemd / LaunchDaemon
// macOS), lancé par le gestionnaire de services avec :
//   ELECTRON_RUN_AS_NODE=1        → le binaire Electron se comporte comme Node
//   PACKSPACE_SYNC_DATA_DIR=<dir> → config + manifestes dans un dossier machine
// (voir serviceInstaller.js pour l'installation). Sur demande : "l'agent
// doit marcher même si la session est fermée, en mode service".
//
// La fenêtre Electron (main.js) le pilote via l'API de contrôle locale
// (controlServer.js) ; le B2B Packspace le pilote comme n'importe quel
// agent via DesktopSyncController (heartbeat / commandes / config).

const fs = require("fs")
const path = require("path")
const crypto = require("crypto")
const store = require("./store")
const api = require("./api")
const Engine = require("./engine")
const { startControlServer } = require("./controlServer")

process.title = "packspace-s3-sync-service"

// ---------- journal (fichier, rotation simple) ----------
const LOG_DIR = path.join(store.dataDir, "logs")
const LOG_FILE = path.join(LOG_DIR, "service.log")
const LOG_MAX = 5 * 1024 * 1024

function log(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}\n`
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX) fs.renameSync(LOG_FILE, LOG_FILE + ".1")
    } catch {
      /* pas encore de fichier */
    }
    fs.appendFileSync(LOG_FILE, line)
  } catch {
    /* disque en lecture seule : on garde la sortie standard */
  }
  if (stdoutOk) {
    try {
      process.stdout.write(line)
    } catch {
      stdoutOk = false
    }
  }
}
// Sortie standard fermée (lanceur parti) : on n'écrit plus que dans le
// fichier, sinon chaque EPIPE relancerait une erreur → boucle infinie.
let stdoutOk = true
process.stdout.on("error", () => {
  stdoutOk = false
})

process.on("uncaughtException", (err) => {
  if (err?.code === "EPIPE") {
    stdoutOk = false
    return
  }
  log("error", `uncaughtException: ${err?.stack || err}`)
})
process.on("unhandledRejection", (err) => log("error", `unhandledRejection: ${err?.stack || err}`))

async function main() {
  fs.mkdirSync(store.dataDir, { recursive: true })
  // Variables d'environnement du mode CONTENEUR (Docker / Synology, voir
  // Dockerfile) : CONTROL_TOKEN impose le jeton (sinon celui de la config),
  // CONTROL_BIND=0.0.0.0 expose l'API/l'interface web hors du conteneur,
  // SERVE_UI=1 sert l'interface de la fenêtre en pages web.
  if (process.env.CONTROL_TOKEN) store.set("controlToken", process.env.CONTROL_TOKEN.trim())
  if (process.env.CONTROL_PORT) store.set("controlPort", Number(process.env.CONTROL_PORT) || 47831)
  if (!store.get("controlToken")) {
    // Normalement posé par l'installateur (partagé avec la config GUI) ;
    // sinon on en génère un, à recopier dans la config de la fenêtre.
    store.set("controlToken", crypto.randomBytes(24).toString("hex"))
    log("warn", "Aucun jeton de contrôle : un nouveau a été généré dans la config du service")
  }
  log(
    "info",
    `Démarrage service v${api.APP_VERSION} (pid ${process.pid}, ${api.HOSTNAME}, données : ${store.dataDir}, connecté : ${
      store.get("token") ? "oui" : "non"
    })`
  )

  const bind = process.env.CONTROL_BIND || "127.0.0.1"
  const serveUi = ["1", "true", "yes"].includes(String(process.env.SERVE_UI || "").toLowerCase())
  if (bind !== "127.0.0.1" && !process.env.CONTROL_TOKEN) {
    log("warn", `API exposée sur ${bind} avec le jeton de la config : ${store.get("controlToken")} (définissez CONTROL_TOKEN)`)
  }

  const engine = new Engine({ log })
  const server = await startControlServer(engine, {
    port: Number(store.get("controlPort")) || 47831,
    token: store.get("controlToken"),
    version: api.APP_VERSION,
    hostname: api.HOSTNAME,
    bind,
    serveUi,
    uiDir: path.join(__dirname, "..", "renderer"),
    log,
  })
  engine.start()

  let stopping = false
  const shutdown = async (signal) => {
    if (stopping) return
    stopping = true
    log("info", `Arrêt (${signal}) : fermeture propre des téléchargements`)
    try {
      await Promise.race([
        engine.stop().then(() => api.agentOffline()),
        new Promise((r) => setTimeout(r, 5000)),
      ])
    } catch {
      /* best effort */
    }
    server.close()
    log("info", "Service arrêté")
    process.exit(0)
  }
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => shutdown(sig))
  }
  // Wrapper node-windows : demande d'arrêt envoyée par message IPC.
  process.on("message", (m) => {
    if (m === "shutdown" || m?.type === "shutdown") shutdown("message")
  })
}

main().catch((err) => {
  log("error", `Démarrage impossible : ${err?.stack || err}`)
  process.exit(1)
})
