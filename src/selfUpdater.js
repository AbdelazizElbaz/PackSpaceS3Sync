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

// Progression de la mise à jour en cours, lue par SyncManager.state()
// (donc visible par la fenêtre en mode session ET en mode service, via
// l'API de contrôle) — sur demande : "pendant la mise à jour on doit
// afficher une fenêtre de progression".
//   { active, phase: 'download'|'install'|'restart'|'error'|'done',
//     percent, received, total, version, message, updatedAt }
let currentProgress = null
let progressListener = null
function setProgress(patch) {
  currentProgress = { ...(currentProgress || {}), ...patch, updatedAt: Date.now() }
  try {
    progressListener?.(currentProgress)
  } catch {
    /* ignore */
  }
}
function getUpdateProgress() {
  return currentProgress
}

async function downloadTo(url, destPath, onProgress = () => {}) {
  const res = await axios.get(url, { responseType: "stream", timeout: 180000 })
  const total = Number(res.headers["content-length"] || 0)
  let received = 0
  let lastTick = 0
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(destPath)
    let settled = false
    const done = (err) => {
      if (settled) return
      settled = true
      err ? reject(err) : resolve()
    }
    res.data.on("data", (chunk) => {
      received += chunk.length
      const now = Date.now()
      if (now - lastTick > 200) {
        lastTick = now
        onProgress({ received, total, percent: total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : null })
      }
    })
    res.data.on("error", done)
    w.on("error", done)
    w.on("finish", () => {
      onProgress({ received, total, percent: 100 })
      done()
    })
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

// Mise à jour EN PLACE et SILENCIEUSE en mode session (sur demande : "la
// mise à jour ne doit pas se faire en désinstallant la version et
// installant la nouvelle, ça doit être silencieux et inclus dans
// l'application"). L'installeur remplace les fichiers du programme dans le
// même dossier et RELANCE l'application tout seul ; la configuration
// (jeton, instances, fichiers déjà synchronisés) est dans le dossier de
// données utilisateur, jamais touché — voir build/installer.nsh.
//   - Windows : installeur NSIS lancé avec /S (silencieux) --updated
//     (pas de signalement de désinstallation, service conservé) et
//     --force-run (relance l'app à la fin).
//   - Linux (.deb) : dpkg -i avec élévation (pkexec) puis relance.
//   - macOS : pas d'installation silencieuse d'un .dmg → on l'ouvre pour
//     que l'utilisateur glisse l'app dans Applications (config conservée).
function installSilentlyForSession(file, asset) {
  let child
  if (process.platform === "win32") {
    child = spawn(file, ["/S", "--updated", "--force-run"], { detached: true, stdio: "ignore", windowsHide: true })
  } else if (process.platform === "darwin") {
    child = spawn("open", [file], { detached: true, stdio: "ignore" })
  } else if (asset?.kind === "deb") {
    const exe = process.execPath.replace(/'/g, "'\\''")
    child = spawn(
      "sh",
      ["-c", `pkexec dpkg -i '${file.replace(/'/g, "'\\''")}' && (nohup '${exe}' >/dev/null 2>&1 &)`],
      { detached: true, stdio: "ignore" }
    )
  } else {
    child = spawn("xdg-open", [file], { detached: true, stdio: "ignore" })
  }
  child.on("error", () => {
    /* pas de handler dispo : le fichier reste téléchargé, voir le message d'erreur renvoyé à l'appelant */
  })
  child.unref()
}

async function applyUpdate({ log = () => {}, onProgress = null } = {}) {
  progressListener = onProgress
  try {
    return await applyUpdateInner({ log })
  } catch (err) {
    setProgress({ active: false, phase: "error", message: err?.message || String(err) })
    throw err
  }
}

async function applyUpdateInner({ log }) {
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
  setProgress({ active: true, phase: "download", percent: 0, received: 0, total: asset.size || 0, version: rel.version, message: null })
  await downloadTo(asset.url, tmpFile, (p) => setProgress({ phase: "download", ...p }))
  setProgress({ phase: "install", percent: 100 })
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
    setProgress({ phase: "restart" })
    setTimeout(() => process.exit(0), 1500)
    return { applied: true, version: rel.version, restarting: true }
  }

  // Mode session (fenêtre ouverte, pas de service) : installation
  // silencieuse en place, puis on ferme l'agent pour libérer les fichiers
  // qu'il remplace — l'installeur le relance à la fin (Windows/Linux).
  log("info", `Mise à jour : installation silencieuse de la version ${rel.version}, l'application va redémarrer…`)
  installSilentlyForSession(tmpFile, asset)
  setProgress({ phase: "restart" })
  setTimeout(() => process.exit(0), 1200)
  return { applied: true, version: rel.version, restarting: process.platform !== "darwin" }
}

module.exports = { applyUpdate, isRealService, isContainer, getUpdateProgress }
