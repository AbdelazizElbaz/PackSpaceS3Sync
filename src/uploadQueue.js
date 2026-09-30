// File d'ENVOI des fichiers d'articles (mode utilisateur) — processus principal.
//
// L'utilisateur peut lancer plusieurs envois à la suite sans attendre : chaque
// demande devient un job dans la file, `MAX_PARALLEL` fichiers partent en
// même temps (chacun en multipart, 4 morceaux en parallèle — voir
// api.uploadItemFile), les autres attendent. Un job échoué est réessayé
// (`MAX_ATTEMPTS`, délai croissant) puis reste en erreur avec un bouton
// « Réessayer ». La file est PERSISTÉE (config `uploadQueue`) : après un
// redémarrage de l'agent, les envois non terminés repartent du début du
// fichier (le fichier doit toujours exister sur le poste). L'état complet est
// poussé à la fenêtre (upload:queue) à chaque changement.
const path = require("path")
const fs = require("fs")
const api = require("./api")
const store = require("./store")

const MAX_PARALLEL = 2
const MAX_ATTEMPTS = 3
const KEEP_DONE = 50 // jobs terminés conservés dans la liste

class UploadQueue {
  constructor({ onChange = () => {}, log = () => {} } = {}) {
    this.onChange = onChange
    this.log = log
    this.jobs = new Map()
    this.running = 0
    this.suspended = false // true après une déconnexion, jusqu'à la reconnexion
    this.seq = Date.now()
    // Reprise des jobs non terminés du lancement précédent.
    for (const j of store.get("uploadQueue") || []) {
      if (!j || !j.id) continue
      const job = { ...j, bytes: 0, speed: 0 }
      if (job.status === "uploading" || job.status === "queued") job.status = "queued"
      this.jobs.set(job.id, job)
    }
    this.persist()
    setTimeout(() => this.pump(), 1500)
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }

  emit() {
    this.persist()
    try { this.onChange(this.list()) } catch { /* ignore */ }
  }

  persist() {
    const keep = this.list().filter((j) => j.status !== "done" || true).slice(0, 200)
    store.set("uploadQueue", keep.map(({ bytes, speed, ...j }) => j))
  }

  enqueue({ orderId, itemId, kind, filePath }) {
    const st = fs.statSync(filePath)
    const id = `u${(this.seq++).toString(36)}`
    const job = {
      id, orderId: Number(orderId), itemId: Number(itemId), kind,
      filePath, name: path.basename(filePath), size: st.size,
      status: "queued", bytes: 0, speed: 0, attempts: 0, error: null,
      createdAt: Date.now(), finishedAt: null,
    }
    this.jobs.set(id, job)
    this.trimDone()
    this.emit()
    this.pump()
    return job
  }

  retry(id) {
    const job = this.jobs.get(id)
    if (!job || job.status === "uploading") return
    job.status = "queued"; job.error = null; job.attempts = 0; job.bytes = 0
    this.emit(); this.pump()
  }

  remove(id) {
    const job = this.jobs.get(id)
    if (!job || job.status === "uploading") return
    this.jobs.delete(id)
    this.emit()
  }

  clearDone() {
    for (const [id, j] of this.jobs) if (j.status === "done") this.jobs.delete(id)
    this.emit()
  }

  // Déconnexion : on vide la file (envois en attente, en erreur ou terminés)
  // et on la suspend. Un envoi déjà en cours ne peut pas être interrompu
  // proprement : il est marqué « annulé » et son résultat sera ignoré.
  cancelAll() {
    this.suspended = true
    for (const [id, j] of this.jobs) {
      if (j.status === "uploading") j.cancelled = true
      else this.jobs.delete(id)
    }
    this.emit()
  }

  // Reconnexion : la file reprend (nouveaux envois du compte connecté).
  resume() {
    this.suspended = false
    this.pump()
  }

  trimDone() {
    const done = this.list().filter((j) => j.status === "done")
    for (const j of done.slice(KEEP_DONE)) this.jobs.delete(j.id)
  }

  pump() {
    while (!this.suspended && this.running < MAX_PARALLEL) {
      const next = this.list().reverse().find((j) => j.status === "queued")
      if (!next) break
      this.run(next)
    }
  }

  // Job annulé par une déconnexion pendant l'envoi : retiré de la liste.
  dropIfCancelled(job) {
    if (!job.cancelled) return false
    this.jobs.delete(job.id)
    this.running--
    this.emit()
    return true
  }

  async run(job) {
    this.running++
    job.status = "uploading"; job.error = null; job.attempts++
    job.startedAt = Date.now()
    this.emit()
    let lastBytes = 0, lastAt = Date.now()
    try {
      if (!fs.existsSync(job.filePath)) throw new Error("Fichier introuvable sur ce poste (déplacé ou supprimé).")
      const out = await api.uploadItemFile({
        orderId: job.orderId, itemId: job.itemId, filePath: job.filePath, kind: job.kind,
        onProgress: ({ bytes, size }) => {
          const now = Date.now()
          if (now - lastAt >= 300) { job.speed = Math.round(((bytes - lastBytes) / (now - lastAt)) * 1000); lastBytes = bytes; lastAt = now }
          job.bytes = bytes; job.size = size || job.size
          this.emit()
        },
      })
      if (this.dropIfCancelled(job)) return
      job.status = "done"; job.bytes = job.size; job.speed = 0; job.finishedAt = Date.now(); job.result = { name: out.name }
      this.log("info", `Fichier ${job.kind === "design" ? "de conception" : "de montage"} envoyé : commande ${job.orderId}, article ${job.itemId}, ${job.name}`)
    } catch (err) {
      if (this.dropIfCancelled(job)) return
      const status = err?.response?.status
      const message = err?.response?.data?.message || err?.message || "Échec de l'envoi"
      const retryable = !status || status >= 500 || status === 408 || status === 429
      if (retryable && job.attempts < MAX_ATTEMPTS) {
        job.status = "queued"; job.error = `${message} — nouvelle tentative…`
        const delay = 2000 * 2 ** (job.attempts - 1)
        this.running--
        this.emit()
        setTimeout(() => this.pump(), delay)
        return
      }
      job.status = "error"; job.error = message; job.speed = 0; job.finishedAt = Date.now()
      this.log("error", `Envoi échoué (commande ${job.orderId}, article ${job.itemId}, ${job.name}) : ${message}`)
    }
    this.running--
    this.emit()
    this.pump()
  }
}

module.exports = { UploadQueue, MAX_PARALLEL }
