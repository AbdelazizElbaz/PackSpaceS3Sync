const fs = require("fs")
const os = require("os")
const path = require("path")
const crypto = require("crypto")
const axios = require("axios")
const { spawn } = require("child_process")
const api = require("./api")
const { PLATFORM_OS, pickAsset, isNewerVersion } = require("./updateUtils")

// Applique une mise à jour vers la dernière version publiée — sur demande :
// "je veux gérer la mise à jour de sync" (mise à jour à distance en mode
// service + auto-update en mode session, pilotables depuis le B2B ou la
// fenêtre). Un seul point d'entrée, `applyUpdate()`, utilisé dans les trois
// cas (voir Engine.applyUpdate) :
//   - déclenché depuis la fenêtre (mode session, pas de service installé)
//   - déclenché depuis la fenêtre mais routé en RPC vers le VRAI processus
//     service (mode service, voir controlClient.js)
//   - déclenché à distance par le B2B (commande "update" au heartbeat, voir
//     SyncManager.runCommand) — traité par le processus qui fait tourner
//     l'Engine à ce moment-là, service.js ou main.js selon le mode.
//
// La différence de comportement se fait sur UNE seule variable
// d'environnement : ELECTRON_RUN_AS_NODE=1 signifie "processus headless"
// (voir service.js) → installation SILENCIEUSE puis redémarrage programmé
// (personne n'est là pour cliquer un assistant). Sinon → on ouvre
// l'assistant d'installation normalement et on ferme l'agent pour libérer
// les fichiers, comme n'importe quelle mise à jour manuelle.

const WIN_SERVICE_ID = "packspaces3sync.exe" // doit rester identique à serviceInstaller.js
const LINUX_UNIT = "packspace-s3-sync.service"

// Vrai uniquement pour un service OS installé (Windows/Linux/macOS, voir
// serviceInstaller.js) : celui-ci lance TOUJOURS le binaire Electron de
// l'app avec ELECTRON_RUN_AS_NODE=1 (process.execPath = electron.exe,
// process.versions.electron reste défini même en mode "Node"). Un
// conteneur Docker (image node:20-alpine, voir Dockerfile) tourne en Node
// pur, sans Electron du tout : on ne le confond pas avec un vrai service —
// il n'y a pas d'installeur "silencieux" qui ait un sens pour lui (voir
// isContainer()).
function isRealService() {
  return process.env.ELECTRON_RUN_AS_NODE === "1" && !!process.versions.electron
}

// Node pur sans Electron : conteneur (Docker/Synology). Une mise à jour
// s'y fait en repointant l'image ghcr.io/... vers un nouveau tag, pas en
// remplaçant des fichiers dans le conteneur — on refuse proprement plutôt
// que de spawn un installeur .deb/.exe qui n'a aucun sens ici.
function isContainer() {
  return !process.versions.electron
}

async function downloadTo(url, destPath) {
  const res = await axios.get(url, { responseType: "stream", timeout: 180000 })
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(destPath)
    let settled = false
    const done = (err) => {
      if (settled) return
      settled = true
      err ? reject(err) : resolve()
    }
    res.data.on("error", done)
    w.on("error", done)
    w.on("finish", () => done())
    res.data.pipe(w)
  })
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, ...opts })
    child.on("error", reject)
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} : code ${code}`))))
  })
}

// Détaché : redémarre le service APRÈS que notre propre processus ait
// quitté. L'installeur ne peut pas remplacer un exécutable encore en cours
// d'utilisation (Windows en particulier verrouille le fichier) : on
// s'arrête d'abord (process.exit juste après l'appel), et ce processus
// indépendant relance le service quelques secondes plus tard.
function scheduleRestart(delaySec = 6) {
  try {
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", `timeout /t ${delaySec} >nul & sc start "${WIN_SERVICE_ID}"`], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref()
    } else if (process.platform === "linux") {
      spawn("sh", ["-c", `sleep ${delaySec} && systemctl restart ${LINUX_UNIT}`], {
        detached: true,
        stdio: "ignore",
      }).unref()
    }
    // macOS : le LaunchDaemon a KeepAlive=true, launchd relance seul dès
    // que le process quitte — mais on ne l'atteint pas ici (voir plus bas,
    // pas de mise à jour automatisée sur macOS en mode service).
  } catch {
    /* best effort : au pire un redémarrage manuel du service suffit */
  }
}

// Ouvre l'installeur pour que l'utilisateur le termine lui-même (mode
// session, fenêtre ouverte) — jamais silencieux : on ne remplace pas les
// fichiers d'une app en train de tourner sans que quelqu'un valide.
function openInstallerForUser(file) {
  let child
  if (process.platform === "win32") {
    child = spawn(file, [], { detached: true, stdio: "ignore" })
  } else if (process.platform === "darwin") {
    child = spawn("open", [file], { detached: true, stdio: "ignore" })
  } else {
    child = spawn("xdg-open", [file], { detached: true, stdio: "ignore" })
  }
  child.on("error", () => {
    /* pas de handler graphique dispo : le fichier reste téléchargé, voir le message d'erreur renvoyé à l'appelant */
  })
  child.unref()
}

async function applyUpdate({ log = () => {} } = {}) {
  if (isContainer()) {
    // Docker/Synology : pas de fichiers d'installeur à remplacer dans le
    // conteneur, la mise à jour se fait en changeant le tag d'image (voir
    // README « Synology / Docker »). On le dit clairement plutôt que de
    // spawn un .deb qui ne s'exécuterait pas.
    throw new Error("Mise à jour automatique non disponible en conteneur : mettez à jour l'image Docker (nouveau tag) puis recréez le conteneur.")
  }
  const rel = await api.fetchLatestRelease()
  if (!rel?.available || !rel.version) throw new Error("Aucune version publiée.")
  if (!isNewerVersion(rel.version, api.APP_VERSION)) {
    return { applied: false, reason: "Déjà à jour.", version: api.APP_VERSION }
  }
  const platformOs = PLATFORM_OS[process.platform]
  const asset = pickAsset(rel.assets, platformOs)
  if (!asset) throw new Error(`Aucun installeur publié pour cette plateforme (${process.platform}).`)

  const tmpFile = path.join(os.tmpdir(), `packspace-s3-sync-update-${crypto.randomBytes(4).toString("hex")}-${asset.name}`)
  log("info", `Mise à jour : téléchargement de la version ${rel.version} (${asset.name})…`)
  await downloadTo(asset.url, tmpFile)
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(tmpFile, 0o755)
    } catch {
      /* ignore */
    }
  }

  if (isRealService()) {
    // Mode service : personne pour cliquer un assistant → silencieux puis
    // redémarrage programmé (voir scheduleRestart).
    if (process.platform === "win32") {
      log("info", "Mise à jour : installation silencieuse (/S)…")
      await run(tmpFile, ["/S"])
    } else if (process.platform === "linux") {
      if (asset.kind !== "deb" || !(typeof process.getuid === "function" && process.getuid() === 0)) {
        throw new Error("Mise à jour automatique indisponible : paquet .deb requis, exécuté en root (service systemd).")
      }
      log("info", "Mise à jour : installation du paquet .deb…")
      await run("dpkg", ["-i", tmpFile])
    } else {
      throw new Error("Mise à jour automatique non disponible sur macOS en mode service : réinstallez le .dmg manuellement sur ce poste.")
    }
    scheduleRestart()
    log("info", `Mise à jour ${rel.version} installée — redémarrage du service dans quelques secondes.`)
    setTimeout(() => process.exit(0), 1500)
    return { applied: true, version: rel.version, restarting: true }
  }

  // Mode session (fenêtre ouverte, pas de service) : assistant visible,
  // puis on ferme l'agent pour libérer les fichiers qu'il remplace.
  log("info", "Mise à jour : lancement de l'assistant d'installation…")
  openInstallerForUser(tmpFile)
  setTimeout(() => process.exit(0), 800)
  return { applied: true, version: rel.version, restarting: false }
}

module.exports = { applyUpdate, isRealService, isContainer }
