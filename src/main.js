const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell } = require("electron")
const path = require("path")
const AutoLaunch = require("auto-launch")
const store = require("./store")
const api = require("./api")
const { login, browse, ping } = api
const SyncManager = require("./syncManager")

// Une seule instance : un second lancement ré-ouvre la fenêtre existante
// au lieu de démarrer un second agent qui téléchargerait les mêmes
// fichiers en double.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let mainWindow = null
let tray = null
let sync = null

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

function buildTray() {
  tray = new Tray(iconImage())
  tray.setToolTip("PackSpace S3 Sync")
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Ouvrir", click: () => createWindow() },
      { label: "Vérifier maintenant", click: () => sync && sync.scanNow() },
      { type: "separator" },
      {
        label: "Quitter",
        click: () => {
          app.isQuitting = true
          app.quit()
        },
      },
    ])
  )
  tray.on("click", () => createWindow())
}

function pushState(state) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("sync:update", state)
  }
  if (tray) {
    const active = state.items.filter((i) => i.status === "downloading")
    if (active.length === 0) {
      tray.setToolTip(state.paused ? "PackSpace S3 Sync — en pause" : "PackSpace S3 Sync")
    } else {
      const totalSpeed = active.reduce((s, i) => s + (i.speed || 0), 0)
      tray.setToolTip(
        `PackSpace S3 Sync — ${active.length} fichier(s) en cours, ${(totalSpeed / 1048576).toFixed(1)} Mo/s`
      )
    }
  }
}

app.whenReady().then(() => {
  buildTray()
  createWindow()

  sync = new SyncManager(pushState)
  sync.start()

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
  // Prévient le serveur (session arrêtée) avant de couper — best effort,
  // 4 s max, puis on quitte vraiment.
  if (sync && !app.__offlineSent) {
    event.preventDefault()
    app.__offlineSent = true
    sync.stop()
    Promise.race([api.agentOffline(), new Promise((r) => setTimeout(r, 4000))]).finally(() => app.quit())
  }
})

// --- IPC exposé au renderer via preload.js ---

const SETTING_KEYS = [
  "pollIntervalMs",
  "maxParallelFiles",
  "maxParallelChunks",
  "chunkSizeMb",
  "chunkThresholdMb",
  "maxRetries",
]

function configSnapshot() {
  const server = store.get("serverSettings") || {}
  const out = {
    serverUrl: store.get("serverUrl"),
    userLabel: store.get("userLabel"),
    autoLaunch: store.get("autoLaunch"),
    isLoggedIn: !!store.get("token"),
    agentId: store.get("agentId") || null,
    agentLabel: store.get("agentLabel") || "",
    hostname: api.HOSTNAME,
  }
  // Réglages : ceux du serveur (modifiables aussi depuis le B2B), repli
  // sur les défauts locaux tant que le poste n'est pas enregistré.
  for (const k of SETTING_KEYS) out[k] = server[k] ?? store.get(k)
  return out
}

// Les erreurs axios portent tout l'objet réponse : on ne renvoie au
// renderer qu'un message lisible (ipcMain.handle sérialise l'Error).
function friendly(err) {
  const msg = err?.response?.data?.message || err?.message || "Erreur"
  const e = new Error(msg)
  return e
}

ipcMain.handle("config:get", () => configSnapshot())

ipcMain.handle("config:setSettings", async (_e, partial) => {
  const settings = {}
  for (const k of SETTING_KEYS) {
    if (partial && partial[k] !== undefined) {
      const n = Number(partial[k])
      if (Number.isFinite(n) && n >= 0) settings[k] = n
    }
  }
  // Source de vérité = serveur (DesktopSyncController::update) ; l'agent
  // recharge ensuite sa config. Sans agent enregistré, on garde en local.
  const agentId = store.get("agentId")
  if (agentId) {
    try {
      await api.updateAgentSettings(agentId, settings)
      await sync.refreshConfig()
    } catch (err) {
      throw friendly(err)
    }
  } else {
    for (const [k, v] of Object.entries(settings)) store.set(k, v)
  }
  if (sync) sync.dispatch()
  return configSnapshot()
})

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

ipcMain.handle("auth:login", async (_e, { serverUrl, logon, password }) => {
  try {
    const data = await login(serverUrl, logon, password)
    store.set("serverUrl", data.serverUrl || serverUrl)
    store.set("token", data.token)
    store.set("userLabel", `${data.first_name || ""} ${data.last_name || ""}`.trim() || data.logon)
    if (sync) {
      sync.registered = false
      await sync.register()
      sync.scanNow()
    }
    return { userLabel: store.get("userLabel"), agentLabel: store.get("agentLabel") }
  } catch (err) {
    throw friendly(err)
  }
})

ipcMain.handle("auth:ping", async (_e, serverUrl) => {
  try {
    return await ping(serverUrl)
  } catch (err) {
    const status = err?.response?.status
    if (status === 404) throw new Error("L'API répond mais sans /ping : version API2 trop ancienne (redéployer).")
    if (err?.code === "ENOTFOUND") throw new Error("Nom de domaine introuvable (DNS).")
    if (err?.code === "ECONNREFUSED") throw new Error("Connexion refusée : rien n'écoute à cette adresse.")
    if (err?.code === "ECONNABORTED") throw new Error("Délai dépassé : le serveur ne répond pas.")
    if (err?.code === "CERT_HAS_EXPIRED" || /certificate/i.test(err?.message || "")) throw new Error(`Certificat TLS invalide : ${err.message}`)
    throw friendly(err)
  }
})

ipcMain.handle("auth:logout", async () => {
  await api.agentOffline()
  if (sync) sync.registered = false
  store.set("token", "")
  store.set("userLabel", "")
  store.set("agentId", null)
})

ipcMain.handle("s3:browse", async (_e, prefix) => {
  try {
    return await browse(prefix || "")
  } catch (err) {
    throw friendly(err)
  }
})

const wrap = (fn) => async (...args) => {
  try {
    return await fn(...args)
  } catch (err) {
    throw friendly(err)
  }
}
ipcMain.handle("inst:add", wrap((_e, payload) => sync.addInstance(payload)))
ipcMain.handle("inst:update", wrap((_e, id, patch) => sync.updateInstance(id, patch)))
ipcMain.handle("inst:remove", wrap((_e, id) => sync.removeInstance(id)))
ipcMain.handle("inst:reset", (_e, id) => sync.resetInstance(id))
ipcMain.handle("inst:openFolder", (_e, id) => {
  const inst = sync.instances().find((i) => i.id === id)
  if (inst?.localDir) shell.openPath(inst.localDir)
})

ipcMain.handle("sync:state", () => (sync ? sync.state() : { items: [], instances: [] }))
ipcMain.handle("sync:scanNow", () => sync && sync.scanNow())
ipcMain.handle("sync:retryFailed", (_e, instanceId) => sync && sync.retryFailed(instanceId || null))
ipcMain.handle("sync:pause", () => sync && sync.pause())
ipcMain.handle("sync:resume", () => sync && sync.resume())
