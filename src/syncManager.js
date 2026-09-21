const path = require("path")
const fs = require("fs")
const { Worker } = require("worker_threads")
const store = require("./store")
const api = require("./api")

// Orchestrateur des INSTANCES DE SYNCHRONISATION, piloté par API2.
//
// Une instance = un dossier S3 sous PrintProd/PrintWorkSpace (préfixe) →
// un dossier local. La liste des instances ET les réglages de parallélisme
// vivent côté serveur (DesktopSyncController) : ils sont modifiables aussi
// bien depuis cet agent que depuis l'app B2B, et l'agent les recharge à
// chaque cycle (config_version). Ce qui reste local : les MANIFESTES (clé
// S3 → {size, etag} déjà synchronisés), le jeton, et un cache de la
// dernière config connue pour continuer à tourner si API2 est injoignable.
//
// Cycle (toutes les pollIntervalMs) :
//   1. heartbeat → instantané d'avancement au serveur + commandes en retour
//      (pause/resume/scan/retry/reset envoyées depuis le B2B)
//   2. si config_version a changé → recharge réglages + instances
//   3. scan de chaque instance active : listing récursif S3 vs manifeste →
//      nouveaux/modifiés en file
//   4. dispatch vers le pool de worker threads (un fichier par thread)
//   5. événements (fichier synchronisé / échec / erreur de scan) poussés
//      au serveur par lots → historique + notifications in-app du B2B.

const WORKER_PATH = path.join(__dirname, "workers", "downloadWorker.js")

class SyncManager {
  constructor(onUpdate) {
    this.onUpdate = onUpdate || (() => {})
    this.items = new Map() // jobKey (instanceId|s3Key) -> item
    this.workers = new Map() // jobKey -> Worker
    this.instanceStats = new Map() // instanceId -> { lastScanAt, lastError, total, synced }
    this.polling = false
    this.paused = false
    this.pollTimer = null
    this.wakeTimer = null
    this.scanning = false
    this.registered = false
    this.serverError = null
    this.configVersion = 0
    this.eventQueue = []
    // Passe à true quand API2 répond 401 (jeton agent révoqué : poste
    // supprimé depuis le B2B, ou jeton expiré). main.js efface alors le
    // jeton et ramène l'écran de connexion — l'agent ne se ré-enregistre
    // pas tout seul.
    this.authLost = false
  }

  // ---------- config serveur (avec cache local) ----------

  settings() {
    return store.get("serverSettings") || {}
  }

  setting(key, fallback) {
    const v = Number(this.settings()[key] ?? store.get(key))
    return Number.isFinite(v) && v > 0 ? v : fallback
  }

  instances() {
    return store.get("instances") || []
  }

  applyConfig(cfg) {
    if (!cfg) return
    store.set("agentId", cfg.agent_id)
    store.set("agentLabel", cfg.label || "")
    store.set("serverSettings", cfg.settings || {})
    // Normalise vers le format interne (localDir, enabled, id serveur).
    const list = (cfg.instances || []).map((i) => ({
      id: i.id,
      name: i.name,
      prefix: String(i.prefix || "").replace(/^\/+|\/+$/g, ""),
      localDir: i.localDir,
      enabled: i.enabled !== false,
      deleteRemoved: i.deleteRemoved === true,
    }))
    const known = new Set(list.map((i) => i.id))
    // Instances supprimées côté serveur : on abandonne leurs jobs en cours.
    for (const [k, item] of this.items) {
      if (!known.has(item.instanceId)) {
        this.terminateWorker(k)
        this.items.delete(k)
      }
    }
    store.set("instances", list)
    this.configVersion = Number(cfg.config_version || 0)
    this.emit()
  }

  // Premier contact après connexion (ou au démarrage) : enregistre le poste
  // et récupère la config. Les instances locales pré-existantes (ancienne
  // version de l'agent, sans serveur) sont importées si le poste est
  // nouveau côté serveur.
  async register() {
    if (!store.get("serverUrl") || !store.get("token")) return false
    try {
      const localInstances = this.instances().map((i) => ({
        name: i.name,
        prefix: i.prefix,
        localDir: i.localDir,
        enabled: i.enabled !== false,
      }))
      const cfg = await api.registerAgent(localInstances, this.settings())
      this.applyConfig(cfg)
      this.registered = true
      this.serverError = null
      return true
    } catch (err) {
      this.registered = false
      this.serverError = describe(err)
      if (err?.response?.status === 401) this.authLost = true
      this.emit()
      return false
    }
  }

  async refreshConfig() {
    try {
      const cfg = await api.fetchAgentConfig()
      this.applyConfig(cfg)
      this.serverError = null
    } catch (err) {
      this.serverError = describe(err)
      if (err?.response?.status === 404) this.registered = false
    }
  }

  // ---------- instances (écritures → serveur, puis rechargement) ----------

  async addInstance({ name, prefix, localDir, deleteRemoved = false }) {
    const agentId = store.get("agentId")
    if (!agentId) throw new Error("Agent non enregistré auprès du serveur.")
    await api.createInstance(agentId, {
      name: name || path.basename(prefix),
      prefix: String(prefix).replace(/^\/+|\/+$/g, ""),
      localDir,
      enabled: true,
      deleteRemoved: !!deleteRemoved,
    })
    await this.refreshConfig()
    this.scanNow()
  }

  async updateInstance(id, patch) {
    await api.updateInstance(id, patch)
    await this.refreshConfig()
    this.scanNow()
  }

  async removeInstance(id) {
    await api.deleteInstance(id)
    for (const [k, item] of this.items) {
      if (item.instanceId === id) {
        this.terminateWorker(k)
        this.items.delete(k)
      }
    }
    const manifests = store.get("manifests") || {}
    delete manifests[id]
    store.set("manifests", manifests)
    this.instanceStats.delete(id)
    await this.refreshConfig()
  }

  manifest(instanceId) {
    const all = store.get("manifests") || {}
    return all[instanceId] || {}
  }

  markSynced(instanceId, key, meta) {
    const all = store.get("manifests") || {}
    all[instanceId] = all[instanceId] || {}
    all[instanceId][key] = { size: meta.size, etag: meta.etag, at: Date.now() }
    store.set("manifests", all)
  }

  resetInstance(id) {
    const all = store.get("manifests") || {}
    delete all[id]
    store.set("manifests", all)
    this.scanNow()
  }

  // ---------- état ----------

  state() {
    const items = Array.from(this.items.values()).map((i) => ({
      key: i.key,
      instanceId: i.instanceId,
      filename: i.filename,
      relative: i.relative,
      status: i.status,
      received: i.received,
      total: i.total,
      percent: i.total > 0 ? Math.min(100, Math.floor((i.received / i.total) * 100)) : 0,
      speed: i.speed,
      attempts: i.attempts,
      error: i.error,
    }))
    const instances = this.instances().map((inst) => {
      const st = this.instanceStats.get(inst.id) || {}
      const own = items.filter((i) => i.instanceId === inst.id)
      return {
        ...inst,
        lastScanAt: st.lastScanAt || null,
        lastError: st.lastError || null,
        total: st.total || 0,
        synced: st.synced || 0,
        active: own.filter((i) => i.status === "downloading").length,
        queued: own.filter((i) => i.status === "queued").length,
        failed: own.filter((i) => i.status === "failed").length,
      }
    })
    const active = items.filter((i) => i.status === "downloading")
    return {
      paused: this.paused,
      scanning: this.scanning,
      registered: this.registered,
      authLost: this.authLost,
      serverError: this.serverError,
      agentLabel: store.get("agentLabel") || "",
      hostname: api.HOSTNAME,
      activeWorkers: this.workers.size,
      totalSpeed: active.reduce((s, i) => s + (i.speed || 0), 0),
      maxParallelFiles: this.setting("maxParallelFiles", 4),
      instances,
      items,
    }
  }

  emit() {
    this.onUpdate(this.state())
  }

  // ---------- cycle de vie ----------

  start() {
    this.authLost = false
    if (this.polling) return
    this.polling = true
    this.pollLoop()
  }

  // Arrêt (fermeture de l'app ou déconnexion). Les téléchargements en
  // cours sont interrompus PROPREMENT : on demande à chaque worker
  // d'annuler et on lui laisse jusqu'à `graceMs` pour fermer ses flux et
  // vider ses buffers disque, avant de le tuer. Les fichiers partiels
  // (.part / .chunks/part-N) restent en place : au prochain démarrage le
  // scan remet le fichier en file et le worker REPREND à l'octet où il
  // s'était arrêté (voir workers/downloadWorker.js) — les manifestes
  // (fichiers déjà terminés) sont persistés dans electron-store et ne sont
  // jamais perdus. Sur demande : "quand je me déconnecte de l'agent ou le
  // ferme, et le relance, il doit reprendre depuis l'endroit où il en est".
  async stop(graceMs = 1500) {
    this.polling = false
    clearTimeout(this.pollTimer)
    clearTimeout(this.wakeTimer)
    clearTimeout(this.flushTimer)
    const workers = Array.from(this.workers.entries()).filter(([, w]) => w)
    for (const [, w] of workers) {
      try {
        w.postMessage({ type: "cancel" })
      } catch {
        // ignore
      }
    }
    await Promise.all(
      workers.map(
        ([, w]) =>
          new Promise((resolve) => {
            const t = setTimeout(resolve, graceMs)
            w.once("exit", () => {
              clearTimeout(t)
              resolve()
            })
          })
      )
    )
    for (const k of Array.from(this.workers.keys())) this.terminateWorker(k)
    // Les items "downloading" repassent en attente pour l'état affiché
    // (ils seront de toute façon reconstruits au prochain scan).
    for (const item of this.items.values()) {
      if (item.status === "downloading") {
        item.status = "queued"
        item.speed = 0
      }
    }
    this.emit()
  }

  pause() {
    this.paused = true
    this.emit()
  }

  resume() {
    this.paused = false
    this.emit()
    this.dispatch()
  }

  retryFailed(instanceId = null) {
    for (const item of this.items.values()) {
      if (item.status === "failed" && (!instanceId || item.instanceId === instanceId)) {
        item.status = "queued"
        item.attempts = 0
        item.error = null
        item.nextAttemptAt = 0
      }
    }
    this.emit()
    this.dispatch()
  }

  scanNow() {
    clearTimeout(this.pollTimer)
    this.pollLoop()
  }

  // ---------- commandes reçues du B2B ----------

  runCommand(cmd) {
    const instanceId = cmd?.instance_id ? Number(cmd.instance_id) : null
    switch (cmd?.command) {
      case "pause":
        this.pause()
        break
      case "resume":
        this.resume()
        break
      case "scan":
        break // le scan suit juste après dans pollLoop
      case "retry":
        this.retryFailed(instanceId)
        break
      case "reset":
        if (instanceId) this.resetInstance(instanceId)
        break
      case "update":
        this.applyUpdate()
        break
      default:
        break
    }
  }

  // Mise à jour déclenchée à distance (commande B2B) — voir Engine.applyUpdate
  // pour les cas déclenchés depuis la fenêtre. `_updating` évite de relancer
  // le téléchargement si la commande revient avant que la précédente ait
  // fini (elle n'est retirée de pending_commands qu'une fois lue, mais on
  // ne veut pas non plus de doublon si l'admin clique deux fois).
  applyUpdate() {
    if (this._updating) return
    this._updating = true
    this.queueEvent({ type: "update_started", level: "info", message: "Mise à jour demandée." })
    require("./selfUpdater")
      .applyUpdate({ log: (level, message) => this.queueEvent({ type: level === "error" ? "update_failed" : "update_started", level, message }) })
      .then((r) => {
        this._updating = false
        if (r?.applied) {
          this.queueEvent({ type: "update_applied", level: "info", message: `Version ${r.version} installée.` })
          this.flushEvents().catch(() => {})
        }
        // r.applied avec restarting=true ou en mode session : le process
        // se termine lui-même juste après (voir selfUpdater) — pas besoin
        // de faire quoi que ce soit de plus ici.
      })
      .catch((err) => {
        this._updating = false
        this.queueEvent({ type: "update_failed", level: "error", message: `Mise à jour échouée : ${describe(err)}` })
        this.flushEvents().catch(() => {})
      })
  }

  // ---------- boucle ----------

  async pollLoop() {
    if (!this.polling) return
    clearTimeout(this.pollTimer)

    if (store.get("serverUrl") && store.get("token")) {
      if (!this.registered) await this.register()

      if (this.registered) {
        // 1. heartbeat + commandes
        try {
          const hb = await api.heartbeat(this.state())
          this.serverError = null
          for (const cmd of hb.commands || []) this.runCommand(cmd)
          // 2. config modifiée (depuis le B2B ou un autre écran) ?
          if (Number(hb.config_version || 0) !== this.configVersion) await this.refreshConfig()
        } catch (err) {
          this.serverError = describe(err)
          if (err?.response?.status === 404) this.registered = false
          if (err?.response?.status === 401) this.authLost = true
        }

        // 3. scans
        if (!this.paused && !this.scanning) {
          this.scanning = true
          this.emit()
          for (const inst of this.instances()) {
            if (!inst.enabled) continue
            await this.scanInstance(inst)
          }
          this.scanning = false
          this.emit()
          this.dispatch()
        }

        // 5. événements en attente
        await this.flushEvents()
      }
      this.emit()
    }

    const interval = Math.max(2000, this.setting("pollIntervalMs", 5000))
    this.pollTimer = setTimeout(() => this.pollLoop(), interval)
  }

  async scanInstance(inst) {
    const stats = this.instanceStats.get(inst.id) || {}
    try {
      const objects = await api.listAllObjects(inst.prefix)
      const manifest = this.manifest(inst.id)
      let synced = 0
      for (const o of objects) {
        const known = manifest[o.key]
        if (known && known.size === o.size && (!o.etag || !known.etag || known.etag === o.etag)) {
          synced++
          continue
        }
        const jobKey = `${inst.id}|${o.key}`
        const existing = this.items.get(jobKey)
        if (existing) {
          if (existing.status === "queued" || existing.status === "failed") {
            existing.size = o.size
            existing.etag = o.etag
          }
          continue
        }
        this.items.set(jobKey, {
          jobKey,
          instanceId: inst.id,
          key: o.key,
          relative: o.relative,
          filename: path.basename(o.key),
          size: o.size,
          etag: o.etag,
          status: "queued",
          received: 0,
          total: o.size,
          speed: 0,
          attempts: 0,
          error: null,
          nextAttemptAt: 0,
          startedAt: 0,
        })
      }
      this.reconcileRemoved(inst, manifest, objects)
      this.instanceStats.set(inst.id, { ...stats, lastScanAt: Date.now(), lastError: null, total: objects.length, synced })
    } catch (err) {
      const msg = describe(err)
      const prev = stats.lastError
      this.instanceStats.set(inst.id, { ...stats, lastError: msg })
      // Une erreur de scan n'est remontée qu'une fois par changement de
      // message (pas à chaque cycle de 5 s).
      if (prev !== msg) {
        this.queueEvent({ type: "scan_error", level: "error", instance_id: inst.id, message: msg })
      }
    }
    this.emit()
  }

  // Fichiers présents dans le manifeste (donc synchronisés par NOUS) mais
  // qui ont disparu du dossier S3 source. Deux comportements selon l'option
  // "deleteRemoved" de l'instance (réglable dans l'agent et le B2B) :
  //  - true  : suppression du fichier local (+ .part/.chunks résiduels) et
  //            des dossiers parents devenus vides, jusqu'au dossier de
  //            l'instance ; événement file_removed dans l'historique.
  //  - false : le fichier local est conservé ; on retire seulement l'entrée
  //            du manifeste pour qu'un retour du fichier dans S3 déclenche
  //            une nouvelle synchro.
  // Les fichiers déposés à la main dans le dossier local (jamais dans le
  // manifeste) ne sont jamais touchés.
  reconcileRemoved(inst, manifest, objects) {
    const present = new Set(objects.map((o) => o.key))
    const gone = Object.keys(manifest).filter((k) => !present.has(k))
    if (!gone.length) return
    const all = store.get("manifests") || {}
    const m = all[inst.id] || {}
    const prefix = inst.prefix.replace(/\/+$/, "") + "/"
    for (const key of gone) {
      delete m[key]
      if (!inst.deleteRemoved) continue
      const relative = key.startsWith(prefix) ? key.slice(prefix.length) : path.basename(key)
      const dest = path.join(inst.localDir, ...relative.split("/").filter(Boolean).map(sanitize))
      let removed = false
      for (const p of [dest, `${dest}.part`]) {
        try {
          fs.unlinkSync(p)
          removed = removed || p === dest
        } catch {
          // absent : rien à faire
        }
      }
      fs.rmSync(`${dest}.chunks`, { recursive: true, force: true })
      pruneEmptyDirs(path.dirname(dest), inst.localDir)
      this.queueEvent({
        type: "file_removed",
        level: "info",
        instance_id: inst.id,
        s3_key: key,
        message: removed ? `Supprimé localement (retiré de la source) : ${relative}` : `Retiré de la source (déjà absent localement) : ${relative}`,
        meta: { local_path: dest, order_id: orderIdFromKey(key) },
      })
    }
    all[inst.id] = m
    store.set("manifests", all)
  }

  // ---------- pool ----------

  dispatch() {
    if (this.paused) return
    const max = Math.max(1, this.setting("maxParallelFiles", 4))
    const now = Date.now()
    const enabled = new Set(this.instances().filter((i) => i.enabled).map((i) => i.id))
    for (const item of this.items.values()) {
      if (this.workers.size >= max) break
      if (item.status !== "queued") continue
      if (item.nextAttemptAt > now) continue
      if (!enabled.has(item.instanceId)) continue
      this.launch(item)
    }
    const waiting = Array.from(this.items.values()).filter((i) => i.status === "queued" && i.nextAttemptAt > now)
    if (waiting.length) {
      const nextWake = Math.min(...waiting.map((i) => i.nextAttemptAt))
      clearTimeout(this.wakeTimer)
      this.wakeTimer = setTimeout(() => this.dispatch(), nextWake - now + 50)
    }
  }

  async launch(item) {
    const inst = this.instances().find((i) => i.id === item.instanceId)
    if (!inst) {
      this.items.delete(item.jobKey)
      return
    }

    item.status = "downloading"
    item.error = null
    item.speed = 0
    item.attempts += 1
    item.startedAt = item.startedAt || Date.now()
    this.emit()

    this.workers.set(item.jobKey, null)

    let url
    try {
      url = await api.presignDownload(item.key)
    } catch (err) {
      this.workers.delete(item.jobKey)
      this.fail(item, describe(err, "Échec de la signature S3"), true)
      return
    }

    const destPath = path.join(inst.localDir, ...item.relative.split("/").filter(Boolean).map(sanitize))
    item.destPath = destPath

    const worker = new Worker(WORKER_PATH)
    this.workers.set(item.jobKey, worker)

    worker.on("message", (msg) => {
      if (msg.id !== item.jobKey) return
      if (msg.type === "progress") {
        item.received = msg.received
        item.total = msg.total || item.total
        item.speed = msg.speed
        this.emit()
      } else if (msg.type === "done") {
        this.finish(item)
      } else if (msg.type === "error") {
        this.fail(item, msg.message, msg.retryable && !msg.cancelled, msg.status)
      }
    })
    worker.on("error", (err) => this.fail(item, err?.message || "Worker crash", true))
    worker.on("exit", () => {
      if (this.workers.get(item.jobKey) === worker) this.workers.delete(item.jobKey)
      this.dispatch()
    })

    worker.postMessage({
      type: "start",
      job: {
        id: item.jobKey,
        url,
        destPath,
        chunkSizeBytes: this.setting("chunkSizeMb", 8) * 1024 * 1024,
        chunkThresholdBytes: this.setting("chunkThresholdMb", 16) * 1024 * 1024,
        maxParallelChunks: Math.max(1, this.setting("maxParallelChunks", 4)),
      },
    })
  }

  finish(item) {
    this.terminateWorker(item.jobKey)
    item.status = "done"
    item.speed = 0
    item.received = item.total
    this.markSynced(item.instanceId, item.key, { size: item.size, etag: item.etag })
    const st = this.instanceStats.get(item.instanceId)
    if (st) st.synced = (st.synced || 0) + 1

    // Historique + notification B2B ("fichier synchronisé"). order_id =
    // avant-dernier segment du chemin PrintWorkSpace/<machine>/<date>/
    // <type>/<client>/<commande>/<fichier> (voir buildPrintPath côté API2).
    this.queueEvent({
      type: "file_done",
      level: "info",
      instance_id: item.instanceId,
      s3_key: item.key,
      bytes: item.total,
      duration_ms: item.startedAt ? Date.now() - item.startedAt : null,
      message: `Synchronisé : ${item.relative}`,
      meta: { local_path: item.destPath, order_id: orderIdFromKey(item.key), attempts: item.attempts },
    })

    this.emit()
    setTimeout(() => {
      if (this.items.get(item.jobKey)?.status === "done") {
        this.items.delete(item.jobKey)
        this.emit()
      }
    }, 8000)
    this.dispatch()
  }

  fail(item, message, retryable, status = null) {
    this.terminateWorker(item.jobKey)
    item.speed = 0
    const max = Math.max(0, Number(this.settings().maxRetries ?? store.get("maxRetries") ?? 3))
    if (retryable && item.attempts <= max) {
      const delay = status === 403 ? 200 : Math.min(60000, 2000 * 2 ** (item.attempts - 1))
      item.status = "queued"
      item.error = `${message} — nouvelle tentative dans ${Math.round(delay / 1000)}s`
      item.nextAttemptAt = Date.now() + delay
    } else {
      item.status = "failed"
      item.error = message
      this.queueEvent({
        type: "file_failed",
        level: "error",
        instance_id: item.instanceId,
        s3_key: item.key,
        bytes: item.total,
        message,
        meta: { attempts: item.attempts, http_status: status, order_id: orderIdFromKey(item.key) },
      })
    }
    this.emit()
    this.dispatch()
  }

  terminateWorker(jobKey) {
    const w = this.workers.get(jobKey)
    this.workers.delete(jobKey)
    if (w) {
      try {
        w.postMessage({ type: "cancel" })
        w.terminate()
      } catch {
        // ignore
      }
    }
  }

  // ---------- événements → serveur ----------

  queueEvent(e) {
    this.eventQueue.push({ ...e, occurred_at: new Date().toISOString() })
    // Un fichier synchronisé doit apparaître vite dans la cloche du B2B :
    // on pousse sans attendre le prochain cycle (mais regroupé sur 1,5 s
    // pour les rafales).
    clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => this.flushEvents(), 1500)
  }

  async flushEvents() {
    if (!this.eventQueue.length || !this.registered) return
    const batch = this.eventQueue.splice(0, 200)
    try {
      await api.pushEvents(batch)
    } catch {
      // Réessayé au prochain cycle (on remet en tête de file, borné).
      this.eventQueue = batch.concat(this.eventQueue).slice(0, 1000)
    }
  }
}

function describe(err, fallback = "Erreur réseau") {
  const status = err?.response?.status
  if (status === 401) return "Session expirée — reconnectez-vous."
  if (status === 403) return err?.response?.data?.message || "Accès refusé."
  if (status === 404) return err?.response?.data?.message || "Endpoint introuvable (API2 à jour ?)."
  return err?.response?.data?.message || err?.message || fallback
}

function orderIdFromKey(key) {
  const parts = String(key || "").split("/").filter(Boolean)
  const seg = parts.length >= 2 ? parts[parts.length - 2] : ""
  return /^\d+$/.test(seg) ? Number(seg) : null
}

// Remonte depuis `dir` en supprimant les dossiers vides, sans jamais
// dépasser `root` (le dossier local de l'instance) ni le supprimer.
function pruneEmptyDirs(dir, root) {
  const stop = path.resolve(root)
  let cur = path.resolve(dir)
  while (cur.startsWith(stop) && cur !== stop) {
    try {
      if (fs.readdirSync(cur).length > 0) break
      fs.rmdirSync(cur)
    } catch {
      break
    }
    cur = path.dirname(cur)
  }
}

function sanitize(segment) {
  return String(segment || "_").replace(/[<>:"/\\|?* -]/g, "_")
}

module.exports = SyncManager
