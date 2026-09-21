// Worker thread : télécharge UN fichier depuis une URL S3 présignée vers
// un chemin local, en morceaux (requêtes HTTP Range) parallèles, avec
// reprise des morceaux partiellement reçus. Un worker = un fichier à la
// fois ; le pool (syncManager.js) en lance N en parallèle.
//
// Pourquoi un vrai thread plutôt que de la simple concurrence async sur le
// thread principal d'Electron ? Le téléchargement est I/O-bound, mais la
// concaténation des morceaux, les écritures disque et le calcul de
// progression de 4+ fichiers × 4 chunks saturaient l'event loop du main
// process et faisaient saccader l'UI/tray. Ici chaque fichier a sa propre
// event loop ; le main process ne fait que recevoir des messages.
//
// Protocole (parentPort) :
//   → { type: "start", job: { id, url, destPath, chunkSizeBytes,
//                             chunkThresholdBytes, maxParallelChunks } }
//   ← { type: "progress", id, received, total, speed }
//   ← { type: "done", id }
//   ← { type: "error", id, message, retryable }
//   → { type: "cancel" }  (best-effort : les streams en cours sont détruits)

const { parentPort } = require("worker_threads")
const fs = require("fs")
const path = require("path")
const axios = require("axios")

const SPEED_SAMPLE_MS = 300

let current = null // { id, cancelled, streams: Set }

function post(msg) {
  parentPort.postMessage(msg)
}

function isRetryable(err) {
  // Erreurs réseau transitoires ou 5xx S3 : on laisse le pool retenter.
  // 403 = URL présignée expirée → le pool doit RE-présigner, donc
  // retryable aussi. 404 = clé S3 absente → définitif.
  const status = err?.response?.status
  if (status === 404) return false
  if (status && status >= 400 && status < 500 && status !== 403 && status !== 408 && status !== 429) return false
  return true
}

// Taille réelle via Range bytes=0-0 (un HEAD échouerait : l'URL n'est
// signée que pour GET). S3 répond 206 + Content-Range: bytes 0-0/TOTAL.
async function getRemoteSize(url) {
  const res = await axios.get(url, {
    headers: { Range: "bytes=0-0" },
    responseType: "arraybuffer",
    timeout: 20000,
  })
  const contentRange = res.headers["content-range"]
  if (contentRange) {
    const total = Number(contentRange.split("/")[1])
    if (!Number.isNaN(total) && total > 0) return { size: total, supportsRange: true }
  }
  return { size: Number(res.headers["content-length"] || 0), supportsRange: false }
}

function makeProgressReporter(id, total, getReceived) {
  let windowStart = Date.now()
  let windowBytes = 0
  let lastEmit = 0
  return (bytesJustReceived, force = false) => {
    windowBytes += bytesJustReceived
    const now = Date.now()
    const elapsed = now - windowStart
    if (force || elapsed >= SPEED_SAMPLE_MS) {
      const speed = elapsed > 0 ? Math.round((windowBytes / elapsed) * 1000) : 0
      windowBytes = 0
      windowStart = now
      if (force || now - lastEmit >= SPEED_SAMPLE_MS) {
        lastEmit = now
        post({ type: "progress", id, received: getReceived(), total, speed })
      }
    }
  }
}

async function streamToFile(url, rangeHeader, filePath, appendFrom, onData) {
  const headers = rangeHeader ? { Range: rangeHeader } : {}
  const res = await axios.get(url, { headers, responseType: "stream", timeout: 0 })
  if (rangeHeader && res.status !== 206) {
    // Le serveur a ignoré le Range et renvoie tout le fichier : on ne peut
    // pas "reprendre", on repart à zéro sur ce morceau.
    appendFrom = 0
  }
  const writer = fs.createWriteStream(filePath, { flags: appendFrom > 0 ? "a" : "w" })
  current.streams.add(res.data)
  try {
    await new Promise((resolve, reject) => {
      res.data.on("data", (buf) => onData(buf.length))
      res.data.on("error", reject)
      writer.on("error", reject)
      writer.on("finish", resolve)
      res.data.pipe(writer)
    })
  } finally {
    current.streams.delete(res.data)
  }
}

async function downloadSingle(job, url, size) {
  const tmpPath = `${job.destPath}.part`
  // Reprise : si un .part existe déjà, on reprend à son offset.
  let already = 0
  try {
    already = fs.statSync(tmpPath).size
  } catch {
    already = 0
  }
  if (size > 0 && already >= size) {
    fs.renameSync(tmpPath, job.destPath)
    return
  }
  let received = already
  const report = makeProgressReporter(job.id, size, () => received)
  report(0, true)
  const range = already > 0 && size > 0 ? `bytes=${already}-` : null
  await streamToFile(url, range, tmpPath, already, (n) => {
    received += n
    report(n)
  })
  report(0, true)
  fs.renameSync(tmpPath, job.destPath)
}

async function downloadChunked(job, url, totalSize) {
  const chunkSize = job.chunkSizeBytes
  const chunkCount = Math.ceil(totalSize / chunkSize)
  const chunksDir = `${job.destPath}.chunks`
  fs.mkdirSync(chunksDir, { recursive: true })

  const chunks = []
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize
    const end = Math.min(start + chunkSize - 1, totalSize - 1)
    const p = path.join(chunksDir, `part-${String(i).padStart(5, "0")}`)
    let have = 0
    try {
      have = fs.statSync(p).size
    } catch {
      have = 0
    }
    const expected = end - start + 1
    if (have > expected) have = 0 // fichier corrompu : on refait ce morceau
    chunks.push({ index: i, start, end, expected, path: p, received: have })
  }

  const report = makeProgressReporter(
    job.id,
    totalSize,
    () => chunks.reduce((s, c) => s + c.received, 0)
  )
  report(0, true)

  // Pool de chunks à l'intérieur du fichier : maxParallelChunks requêtes
  // Range simultanées sur la même URL (S3 le supporte très bien).
  const queue = chunks.filter((c) => c.received < c.expected)
  const workers = Array.from({ length: Math.min(job.maxParallelChunks, queue.length) }, async () => {
    while (queue.length && !current.cancelled) {
      const chunk = queue.shift()
      const from = chunk.start + chunk.received
      if (chunk.received > 0 && chunk.received > chunk.expected) chunk.received = 0
      await streamToFile(url, `bytes=${from}-${chunk.end}`, chunk.path, chunk.received, (n) => {
        chunk.received += n
        report(n)
      })
      if (chunk.received !== chunk.expected) {
        throw Object.assign(new Error(`Morceau ${chunk.index} incomplet (${chunk.received}/${chunk.expected})`), {
          retryable: true,
        })
      }
    }
  })
  await Promise.all(workers)
  if (current.cancelled) throw Object.assign(new Error("Annulé"), { retryable: false, cancelled: true })
  report(0, true)

  // Concaténation dans l'ordre vers un .part, puis rename atomique.
  const tmpFinal = `${job.destPath}.part`
  const out = fs.createWriteStream(tmpFinal)
  for (const chunk of chunks) {
    await new Promise((resolve, reject) => {
      const r = fs.createReadStream(chunk.path)
      r.on("error", reject)
      r.on("end", resolve)
      r.pipe(out, { end: false })
    })
  }
  await new Promise((resolve, reject) => {
    out.on("error", reject)
    out.on("finish", resolve)
    out.end()
  })
  fs.renameSync(tmpFinal, job.destPath)
  fs.rmSync(chunksDir, { recursive: true, force: true })
}

async function run(job) {
  current = { id: job.id, cancelled: false, streams: new Set() }
  try {
    fs.mkdirSync(path.dirname(job.destPath), { recursive: true })
    const { size, supportsRange } = await getRemoteSize(job.url)

    // Déjà complet sur disque (ex : ack API2 échoué au tour précédent, ou
    // redémarrage juste après le rename) → rien à re-télécharger.
    try {
      const st = fs.statSync(job.destPath)
      if (size > 0 && st.size === size) {
        post({ type: "progress", id: job.id, received: size, total: size, speed: 0 })
        post({ type: "done", id: job.id })
        return
      }
    } catch {
      // absent : téléchargement normal
    }

    if (supportsRange && size > job.chunkThresholdBytes) {
      await downloadChunked(job, job.url, size)
    } else {
      await downloadSingle(job, job.url, size)
    }
    post({ type: "done", id: job.id })
  } catch (err) {
    post({
      type: "error",
      id: job.id,
      message: err?.message || "Erreur de téléchargement",
      status: err?.response?.status || null,
      retryable: err?.retryable !== undefined ? err.retryable : isRetryable(err),
      cancelled: !!err?.cancelled,
    })
  } finally {
    current = null
  }
}

parentPort.on("message", (msg) => {
  if (msg?.type === "start") {
    run(msg.job)
  } else if (msg?.type === "cancel" && current) {
    current.cancelled = true
    for (const s of current.streams) {
      try {
        s.destroy(new Error("Annulé"))
      } catch {
        // ignore
      }
    }
  }
})
