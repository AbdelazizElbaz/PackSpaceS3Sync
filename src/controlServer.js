const http = require("http")
const crypto = require("crypto")
const fs = require("fs")
const path = require("path")

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
//
// Option `serveUi` (conteneur Docker / Synology, voir Dockerfile) : sert
// aussi l'interface de la fenêtre (renderer/) en pages web PUBLIQUES —
// index.html, renderer.js, styles.css + web-agent.js, un shim qui remplace
// le pont IPC Electron par des appels fetch vers cette API. Le jeton reste
// obligatoire pour toute donnée/action : les fichiers statiques n'en
// révèlent rien. Avec `bind` ≠ 127.0.0.1, l'API est joignable depuis le
// réseau : à protéger par le jeton (long) et le pare-feu du NAS.

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

const UI_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/renderer.js": ["renderer.js", "application/javascript; charset=utf-8"],
  "/web-agent.js": ["web-agent.js", "application/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
}

function serveUiFile(res, uiDir, urlPath) {
  const entry = UI_FILES[urlPath]
  if (!entry) return false
  let body
  try {
    body = fs.readFileSync(path.join(uiDir, entry[0]), "utf8")
  } catch {
    return false
  }
  if (entry[0] === "index.html") {
    // Le shim doit être chargé AVANT renderer.js (il définit window.agent).
    body = body.replace('<script src="renderer.js"></script>', '<script src="web-agent.js"></script>\n  <script src="renderer.js"></script>')
  }
  res.writeHead(200, { "Content-Type": entry[1], "Cache-Control": "no-cache" })
  res.end(body)
  return true
}

function startControlServer(engine, { port, token, version, hostname, bind = "127.0.0.1", serveUi = false, uiDir = null, log = () => {} }) {
  const startedAt = Date.now()
  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = (req.url || "/").split("?")[0]
      if (serveUi && uiDir && req.method === "GET" && serveUiFile(res, uiDir, urlPath)) return
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
    server.listen(port, bind, () => {
      server.off("error", reject)
      log("info", `API de contrôle sur http://${bind}:${port}${serveUi ? " (+ interface web)" : ""}`)
      resolve(server)
    })
  })
}

module.exports = { startControlServer }
