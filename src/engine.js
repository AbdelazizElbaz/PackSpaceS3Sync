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
  "autoUpdate",
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

  // Synchro S3 uniquement pour les rôles autorisés (un vendeur connecté
  // n'a que l'envoi de fichiers : les endpoints /desktop/* lui répondraient 403).
  canSync() {
    return !store.get("token") || api.SYNC_ROLES.includes(store.get("role") || "sync_agent")
  }

  start() {
    if (this.canSync()) this.sync.start()
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
      tenant: store.get("tenant") || "",
      userLabel: store.get("userLabel"),
      role: store.get("role") || "",
      canSync: this.canSync(),
      canUpload: api.UPLOAD_ROLES.includes(store.get("role") || ""),
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

  ping(serverUrl, tenant = "") {
    return api.ping(serverUrl, tenant)
  }

  // Espace client → adresse d'API déduite + vérification (voir api.resolveServerForTenant).
  resolveTenant(tenant, hint = "") {
    return api.resolveServerForTenant(tenant, hint)
  }

  // Vérifie la dernière version publiée (même source que la carte de
  // téléchargement du B2B) et renvoie de quoi la fenêtre affiche une
  // bannière ou la déclenche : { available, version, current, asset } —
  // asset=null si aucun installeur pour cette plateforme (ou aucune
  // release publiée). Ne throw jamais : un souci réseau => juste
  // "non disponible", pas d'erreur qui interromprait l'appelant.
  async checkUpdate() {
    // Sans jeton aussi (écran de connexion) : l'endpoint de version est public.
    if (!store.get("serverUrl")) {
      return { available: false, current: api.APP_VERSION, reason: "no_server" }
    }
    try {
      const rel = await api.fetchLatestRelease()
      if (!rel?.available || !rel.version) {
        return { available: false, current: api.APP_VERSION, reason: "no_release", message: rel?.message || null }
      }
      const asset = pickAsset(rel.assets, PLATFORM_OS[process.platform] || null)
      const newer = isNewerVersion(rel.version, api.APP_VERSION)
      const available = newer && !!asset
      return {
        available,
        version: rel.version,
        current: api.APP_VERSION,
        asset,
        reason: available ? null : !newer ? "up_to_date" : "no_asset_for_platform",
      }
    } catch (err) {
      return { available: false, current: api.APP_VERSION, reason: "error", message: err?.message || String(err) }
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
    // Chaque pas de progression réémet l'état (state.updateProgress) → la
    // fenêtre affiche la barre de progression.
    return applyUpdate({ log: this.log, onProgress: () => this.sync.emit() })
  }

  async login({ serverUrl, logon, password, tenant = "" }) {
    // Adresse d'API absente → déduite de l'espace client.
    if (!serverUrl && tenant) {
      const r = await api.resolveServerForTenant(tenant)
      serverUrl = r.serverUrl
      tenant = r.tenant
    }
    const data = await api.login(serverUrl, logon, password, tenant)
    store.set("serverUrl", data.serverUrl || serverUrl)
    store.set("tenant", api.normalizeTenant(tenant))
    store.set("token", data.token)
    store.set("role", data.role || "")
    store.set("userId", data.id || null)
    store.set("userLabel", `${data.first_name || ""} ${data.last_name || ""}`.trim() || data.logon)
    this.sync.registered = false
    if (this.canSync()) {
      await this.sync.register()
      // Redémarre la boucle si elle avait été arrêtée par une déconnexion :
      // le premier scan remet en file les fichiers non terminés, qui
      // reprennent là où ils s'étaient arrêtés.
      this.sync.start()
      this.sync.scanNow()
    }
    this.log("info", `Connecté (${store.get("userLabel")}) sur ${store.get("serverUrl")}${store.get("tenant") ? ` — espace ${store.get("tenant")}` : ""}`)
    return { userLabel: store.get("userLabel"), agentLabel: store.get("agentLabel"), role: store.get("role"), canSync: this.canSync() }
  }

  // ---------- envoi de fichiers (conception / montage) ----------
  getOrder(orderId) {
    return api.getOrder(orderId)
  }

  fileUrl(s3Key, displayName = null) {
    return api.fileUrl(s3Key, displayName)
  }

  listUnshippedOrders(opts) {
    return api.listUnshippedOrders(opts || {})
  }

  // Progression poussée via les listeners d'état (clé uploadProgress) pour
  // que la fenêtre affiche la barre — même mécanisme que les mises à jour.
  async uploadItemFile(payload) {
    const emit = (p) => { for (const fn of this.listeners) fn({ ...(this.lastState || { items: [], instances: [] }), uploadProgress: { ...p, itemId: payload.itemId, kind: payload.kind } }) }
    try {
      const out = await api.uploadItemFile({ ...payload, onProgress: emit })
      emit({ bytes: out.size, size: out.size, done: true })
      this.log("info", `Fichier ${payload.kind === "design" ? "de conception" : "de montage"} envoyé sur la commande ${payload.orderId} (article ${payload.itemId}) : ${out.name}`)
      return out
    } catch (err) {
      emit({ error: err?.response?.data?.message || err.message })
      throw new Error(err?.response?.data?.message || err.message)
    }
  }

  async logout() {
    // Arrêt propre des téléchargements (fichiers partiels conservés pour
    // reprise) AVANT de révoquer la session ; les manifestes restent.
    await this.sync.stop()
    this.sync.registered = false
    await api.agentOffline()
    store.set("token", "")
    store.set("role", "")
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
  "resolveTenant",
  "getOrder",
  "fileUrl",
  "listUnshippedOrders",
  "uploadItemFile",
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
