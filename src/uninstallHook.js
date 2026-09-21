// Hook de DÉSINSTALLATION de l'application — sur demande : "lors de la
// désinstallation, marquer la session désinstallée".
//
// Lancé par le désinstalleur, AVANT la suppression des fichiers, en Node pur
// (ELECTRON_RUN_AS_NODE=1, pas de fenêtre) :
//   - Windows : build/installer.nsh (macro customUnInstall de l'uninstaller
//     NSIS)  →  "<install>\PackSpace S3 Sync.exe" resources\app\src\uninstallHook.js
//   - Linux .deb : build/deb/prerm  →  /opt/PackSpace S3 Sync/packspace-s3-sync …
//   - macOS : pas de désinstalleur (glisser l'app à la corbeille) ; on peut le
//     lancer à la main : ELECTRON_RUN_AS_NODE=1 "…/Contents/MacOS/PackSpace S3 Sync" …/uninstallHook.js
//
// Ce qu'il fait, best effort et borné dans le temps (jamais bloquant pour le
// désinstalleur) :
//   1. lit la config de l'agent — celle du service (dossier machine) ET
//      celle de la session utilisateur — et, pour chaque jeton trouvé,
//      appelle POST /desktop/agent/uninstalled : le B2B affiche alors le
//      poste « Désinstallé » (date, notification admin, jeton révoqué) au
//      lieu d'un simple « Hors ligne » ;
//   2. si le mode service est installé, l'arrête et le désinstalle (sinon
//      le gestionnaire de services garderait un service pointant sur un
//      binaire disparu).
// Les dossiers de données (config, manifestes) sont laissés en place : une
// réinstallation retrouve le même poste (machine_id) et ne retélécharge rien.

const fs = require("fs")
const os = require("os")
const path = require("path")

const HARD_TIMEOUT_MS = 25000
const CONFIG_FILE = "packspace-s3-sync-config.json"

const out = (m) => {
  try {
    process.stdout.write(`[uninstall] ${m}\n`)
  } catch {
    /* stdout fermé */
  }
}

function userDataDir() {
  // Même règle qu'Electron pour app.getPath("userData") avec productName.
  const name = "PackSpace S3 Sync"
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), name)
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", name)
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), name)
}

function readConfig(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE), "utf8"))
  } catch {
    return null
  }
}

async function notifyServer(cfg, reason) {
  const api = require("./api")
  const axios = require("axios")
  if (!cfg || !cfg.token || !cfg.serverUrl) return false
  try {
    await axios.post(
      `${api.normalizeServerUrl(cfg.serverUrl)}/desktop/agent/uninstalled`,
      { reason },
      {
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: "application/json",
          "X-Agent-Host": api.HOSTNAME,
          "X-Agent-Id": cfg.machineId || "",
        },
        timeout: 8000,
      }
    )
    out(`poste marqué désinstallé sur ${cfg.serverUrl}`)
    return true
  } catch (err) {
    out(`API injoignable ou jeton déjà révoqué (${err?.response?.status || err?.code || err?.message})`)
    return false
  }
}

async function run() {
  const store = require("./store") // dossier courant (env ou machine)
  const dirs = [store.dataDir, store.defaultServiceDataDir(), userDataDir()]
  const seen = new Set()
  let notified = false
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    const cfg = readConfig(dir)
    if (!cfg) continue
    out(`config trouvée : ${dir}`)
    if (await notifyServer(cfg, "app_uninstalled")) notified = true
  }
  if (!notified) out("aucun jeton valide : rien à signaler au serveur")

  // Service installé ? On le retire pour ne pas laisser un service orphelin.
  try {
    const serviceInstaller = require("./serviceInstaller")
    const st = await serviceInstaller.status()
    if (st.supported && st.installed) {
      out("service installé : arrêt et désinstallation")
      await serviceInstaller.uninstall()
      out("service désinstallé")
    }
  } catch (err) {
    out(`désinstallation du service impossible : ${err?.message || err}`)
  }
}

const timer = setTimeout(() => {
  out("délai dépassé, on n'attend plus")
  process.exit(0)
}, HARD_TIMEOUT_MS)

run()
  .catch((err) => out(`erreur : ${err?.stack || err}`))
  .finally(() => {
    clearTimeout(timer)
    process.exit(0)
  })
