const store = require("./store")
const api = require("./api")
const SyncManager = require("./syncManager")
const { PLATFORM_OS, pickAsset, isNewerVersion } = require("./updateUtils")

// Cœur de l'agent, SANS Electron : SyncManager + toutes les opérations que
// l'interface peut demander (connexion, instances, réglages, commandes).
//
// Il est instancié soit dans le processus Electron (mode "session", voir
// main.js → LocalBackend), soit dans src/service.js (mode "service", lancé
// par le gestionnaire de services de l'OS, sans session utilisateur
// ouverte). Dans les deux cas l'interface passe par `engine.call(method,
// args)` : en mode service l'appel transite par l'API de contrôle locale
// (controlServer.js / controlClient.js), ce qui garantit que les deux modes
// se comportent exactement pareil.

const SETTING_KEYS = [
  "pollIntervalMs",
  "maxParallelFiles",
  "maxParallelChunks",
  "chunkSizeMb",
  "chunkThresholdMb",
  "maxRetries",
  "failedRetryDelayMin",
]

class Engine {
  constructor({ onState, log } = {}) {
    this.listeners = new Set()
    if (onState) this.listeners.add(onState)
    this.log = log || (() => {})
    this.lastState = null
    this.sync = new SyncManager((state) => this.handleState(state))
  }

  onState(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  start() {
    this.sync.start()
  }

  async stop() {
    await this.sync.stop()
  }

  handleState(state) {
    // Jeton révoqué (poste supprimé depuis le B2B) ou expiré : on efface la
    // session locale et on arrête ; l'interface repasse sur l'écran de
    // connexion (state.authLost reste à true jusqu'à la prochaine
    // connexion).
    if (state.authLost && store.get("token")) {
      this.log("warn", "Jeton agent révoqué ou expiré : déconnexion")
      store.set("token", "")
      store.set("userLabel", "")
      store.set("agentId", null)
      this.sync.registered = false
      this.sync.stop().catch(() => {})
    }
    this.lastState = state
    for (const fn of this.listeners) {
      try {
        fn(state)
      } catch {
        /* un écouteur défaillant ne bloque pas les autres */
      }
    }
  }

  state() {
    return this.sync.state()
  }

  // ---------- opérations exposées à l'interface ----------

  getConfig() {
    const server = store.get("serverSettings") || {}
    const out = {
      serverUrl: store.get("serverUrl"),
      userLabel: store.get("userLabel"),
      isLoggedIn: !!store.get("token"),
      agentId: store.get("agentId") || null,
      agentLabel: store.get("agentLabel") || "",
      hostname: api.HOSTNAME,
      dataDir: store.dataDir,
      version: api.APP_VERSION,
    }
    // Réglages : ceux du serveur (modifiables aussi depuis le B2B), repli
    // sur les défauts locaux tant que le poste n'est pas enregistré.
    for (const k of SETTING_KEYS) out[k] = server[k] ?? store.get(k)
    return out
  }

  async setSettings(partial) {
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
      await api.updateAgentSettings(agentId, settings)
      await this.sync.refreshConfig()
    } else {
      for (const [k, v] of Object.entries(settings)) store.set(k, v)
    }
    this.sync.dispatch()
    return this.getConfig()
  }

  ping(serverUrl) {
    return api.ping(serverUrl)
  }

  // Vérifie la dernière version publiée (même source que la carte de
  // téléchargement du B2B) et renvoie de quoi la fenêtre affiche une
  // bannière ou la déclenche : { available, version, current, asset } —
  // asset=null si aucun installeur pour cette plateforme (ou aucune
  // release publiée). Ne throw jamais : un souci réseau => juste
  // "non disponible", pas d'erreur qui interromprait l'appelant.
  async checkUpdate() {
    try {
      const rel = await api.fetchLatestRelease()
      if (!rel?.available || !rel.version) return { available: false, current: api.APP_VERSION }
      const asset = pickAsset(rel.assets, PLATFORM_OS[process.platform] || null)
      const available = isNewerVersion(rel.version, api.APP_VERSION) && !!asset
      return { available, version: rel.version, current: api.APP_VERSION, asset }
    } catch {
      return { available: false, current: api.APP_VERSION }
    }
  }

  // Déclenche réellement la mise à jour (téléchargement + installation) —
  // voir selfUpdater.js pour le détail par plateforme/mode. Appelable :
  //  - depuis la fenêtre en mode session (bannière "nouvelle version"),
  //  - depuis la fenêtre en mode service, via l'API de contrôle (RPC vers
  //    le VRAI processus service, pas la fenêtre) — même bouton, même
  //    résultat ;
  //  - à distance depuis le B2B, via la commande "update" (voir
  //    SyncManager.runCommand) reçue au heartbeat suivant.
  // Le process peut se terminer lui-même en cas de succès (voir
  // selfUpdater) : l'appelant ne doit pas compter sur une réponse RPC dans
  // ce cas (la connexion se coupe simplement).
  applyUpdate() {
    const { applyUpdate } = require("./selfUpdater")
    return applyUpdate({ log: this.log })
  }

  async login({ serverUrl, logon, password }) {
    const data = await api.login(serverUrl, logon, password)
    store.set("serverUrl", data.serverUrl || serverUrl)
    store.set("token", data.token)
    store.set("userLabel", `${data.first_name || ""} ${data.last_name || ""}`.trim() || data.logon)
    this.sync.registered = false
    await this.sync.register()
    // Redémarre la boucle si elle avait été arrêtée par une déconnexion :
    // le premier scan remet en file les fichiers non terminés, qui
    // reprennent là où ils s'étaient arrêtés.
    this.sync.start()
    this.sync.scanNow()
    this.log("info", `Connecté (${store.get("userLabel")}) sur ${store.get("serverUrl")}`)
    return { userLabel: store.get("userLabel"), agentLabel: store.get("agentLabel") }
  }

  async logout() {
    // Arrêt propre des téléchargements (fichiers partiels conservés pour
    // reprise) AVANT de révoquer la session ; les manifestes restent.
    await this.sync.stop()
    this.sync.registered = false
    await api.agentOffline()
    store.set("token", "")
    store.set("userLabel", "")
    store.set("agentId", null)
    this.log("info", "Déconnecté")
  }

  browse(prefix) {
    return api.browse(prefix || "")
  }

  addInstance(payload) {
    return this.sync.addInstance(payload)
  }

  updateInstance(id, patch) {
    return this.sync.updateInstance(id, patch)
  }

  removeInstance(id) {
    return this.sync.removeInstance(id)
  }

  resetInstance(id) {
    return this.sync.resetInstance(id)
  }

  instanceDir(id) {
    const inst = this.sync.instances().find((i) => i.id === id)
    return inst?.localDir || null
  }

  getState() {
    return this.sync.state()
  }

  scanNow() {
    return this.sync.scanNow()
  }

  retryFailed(instanceId) {
    return this.sync.retryFailed(instanceId || null)
  }

  pause() {
    return this.sync.pause()
  }

  resume() {
    return this.sync.resume()
  }

  // Point d'entrée unique (IPC Electron ou API de contrôle du service).
  async call(method, args = []) {
    if (!Engine.METHODS.includes(method)) throw new Error(`Méthode inconnue : ${method}`)
    return this[method](...(Array.isArray(args) ? args : []))
  }
}

Engine.METHODS = [
  "getConfig",
  "setSettings",
  "ping",
  "checkUpdate",
  "applyUpdate",
  "login",
  "logout",
  "browse",
  "addInstance",
  "updateInstance",
  "removeInstance",
  "resetInstance",
  "instanceDir",
  "getState",
  "scanNow",
  "retryFailed",
  "pause",
  "resume",
]
Engine.SETTING_KEYS = SETTING_KEYS

module.exports = Engine
