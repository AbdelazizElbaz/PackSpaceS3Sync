// Shim "web" de window.agent — chargé AVANT renderer.js quand l'interface
// est servie par l'API de contrôle du service (conteneur Docker / Synology,
// voir src/controlServer.js `serveUi`). Il remplace le pont IPC Electron
// (src/preload.js) par des appels fetch vers /rpc et /state : renderer.js
// ne voit aucune différence.
//
// Jeton de contrôle : passé une fois dans l'URL (?token=…), ou demandé à
// la première requête refusée, puis mémorisé dans localStorage.
;(function () {
  const KEY = "packspaceControlToken"
  const params = new URLSearchParams(location.search)
  let token = params.get("token") || localStorage.getItem(KEY) || ""
  if (params.get("token")) {
    localStorage.setItem(KEY, token)
    history.replaceState(null, "", location.pathname)
  }

  function askToken(message) {
    const t = window.prompt(message || "Jeton de contrôle du service (CONTROL_TOKEN du conteneur) :", "")
    if (t && t.trim()) {
      token = t.trim()
      localStorage.setItem(KEY, token)
      return true
    }
    return false
  }

  async function request(method, path, body, retry = true) {
    const res = await fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (res.status === 401 && retry) {
      if (askToken("Jeton de contrôle invalide ou absent. Saisissez le CONTROL_TOKEN du conteneur :")) {
        return request(method, path, body, false)
      }
      throw new Error("Jeton de contrôle requis.")
    }
    let json = null
    try {
      json = await res.json()
    } catch {
      json = null
    }
    if (!res.ok) throw new Error(json?.error || `Service : HTTP ${res.status}`)
    return json
  }

  const rpc = async (method, args = []) => (await request("POST", "/rpc", { method, args })).result
  const getState = () => request("GET", "/state")

  // Diffusion de l'état (remplace l'événement IPC sync:update).
  const stateListeners = []
  const authLostListeners = []
  let lastAuthLost = false
  setInterval(async () => {
    try {
      const s = await getState()
      if (s.authLost && !lastAuthLost) authLostListeners.forEach((f) => f())
      lastAuthLost = !!s.authLost
      stateListeners.forEach((f) => f(s))
    } catch (e) {
      stateListeners.forEach((f) => f({ items: [], instances: [], serviceUnreachable: e.message }))
    }
  }, 1500)

  const NOT_AVAILABLE = "Indisponible dans le conteneur : géré par Docker / Container Manager."

  window.agent = {
    getConfig: async () => ({
      ...(await rpc("getConfig")),
      mode: "web",
      autoLaunch: false,
      serviceSupport: { supported: false, reason: NOT_AVAILABLE },
    }),
    setSettings: (partial) => rpc("setSettings", [partial]),
    // Pas de dialogue natif : le chemin est saisi tel que vu DANS le
    // conteneur (volume monté, ex. /sync/atelier-1).
    chooseDir: async () => {
      const d = window.prompt("Dossier de destination, tel que monté dans le conteneur (ex. /sync/atelier) :", "/sync/")
      return d && d.trim() ? d.trim() : null
    },
    setAutoLaunch: async () => false,
    ping: (serverUrl) => rpc("ping", [serverUrl]),
    login: (payload) => rpc("login", [payload]),
    logout: () => rpc("logout"),
    browse: (prefix) => rpc("browse", [prefix || ""]),
    addInstance: (payload) => rpc("addInstance", [payload]),
    updateInstance: (id, patch) => rpc("updateInstance", [id, patch]),
    removeInstance: (id) => rpc("removeInstance", [id]),
    resetInstance: (id) => rpc("resetInstance", [id]),
    openInstanceFolder: async () => {},
    getState,
    scanNow: () => rpc("scanNow"),
    retryFailed: (instanceId) => rpc("retryFailed", [instanceId || null]),
    pause: () => rpc("pause"),
    resume: () => rpc("resume"),
    serviceStatus: async () => ({ supported: false, reason: NOT_AVAILABLE, installed: false, running: true, mode: "web" }),
    serviceInstall: async () => {
      throw new Error(NOT_AVAILABLE)
    },
    serviceUninstall: async () => {
      throw new Error(NOT_AVAILABLE)
    },
    onAuthLost: (f) => {
      authLostListeners.push(f)
      return () => {}
    },
    onStateUpdate: (f) => {
      stateListeners.push(f)
      return () => {}
    },
  }

  // Ajustements d'interface propres au web : dossier saisi au clavier,
  // pas de "Choisir…" natif, badge de mode "conteneur".
  document.addEventListener("DOMContentLoaded", () => {
    const dir = document.getElementById("instLocalDir")
    if (dir) {
      dir.removeAttribute("readonly")
      dir.placeholder = "/sync/mon-dossier (chemin dans le conteneur)"
    }
    const btn = document.getElementById("instChooseDirBtn")
    if (btn) btn.textContent = "…"
    const badge = document.getElementById("modeBadge")
    if (badge) {
      badge.textContent = "conteneur"
      badge.title = "L'agent tourne dans un conteneur (Docker / Synology) ; cette page le pilote."
      badge.classList.remove("hidden")
    }
  })
})()
