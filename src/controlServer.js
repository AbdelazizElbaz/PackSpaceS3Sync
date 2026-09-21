const http = require("http")
const crypto = require("crypto")

// API de contrôle locale du service (mode "service", voir service.js).
//
// Le moteur tourne dans un processus système sans session ouverte ; la
// fenêtre Electron lancée par l'utilisateur n'est alors qu'un CLIENT qui
// pilote ce processus via HTTP sur 127.0.0.1 uniquement (jamais exposé sur
// le réseau). Toutes les requêtes exigent le jeton de contrôle
// (`Authorization: Bearer <controlToken>`) partagé au moment de
// l'installation : sans lui, n'importe quel programme local pourrait
// ajouter une instance et faire écrire le service (root/SYSTEM) n'importe
// où.
//
//   GET  /health        → { ok, mode:"service", version, hostname, pid, uptime }
//   GET  /state         → état de synchro (identique à engine.getState())
//   POST /rpc           → { method, args } → { result } | { error }
//                        (method ∈ Engine.METHODS)

const MAX_BODY = 1024 * 1024

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ""))
  const bb = Buffer.from(String(b || ""))
  return ab.length === bb.length && ab.length > 0 && crypto.timingSafeEqual(ab, bb)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on("data", (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error("Corps trop volumineux"))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch {
        reject(new Error("JSON invalide"))
      }
    })
    req.on("error", reject)
  })
}

function send(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  })
  res.end(data)
}

function startControlServer(engine, { port, token, version, hostname, log = () => {} }) {
  const startedAt = Date.now()
  const server = http.createServer(async (req, res) => {
    try {
      const auth = req.headers.authorization || ""
      const presented = auth.startsWith("Bearer ") ? auth.slice(7) : ""
      if (!safeEqual(presented, token)) {
        return send(res, 401, { error: "Jeton de contrôle invalide" })
      }
      if (req.method === "GET" && req.url === "/health") {
        return send(res, 200, {
          ok: true,
          mode: "service",
          version,
          hostname,
          pid: process.pid,
          uptime: Math.round((Date.now() - startedAt) / 1000),
        })
      }
      if (req.method === "GET" && req.url === "/state") {
        return send(res, 200, engine.getState())
      }
      if (req.method === "POST" && req.url === "/rpc") {
        const { method, args } = await readJson(req)
        try {
          const result = await engine.call(method, args || [])
          return send(res, 200, { result: result === undefined ? null : result })
        } catch (err) {
          const message = err?.response?.data?.message || err?.message || "Erreur"
          log("warn", `rpc ${method} → ${message}`)
          return send(res, 400, { error: message })
        }
      }
      send(res, 404, { error: "Introuvable" })
    } catch (err) {
      send(res, 500, { error: err?.message || "Erreur" })
    }
  })
  server.keepAliveTimeout = 5000
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject)
      log("info", `API de contrôle sur http://127.0.0.1:${port}`)
      resolve(server)
    })
  })
}

module.exports = { startControlServer }
