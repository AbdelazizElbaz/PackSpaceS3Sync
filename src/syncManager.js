const path = require("path")
const fs = require("fs")
const { Worker } = require("worker_threads")
const store = require("./store")
const { listAllObjects, presignDownload } = require("./api")

// Orchestrateur des INSTANCES DE SYNCHRONISATION.
//
// Une instance = un dossier S3 sous PrintProd (préfixe) → un dossier local.
// À chaque cycle, chaque instance active liste récursivement son préfixe
// (GET /desktop/s3/objects via API2) et compare avec son manifeste local
// (clé → {size, etag}). Tout objet nouveau ou modifié (etag/size différent)
// est mis en file et dispatché vers un pool de N worker threads
// (workers/downloadWorker.js, un fichier par thread) qui télécharge en
// direct depuis S3 (URL présignée par API2), en morceaux parallèles avec
// reprise. Une fois le fichier écrit sur disque (rename final), la clé est
// inscrite dans le manifeste → elle n'est plus re-téléchargée.
//
// Les manifestes sont persistés (electron-store) : au redémarrage on ne
// re-télécharge pas tout ; un fichier présent localement avec la bonne
// taille est aussi reconnu par le worker ("déjà complet").

const WORKER_PATH = path.join(__dirname, "workers", "downloadWorker.js")

class SyncManager {
  constructor(onUpdate) {
    this.onUpdate = onUpdate || (() => {})
    this.items = new Map() // jobKey (instanceId + "|" + s3Key) -> item
    this.workers = new Map() // jobKey -> Worker
    this.instanceStats = new Map() // instanceId -> { lastScanAt, lastError, total, synced, pending }
    this.polling = false
    this.paused = false
    this.pollTimer = null
    this.wakeTimer = null
    this.scanning = false
  }

  // ---------- instances (persistées) ----------

  instances() {
    return store.get("instances") || []
  }

  saveInstances(list) {
    store.set("instances", list)
  }

  addInstance({ name, prefix, localDir }) {
    const list = this.instances()
    const id = `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    list.push({
      id,
      name: name || path.basename(prefix),
      prefix: String(prefix).replace(/^\/+|\/+$/g, ""),
      localDir,
      enabled: true,
      createdAt: Date.now(),
    })
    this.saveInstances(list)
    this.emit()
    this.scanNow()
    return id
  }

  updateInstance(id, patch) {
    const list = this.instances().map((i) => (i.id === id ? { ...i, ...patch, id } : i))
    this.saveInstances(list)
    this.emit()
    this.scanNow()
  }

  removeInstance(id) {
    this.saveInstances(this.instances().filter((i) => i.id !== id))
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
    this.emit()
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

  // Force une re-vérification complète d'une instance (oublie le manifeste).
  // Les fichiers déjà présents localement à la bonne taille ne seront pas
  // re-téléchargés (détection "déjà complet" dans le worker).
  resetInstance(id) {
    const all = store.get("manifests") || {}
    delete all[id]
    store.set("manifests", all)
    this.scanNow()
  }

  // ---------- état exposé au renderer ----------

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
    return {
      paused: this.paused,
      scanning: this.scanning,
      activeWorkers: this.workers.size,
      maxParallelFiles: store.get("maxParallelFiles"),
      instances,
      items,
    }
  }

  emit() {
    this.onUpdate(this.state())
  }

  // ---------- cycle de vie ----------

  start() {
    if (this.polling) return
    this.polling = true
    this.pollLoop()
  }

  stop() {
    this.polling = false
    clearTimeout(this.pollTimer)
    clearTimeout(this.wakeTimer)
    for (const k of Array.from(this.workers.keys())) this.terminateWorker(k)
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

  // ---------- scan des instances ----------

  async pollLoop() {
    if (!this.polling) return
    clearTimeout(this.pollTimer)
    if (store.get("serverUrl") && store.get("token") && !this.paused && !this.scanning) {
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
    const interval = Math.max(1000, Number(store.get("pollIntervalMs")) || 5000)
    this.pollTimer = setTimeout(() => this.pollLoop(), interval)
  }

  async scanInstance(inst) {
    const stats = this.instanceStats.get(inst.id) || {}
    try {
      const objects = await listAllObjects(inst.prefix)
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
          // Déjà en file/en cours. Si l'objet a changé entre-temps
          // (nouvel etag) et n'est pas en cours, on rafraîchit ses métadonnées.
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
        })
      }
      this.instanceStats.set(inst.id, {
        ...stats,
        lastScanAt: Date.now(),
        lastError: null,
        total: objects.length,
        synced,
      })
    } catch (err) {
      const status = err?.response?.status
      this.instanceStats.set(inst.id, {
        ...stats,
        lastError:
          status === 401
            ? "Session expirée — reconnectez-vous."
            : status === 403
            ? "Accès refusé à ce dossier."
            : err?.response?.data?.message || err?.message || "Erreur réseau",
      })
    }
    this.emit()
  }

  // ---------- pool ----------

  dispatch() {
    if (this.paused) return
    const max = Math.max(1, Number(store.get("maxParallelFiles")) || 1)
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
    this.emit()

    // Slot réservé de façon synchrone avant l'await presign — sinon
    // dispatch() pourrait lancer max+1 fichiers pendant l'attente.
    this.workers.set(item.jobKey, null)

    let url
    try {
      url = await presignDownload(item.key)
    } catch (err) {
      this.workers.delete(item.jobKey)
      this.fail(item, err?.response?.data?.message || err?.message || "Échec de la signature S3", true)
      return
    }

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
        // Arborescence S3 relative reproduite sous le dossier local, chaque
        // segment assaini pour Windows/macOS/Linux.
        destPath: path.join(inst.localDir, ...item.relative.split("/").filter(Boolean).map(sanitize)),
        chunkSizeBytes: mb(store.get("chunkSizeMb"), 8),
        chunkThresholdBytes: mb(store.get("chunkThresholdMb"), 16),
        maxParallelChunks: Math.max(1, Number(store.get("maxParallelChunks")) || 4),
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
    const max = Math.max(0, Number(store.get("maxRetries")) || 0)
    if (retryable && item.attempts <= max) {
      // 403 = URL présignée expirée → nouvelle signature quasi immédiate,
      // sinon backoff exponentiel 2s, 4s, 8s… plafonné à 60s.
      const delay = status === 403 ? 200 : Math.min(60000, 2000 * 2 ** (item.attempts - 1))
      item.status = "queued"
      item.error = `${message} — nouvelle tentative dans ${Math.round(delay / 1000)}s`
      item.nextAttemptAt = Date.now() + delay
    } else {
      item.status = "failed"
      item.error = message
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
}

function mb(value, fallback) {
  const n = Number(value)
  return (n > 0 ? n : fallback) * 1024 * 1024
}

function sanitize(segment) {
  return String(segment || "_").replace(/[<>:"/\\|?* -]/g, "_")
}

module.exports = SyncManager
