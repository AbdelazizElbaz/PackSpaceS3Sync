const fs = require("fs")
const os = require("os")
const path = require("path")
const crypto = require("crypto")
const { execFile, spawn } = require("child_process")
const store = require("./store")
const Engine = require("./engine")

// Installation / désinstallation du MODE SERVICE (l'agent tourne sans
// session ouverte) — appelé depuis la fenêtre Electron (Réglages → Mode
// service). Sur demande : "l'agent doit marcher même si la session est
// fermée, en mode service".
//
//   Windows : service Windows (wrapper WinSW via node-windows), compte
//             Système local, démarrage automatique, redémarrage si plantage.
//             Élévation UAC demandée à l'installation.
//   Linux   : unité systemd système (/etc/systemd/system/packspace-s3-sync
//             .service), Restart=always. Élévation via pkexec. Nécessite le
//             paquet .deb (une AppImage n'a pas de chemin stable).
//   macOS   : LaunchDaemon (/Library/LaunchDaemons/ma.packspace.s3sync
//             .plist), KeepAlive. Élévation via osascript.
//
// Dans les trois cas le service lance le binaire de l'application avec
// ELECTRON_RUN_AS_NODE=1 (Electron devient un simple Node) sur
// src/service.js, et PACKSPACE_SYNC_DATA_DIR pointant sur un dossier
// MACHINE (ProgramData / var/lib / Library) : la config de l'utilisateur
// (jeton API, identifiant du poste, instances, manifestes) y est COPIÉE à
// l'installation pour que le service reprenne exactement là où la fenêtre
// en était (même poste côté B2B, pas de re-téléchargement). À la
// désinstallation, l'opération inverse ramène l'état dans la config
// utilisateur.

const SERVICE_LABEL = "PackSpace S3 Sync"
const SERVICE_DESCRIPTION = "Synchronisation des fichiers d'impression Packspace (S3 → dossiers locaux)"
const WIN_SERVICE_ID = "packspaces3sync.exe" // id généré par node-windows à partir du nom
const LINUX_UNIT = "packspace-s3-sync.service"
const MAC_LABEL = "ma.packspace.s3sync"
const MAC_PLIST = `/Library/LaunchDaemons/${MAC_LABEL}.plist`
const CONFIG_FILE = "packspace-s3-sync-config.json"

// Clés recopiées entre la config utilisateur et la config du service.
const SNAPSHOT_KEYS = [
  "serverUrl",
  "token",
  "userLabel",
  "machineId",
  "agentId",
  "agentLabel",
  "serverSettings",
  "instances",
  "manifests",
  "controlPort",
  "controlToken",
  ...Engine.SETTING_KEYS,
]

function paths() {
  const dataDir = store.defaultServiceDataDir()
  return {
    dataDir,
    configFile: path.join(dataDir, CONFIG_FILE),
    logDir: path.join(dataDir, "logs"),
    execPath: process.execPath,
    script: path.join(__dirname, "service.js"),
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 20000, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code ?? 1 : 0, stdout: String(stdout || ""), stderr: String(stderr || ""), err })
    })
  })
}

function support() {
  if (process.platform === "win32") return { supported: true }
  if (process.platform === "darwin") return { supported: true }
  if (process.platform === "linux") {
    if (process.env.APPIMAGE) {
      return {
        supported: false,
        reason: "Mode service indisponible avec l'AppImage : installez le paquet .deb (chemin d'installation stable).",
      }
    }
    if (!fs.existsSync("/run/systemd/system")) {
      return { supported: false, reason: "Mode service : systemd requis." }
    }
    return { supported: true }
  }
  return { supported: false, reason: `Plateforme non gérée : ${process.platform}` }
}

// ---------- état ----------

async function status() {
  const p = paths()
  const sup = support()
  const out = {
    platform: process.platform,
    supported: sup.supported,
    reason: sup.reason || null,
    installed: false,
    running: false,
    dataDir: p.dataDir,
    mode: store.get("mode") || "session",
  }
  if (!sup.supported) return out
  if (process.platform === "win32") {
    const r = await run("sc.exe", ["query", WIN_SERVICE_ID])
    out.installed = r.code === 0
    out.running = /STATE\s*:\s*\d+\s+RUNNING/i.test(r.stdout)
  } else if (process.platform === "linux") {
    const en = await run("systemctl", ["is-enabled", LINUX_UNIT])
    out.installed = !/not-found/i.test(en.stdout + en.stderr) && fs.existsSync(`/etc/systemd/system/${LINUX_UNIT}`)
    const ac = await run("systemctl", ["is-active", LINUX_UNIT])
    out.running = ac.stdout.trim() === "active"
  } else if (process.platform === "darwin") {
    out.installed = fs.existsSync(MAC_PLIST)
    const r = await run("launchctl", ["print", `system/${MAC_LABEL}`])
    out.running = r.code === 0 && /state = running/i.test(r.stdout)
  }
  return out
}

// ---------- snapshot de config ----------

function ensureControlToken() {
  if (!store.get("controlToken")) store.set("controlToken", crypto.randomBytes(24).toString("hex"))
  if (!store.get("controlPort")) store.set("controlPort", 47831)
}

function exportSnapshot() {
  ensureControlToken()
  const out = {}
  for (const k of SNAPSHOT_KEYS) {
    const v = store.get(k)
    if (v !== undefined) out[k] = v
  }
  out.mode = "session" // sans objet côté service
  return out
}

function importSnapshot(obj) {
  if (!obj || typeof obj !== "object") return false
  for (const k of ["serverUrl", "token", "userLabel", "machineId", "agentId", "agentLabel", "serverSettings", "instances", "manifests"]) {
    if (obj[k] !== undefined) store.set(k, obj[k])
  }
  return true
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

// ---------- scripts élevés (Linux / macOS) ----------

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

function runElevated(script) {
  const file = path.join(os.tmpdir(), `packspace-s3-sync-${crypto.randomBytes(6).toString("hex")}.sh`)
  fs.writeFileSync(file, script, { mode: 0o700 })
  let cmd
  let args
  if (process.platform === "darwin") {
    cmd = "osascript"
    args = ["-e", `do shell script "sh ${file.replace(/"/g, '\\"')}" with administrator privileges`]
  } else {
    cmd = "pkexec"
    args = ["sh", file]
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (err += d))
    child.on("error", (e) => {
      fs.rmSync(file, { force: true })
      reject(new Error(`Élévation impossible (${cmd}) : ${e.message}`))
    })
    child.on("close", (code) => {
      fs.rmSync(file, { force: true })
      if (code === 0) return resolve(out)
      if (code === 126 || code === 127 || /User canceled|-128/i.test(err)) {
        return reject(new Error("Élévation refusée ou annulée."))
      }
      reject(new Error((err || out || `Échec (code ${code})`).trim().split("\n").slice(-3).join(" ")))
    })
  })
}

function linuxUnit(p) {
  return `[Unit]
Description=${SERVICE_LABEL} — ${SERVICE_DESCRIPTION}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment="ELECTRON_RUN_AS_NODE=1"
Environment="PACKSPACE_SYNC_DATA_DIR=${p.dataDir}"
WorkingDirectory=${p.dataDir}
ExecStart="${p.execPath}" "${p.script}"
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
`
}

function macPlist(p) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(p.execPath)}</string><string>${esc(p.script)}</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key><string>1</string>
    <key>PACKSPACE_SYNC_DATA_DIR</key><string>${esc(p.dataDir)}</string>
  </dict>
  <key>WorkingDirectory</key><string>${esc(p.dataDir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${esc(path.join(p.logDir, "stdout.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(p.logDir, "stderr.log"))}</string>
</dict>
</plist>
`
}

// ---------- Windows (node-windows / WinSW) ----------

function winService(p) {
  const { Service } = require("node-windows")
  return new Service({
    name: SERVICE_LABEL,
    description: SERVICE_DESCRIPTION,
    script: p.script,
    execPath: p.execPath,
    nodeOptions: "--max-old-space-size=512",
    env: [
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      { name: "PACKSPACE_SYNC_DATA_DIR", value: p.dataDir },
    ],
    workingDirectory: p.dataDir,
    logpath: p.logDir,
    maxRestarts: 20,
    stopparentfirst: true,
    stoptimeout: 20,
  })
}

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} : délai dépassé (${Math.round(ms / 1000)} s)`)), ms)
    }),
  ])
}

async function winRestrictAcl(dir) {
  // Le dossier est créé par l'utilisateur dans ProgramData : par défaut
  // tout utilisateur local pourrait y lire le jeton API. On restreint à
  // Système, Administrateurs et l'utilisateur courant (aucune élévation
  // nécessaire : on est propriétaire du dossier).
  const user = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : null
  const grants = ["*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"]
  if (user) grants.push(`${user}:(OI)(CI)F`)
  await run("icacls.exe", [dir, "/inheritance:r", ...grants.flatMap((g) => ["/grant:r", g])])
}

async function installWindows(p) {
  fs.mkdirSync(p.logDir, { recursive: true })
  fs.writeFileSync(p.configFile, JSON.stringify(exportSnapshot(), null, 2))
  await winRestrictAcl(p.dataDir)
  const svc = winService(p)
  await withTimeout(
    new Promise((resolve, reject) => {
      svc.on("error", (e) => reject(new Error(`Service Windows : ${e?.message || e}`)))
      svc.on("invalidinstallation", () => reject(new Error("Installation précédente incomplète : désinstallez puis réessayez.")))
      svc.on("alreadyinstalled", () => svc.start())
      svc.on("install", () => svc.start())
      svc.on("start", () => resolve())
      svc.install(p.dataDir)
    }),
    120000,
    "Installation du service"
  )
}

async function uninstallWindows(p) {
  const svc = winService(p)
  svc.directory(p.dataDir)
  await withTimeout(
    new Promise((resolve, reject) => {
      svc.on("error", (e) => reject(new Error(`Service Windows : ${e?.message || e}`)))
      svc.on("alreadyuninstalled", () => resolve())
      svc.on("uninstall", () => resolve())
      svc.uninstall()
    }),
    120000,
    "Désinstallation du service"
  )
  importSnapshot(readJsonSafe(p.configFile))
}

// ---------- Linux / macOS ----------

async function installUnix(p) {
  const tmp = path.join(os.tmpdir(), `packspace-s3-sync-config-${crypto.randomBytes(6).toString("hex")}.json`)
  fs.writeFileSync(tmp, JSON.stringify(exportSnapshot(), null, 2), { mode: 0o600 })
  const common = `set -e
mkdir -p ${shq(p.logDir)}
cp ${shq(tmp)} ${shq(p.configFile)}
rm -f ${shq(tmp)}
chown -R root ${shq(p.dataDir)}
chmod 700 ${shq(p.dataDir)}
chmod 600 ${shq(p.configFile)}
`
  let script
  if (process.platform === "linux") {
    script = `${common}
cat > /etc/systemd/system/${LINUX_UNIT} <<'UNIT_EOF'
${linuxUnit(p)}UNIT_EOF
systemctl daemon-reload
systemctl enable ${LINUX_UNIT}
systemctl restart ${LINUX_UNIT}
`
  } else {
    script = `${common}
cat > ${shq(MAC_PLIST)} <<'PLIST_EOF'
${macPlist(p)}PLIST_EOF
chown root:wheel ${shq(MAC_PLIST)}
chmod 644 ${shq(MAC_PLIST)}
launchctl bootout system/${MAC_LABEL} >/dev/null 2>&1 || true
launchctl bootstrap system ${shq(MAC_PLIST)}
`
  }
  try {
    await runElevated(script)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

async function uninstallUnix(p) {
  const back = path.join(os.tmpdir(), `packspace-s3-sync-back-${crypto.randomBytes(6).toString("hex")}.json`)
  const uid = typeof process.getuid === "function" ? process.getuid() : null
  const copyBack = `if [ -f ${shq(p.configFile)} ]; then cp ${shq(p.configFile)} ${shq(back)}; ${
    uid !== null ? `chown ${uid} ${shq(back)};` : ""
  } chmod 600 ${shq(back)}; fi`
  let script
  if (process.platform === "linux") {
    script = `set -e
systemctl disable --now ${LINUX_UNIT} >/dev/null 2>&1 || true
rm -f /etc/systemd/system/${LINUX_UNIT}
systemctl daemon-reload
${copyBack}
`
  } else {
    script = `set -e
launchctl bootout system/${MAC_LABEL} >/dev/null 2>&1 || true
rm -f ${shq(MAC_PLIST)}
${copyBack}
`
  }
  await runElevated(script)
  try {
    importSnapshot(readJsonSafe(back))
  } finally {
    fs.rmSync(back, { force: true })
  }
}

// ---------- API ----------

async function install() {
  const sup = support()
  if (!sup.supported) throw new Error(sup.reason)
  const p = paths()
  if (process.platform === "win32") await installWindows(p)
  else await installUnix(p)
  store.set("mode", "service")
  return status()
}

async function uninstall() {
  const p = paths()
  if (process.platform === "win32") await uninstallWindows(p)
  else await uninstallUnix(p)
  store.set("mode", "session")
  return status()
}

module.exports = { status, install, uninstall, paths, support, exportSnapshot, importSnapshot, SERVICE_LABEL }
