const { contextBridge, ipcRenderer } = require("electron")

// Surface IPC minimale exposée au renderer (contextIsolation activé, pas
// d'accès direct à Node/Electron depuis la page — voir main.js).
contextBridge.exposeInMainWorld("agent", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  setSettings: (partial) => ipcRenderer.invoke("config:setSettings", partial),
  chooseDir: () => ipcRenderer.invoke("config:chooseDir"),
  setAutoLaunch: (enabled) => ipcRenderer.invoke("config:setAutoLaunch", enabled),
  ping: (serverUrl, tenant) => ipcRenderer.invoke("auth:ping", serverUrl, tenant),
  resolveTenant: (tenant, hint) => ipcRenderer.invoke("auth:resolveTenant", tenant, hint),
  login: (payload) => ipcRenderer.invoke("auth:login", payload),
  logout: () => ipcRenderer.invoke("auth:logout"),

  // Envoi de fichiers (conception / montage) sur une commande
  pickUploadFile: () => ipcRenderer.invoke("upload:pickFile"),
  getOrder: (orderId) => ipcRenderer.invoke("upload:getOrder", orderId),
  openItemFile: (s3Key) => ipcRenderer.invoke("upload:openFile", s3Key),
  uploadItemFile: (payload) => ipcRenderer.invoke("upload:start", payload),
  onUploadProgress: (cb) => ipcRenderer.on("upload:progress", (_e, p) => cb(p)),

  // Explorateur S3 (PrintProd)
  browse: (prefix) => ipcRenderer.invoke("s3:browse", prefix),

  // Instances de synchronisation
  addInstance: (payload) => ipcRenderer.invoke("inst:add", payload),
  updateInstance: (id, patch) => ipcRenderer.invoke("inst:update", id, patch),
  removeInstance: (id) => ipcRenderer.invoke("inst:remove", id),
  resetInstance: (id) => ipcRenderer.invoke("inst:reset", id),
  openInstanceFolder: (id) => ipcRenderer.invoke("inst:openFolder", id),

  getState: () => ipcRenderer.invoke("sync:state"),
  scanNow: () => ipcRenderer.invoke("sync:scanNow"),
  retryFailed: (instanceId) => ipcRenderer.invoke("sync:retryFailed", instanceId),
  pause: () => ipcRenderer.invoke("sync:pause"),
  resume: () => ipcRenderer.invoke("sync:resume"),
  // Mode service (l'agent tourne sans session ouverte)
  serviceStatus: () => ipcRenderer.invoke("service:status"),
  serviceInstall: () => ipcRenderer.invoke("service:install"),
  serviceUninstall: () => ipcRenderer.invoke("service:uninstall"),
  // Poussé par le processus principal quand une nouvelle version est détectée
  onUpdateAvailable: (cb) => ipcRenderer.on("update:available", (_e, info) => cb(info)),
  serviceStop: () => ipcRenderer.invoke("service:stop"),
  serviceStart: () => ipcRenderer.invoke("service:start"),

  // Mise à jour de l'agent (voir selfUpdater.js)
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  applyUpdate: () => ipcRenderer.invoke("update:apply"),

  // Pré-remplissage de la connexion (lien printios-sync:// depuis le navigateur)
  onAuthPrefill: (cb) => ipcRenderer.on("auth:prefill", (_e, p) => cb(p)),
  onAuthLost: (callback) => {
    const listener = () => callback()
    ipcRenderer.on("auth:lost", listener)
    return () => ipcRenderer.removeListener("auth:lost", listener)
  },
  onStateUpdate: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on("sync:update", listener)
    return () => ipcRenderer.removeListener("sync:update", listener)
  },
})
