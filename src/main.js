const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell, Notification } = require("electron")
const path = require("path")
const AutoLaunch = require("auto-launch")
const store = require("./store")
const api = require("./api")
const Engine = require("./engine")
const ControlClient = require("./controlClient")
const serviceInstaller = require("./serviceInstaller")

// Processus Electron = fenêtre + icône de zone de notification. Le moteur
// de synchro (Engine) tourne :
//   - mode "session" : ICI, dans ce processus (LocalBackend) — l'agent
//     s'arrête quand l'utilisateur ferme sa session ;
//   - mode "service" : dans un SERVICE de l'OS (src/service.js, installé
//     depuis Réglages → Mode service) qui continue sans session ouverte ;
//     la fenêtre n'est alors qu'un client de son API de contrôle locale
//     (ServiceBackend → controlClient.js).
// Les deux backends exposent la même interface `call(method, args)`, le
// renderer ne voit pas la différence.

// Une seule instance : un second lancement ré-ouvre la fenêtre existante
// au lieu de démarrer un second agent qui téléchargerait les mêmes
// fichiers en double.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let mainWindow = null
let tray = null
let backend = null
let lastAuthLost = false

const autoLauncher = new AutoLaunch({ name: "PackSpace S3 Sync" })

function iconImage() {
  const iconPath = path.join(__dirname, "..", "build", "icon.png")
  const img = nativeImage.createFromPath(iconPath)
  return img.isEmpty() ? nativeImage.createEmpty() : img
}

function createWindow() {
  if (mainWindow) {
    mainWindow.show()
    mainWindow.focus()
    return
  }
  mainWindow = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    show: true,
    icon: iconImage(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.setMenuBarVisibility(false)
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"))
  // Fermer = masquer ; l'agent continue en fond (voir tray "Quitter").
  mainWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })
}

// Dernière mise à jour détectée par le processus principal (voir
// scheduleUpdateNotifications) — alimente l'entrée du menu tray.
let pendingUpdate = null

function buildTrayMenu() {
  if (!tray) return
  const items = [
    { label: "Ouvrir", click: () => createWindow() },
    { label: "Vérifier maintenant", click: () => backend && backend.call("scanNow").catch(() => {}) },
  ]
  if (pendingUpdate?.available) {
    items.push({ type: "separator" })
    items.push({
      label: `Mettre à jour vers v${pendingUpdate.version}`,
      click: () => {
        createWindow()
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("update:available", pendingUpdate)
      },
    })
  }
  items.push({ type: "separator" })
  items.push({
    label: "Quitter",
    click: () => {
      app.isQuitting = true
      app.quit()
    },
  })
  tray.setContextMenu(Menu.buildFromTemplate(items))
}

function buildTray() {
  tray = new Tray(iconImage())
  tray.setToolTip("PackSpace S3 Sync")
  buildTrayMenu()
  tray.on("click", () => createWindow())
}

// ---------- notification "nouvelle version" ----------
// Sur demande : "sync doit être capable de me notifier qu'une version est
// disponible pour la mettre à jour". La bannière de la fenêtre (renderer)
// n'est visible que fenêtre ouverte ; ici le processus principal vérifie
// au démarrage puis toutes les 2 h et affiche une NOTIFICATION SYSTÈME
// (une seule fois par version), ajoute une entrée au menu tray et change
// l'info-bulle. Un clic sur la notification ouvre la fenêtre sur la
// bannière de mise à jour.
const UPDATE_CHECK_MS = 2 * 60 * 60 * 1000
let notifiedUpdateVersion = null

async function checkForUpdateAndNotify() {
  if (!backend) return
  let info = null
  try {
    info = await backend.call("checkUpdate", [], 30000)
  } catch {
    return
  }
  pendingUpdate = info?.available ? info : null
  buildTrayMenu()
  if (tray) {
    tray.setToolTip(pendingUpdate ? `PackSpace S3 Sync — mise à jour v${pendingUpdate.version} disponible` : "PackSpace S3 Sync")
  }
  if (!pendingUpdate || pendingUpdate.version === notifiedUpdateVersion) return
  notifiedUpdateVersion = pendingUpdate.version

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("update:available", pendingUpdate)
  }
  if (Notification.isSupported()) {
    const n = new Notification({
      title: "PackSpace S3 Sync — mise à jour disponible",
      body: `Version v${pendingUpdate.version} disponible (actuelle : v${pendingUpdate.current || "?"}). Cliquez pour mettre à jour.`,
      icon: iconImage(),
    })
    n.on("click", () => {
      createWindow()
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("update:available", pendingUpdate)
    })
    n.show()
  }
}

function scheduleUpdateNotifications() {
  // Premier contrôle 30 s après le démarrage (laisse le backend se connecter).
  setTimeout(checkForUpdateAndNotify, 30 * 1000)
  setInterval(checkForUpdateAndNotify, UPDATE_CHECK_MS)
}

function pushState(state) {
  if (!state) return
  // Jeton révoqué (poste supprimé depuis le B2B) ou expiré : le moteur a
  // déjà effacé la session (engine.handleState) ; on ramène l'écran de
  // connexion une seule fois par perte.
  if (state.authLost && !lastAuthLost) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("auth:lost")
    createWindow()
  }
  lastAuthLost = !!state.authLost
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("sync:update", state)
  }
  if (tray) {
    const active = (state.items || []).filter((i) => i.status === "downloading")
    const prefix = backend && backend.kind === "service" ? "PackSpace S3 Sync (service)" : "PackSpace S3 Sync"
    if (active.length === 0) {
      tray.setToolTip(state.paused ? `${prefix} — en pause` : prefix)
    } else {
      const totalSpeed = active.reduce((s, i) => s + (i.speed || 0), 0)
      tray.setToolTip(`${prefix} — ${active.length} fichier(s) en cours, ${(totalSpeed / 1048576).toFixed(1)} Mo/s`)
    }
  }
}

// ---------- backends ----------

class LocalBackend {
  constructor() {
    this.kind = "local"
    this.engine = new Engine({ onState: pushState })
  }
  start() {
    this.engine.start()
  }
  call(method, args = []) {
    return this.engine.call(method, args)
  }
  getState() {
    return this.engine.getState()
  }
  async stop() {
    await this.engine.stop()
    await api.agentOffline().catch(() => {})
  }
}

const SERVICE_POLL_MS = 1500

class ServiceBackend {
  constructor() {
    this.kind = "service"
    this.client = new ControlClient({ port: Number(store.get("controlPort")) || 47831, token: store.get("controlToken") })
    this.timer = null
    this.reachable = false
    this.lastError = null
    this.last = null
  }
  start() {
    const tick = async () => {
      try {
        this.last = await this.client.state()
        this.reachable = true
        this.lastError = null
        pushState(this.last)
      } catch (err) {
        this.reachable = false
        this.lastError = err.message
        pushState({ ...(this.last || { items: [], instances: [] }), serviceUnreachable: err.message })
      }
      this.timer = setTimeout(tick, SERVICE_POLL_MS)
    }
    tick()
  }
  async call(method, args = [], timeoutMs = 60000) {
    // Le choix de dossier / l'ouverture d'un dossier restent côté fenêtre
    // (dialogues natifs) ; tout le reste part au service.
    const out = await this.client.call(method, args, timeoutMs)
    if (["login", "logout", "addInstance", "updateInstance", "removeInstance", "resetInstance", "pause", "resume"].includes(method)) {
      // Rafraîchit tout de suite plutôt que d'attendre le prochain tick.
      this.client.state().then(pushState).catch(() => {})
    }
    return out
  }
  getState() {
    return this.last || { items: [], instances: [] }
  }
  async stop() {
    clearTimeout(this.timer)
    // Le service continue : c'est tout l'intérêt du mode.
  }
}

function startBackend() {
  if (backend) backend.stop().catch(() => {})
  backend = store.get("mode") === "service" ? new ServiceBackend() : new LocalBackend()
  backend.start()
}

app.whenReady().then(() => {
  // Requis sur Windows pour que les notifications système s'affichent
  // (doit correspondre à build.appId dans package.json).
  if (process.platform === "win32") app.setAppUserModelId("ma.packspace.s3sync")
  buildTray()
  createWindow()
  startBackend()
  scheduleUpdateNotifications()

  if (store.get("autoLaunch")) {
    autoLauncher.isEnabled().then((enabled) => {
      if (!enabled) autoLauncher.enable().catch(() => {})
    })
  }
})

app.on("second-instance", () => createWindow())

app.on("window-all-closed", (event) => {
  // App "tray" : ne quitte jamais seule.
  event.preventDefault()
})

app.on("before-quit", (event) => {
  // Mode session : prévient le serveur (session arrêtée) avant de couper —
  // best effort, 5 s max, puis on quitte vraiment. Mode service : rien à
  // faire, le service continue.
  if (backend && !app.__stopped) {
    event.preventDefault()
    app.__stopped = true
    Promise.race([backend.stop(), new Promise((r) => setTimeout(r, 5000))]).finally(() => app.quit())
  }
})

// --- IPC exposé au renderer via preload.js ---

// Les erreurs axios portent tout l'objet réponse : on ne renvoie au
// renderer qu'un message lisible (ipcMain.handle sérialise l'Error).
function friendly(err) {
  const msg = err?.response?.data?.message || err?.message || "Erreur"
  return new Error(msg)
}

const wrap = (fn) => async (...args) => {
  try {
    return await fn(...args)
  } catch (err) {
    throw friendly(err)
  }
}

async function configSnapshot() {
  const mode = store.get("mode") || "session"
  let cfg = {}
  let serviceUnreachable = null
  try {
    cfg = await backend.call("getConfig")
  } catch (err) {
    // Service injoignable : on montre quand même la fenêtre (avec le
    // bandeau d'erreur) à partir de la config locale.
    serviceUnreachable = err.message
    cfg = {
      serverUrl: store.get("serverUrl"),
      userLabel: store.get("userLabel"),
      isLoggedIn: !!store.get("token"),
      agentLabel: store.get("agentLabel") || "",
      hostname: api.HOSTNAME,
    }
    for (const k of Engine.SETTING_KEYS) cfg[k] = store.get(k)
  }
  return {
    ...cfg,
    autoLaunch: store.get("autoLaunch"),
    mode,
    serviceUnreachable,
    serviceSupport: serviceInstaller.support(),
  }
}

ipcMain.handle("config:get", () => configSnapshot())
ipcMain.handle("config:setSettings", wrap(async (_e, partial) => {
  await backend.call("setSettings", [partial])
  return configSnapshot()
}))

ipcMain.handle("config:chooseDir", async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] })
  if (res.canceled || !res.filePaths[0]) return null
  return res.filePaths[0]
})

ipcMain.handle("config:setAutoLaunch", async (_e, enabled) => {
  store.set("autoLaunch", !!enabled)
  if (enabled) await autoLauncher.enable().catch(() => {})
  else await autoLauncher.disable().catch(() => {})
  return !!enabled
})

ipcMain.handle("auth:login", wrap(async (_e, payload) => {
  const out = await backend.call("login", [payload], 90000)
  lastAuthLost = false
  return out
}))

ipcMain.handle("auth:ping", async (_e, serverUrl) => {
  try {
    return await backend.call("ping", [serverUrl])
  } catch (err) {
    const status = err?.response?.status
    if (status === 404) throw new Error("L'API répond mais sans /ping : version API2 trop ancienne (redéployer).")
    if (err?.code === "ENOTFOUND") throw new Error("Nom de domaine introuvable (DNS).")
    if (err?.code === "ECONNREFUSED" && backend.kind === "local") throw new Error("Connexion refusée : rien n'écoute à cette adresse.")
    if (err?.code === "ECONNABORTED") throw new Error("Délai dépassé : le serveur ne répond pas.")
    if (err?.code === "CERT_HAS_EXPIRED" || /certificate/i.test(err?.message || "")) throw new Error(`Certificat TLS invalide : ${err.message}`)
    throw friendly(err)
  }
})

ipcMain.handle("auth:logout", wrap(() => backend.call("logout")))

ipcMain.handle("s3:browse", wrap((_e, prefix) => backend.call("browse", [prefix || ""])))

ipcMain.handle("inst:add", wrap((_e, payload) => backend.call("addInstance", [payload])))
ipcMain.handle("inst:update", wrap((_e, id, patch) => backend.call("updateInstance", [id, patch])))
ipcMain.handle("inst:remove", wrap((_e, id) => backend.call("removeInstance", [id])))
ipcMain.handle("inst:reset", wrap((_e, id) => backend.call("resetInstance", [id])))
ipcMain.handle("inst:openFolder", wrap(async (_e, id) => {
  const dir = await backend.call("instanceDir", [id])
  if (dir) shell.openPath(dir)
}))

ipcMain.handle("sync:state", () => (backend ? backend.getState() : { items: [], instances: [] }))
ipcMain.handle("sync:scanNow", wrap(() => backend.call("scanNow")))
ipcMain.handle("sync:retryFailed", wrap((_e, instanceId) => backend.call("retryFailed", [instanceId || null])))
ipcMain.handle("sync:pause", wrap(() => backend.call("pause")))
ipcMain.handle("sync:resume", wrap(() => backend.call("resume")))

// ---------- mise à jour ----------
// checkUpdate: simple vérification (bannière). applyUpdate: télécharge et
// installe réellement — en mode service, la commande part en RPC vers le
// VRAI processus service (silencieux, redémarre seul) ; en mode session,
// c'est CE processus Electron qui se ferme juste après avoir lancé
// l'assistant d'installation (voir selfUpdater.js). Le timeout est élevé :
// le téléchargement de l'installeur peut prendre plus d'une minute.
ipcMain.handle("update:check", wrap(() => backend.call("checkUpdate")))
ipcMain.handle("update:apply", wrap(() => backend.call("applyUpdate", [], 180000)))

// ---------- mode service ----------

ipcMain.handle("service:status", async () => {
  const st = await serviceInstaller.status()
  if (backend && backend.kind === "service") {
    st.reachable = backend.reachable
    st.error = backend.lastError
  } else if (st.installed) {
    // Installé mais la fenêtre est en mode session : on sonde quand même.
    const probe = new ControlClient({ port: Number(store.get("controlPort")) || 47831, token: store.get("controlToken") })
    st.reachable = await probe.health().then(() => true).catch(() => false)
  }
  return st
})

ipcMain.handle("service:install", wrap(async () => {
  // Arrêt propre du moteur local (les .part restent, le service reprend)
  // puis copie de la config vers le dossier machine et installation.
  if (backend && backend.kind === "local") {
    await backend.engine.stop()
  }
  try {
    await serviceInstaller.install()
  } catch (err) {
    // Échec (UAC refusé…) : on relance le moteur local, rien n'est perdu.
    if (backend && backend.kind === "local") backend.engine.start()
    throw err
  }
  // Le moteur local est déjà arrêté ; on ne signale PAS le poste hors
  // ligne au serveur (le service reprend le même poste dans la foulée).
  backend = null
  lastAuthLost = false
  startBackend()
  return serviceInstaller.status()
}))

// Arrêt / démarrage du service SANS le désinstaller (voir
// serviceInstaller.stop/start). La fenêtre reste en mode service : le
// bandeau "service injoignable" s'affiche tant qu'il est arrêté.
ipcMain.handle("service:stop", wrap(() => serviceInstaller.stop()))
ipcMain.handle("service:start", wrap(async () => {
  const st = await serviceInstaller.start()
  // Reprend le polling du backend service tout de suite.
  if (backend && backend.kind === "service") {
    backend.client.state().then(pushState).catch(() => {})
  }
  return st
}))

ipcMain.handle("service:uninstall", wrap(async () => {
  if (backend && backend.kind === "service") await backend.stop()
  try {
    await serviceInstaller.uninstall()
  } finally {
    startBackend()
  }
  return serviceInstaller.status()
}))
