const http = require("http")

// Client de l'API de contrôle du service (voir controlServer.js). Utilisé
// par la fenêtre Electron en mode "service" : chaque action de l'interface
// devient un appel `call(method, args)` vers le processus système.

class ControlClient {
  constructor({ port, token }) {
    this.port = port
    this.token = token
    this.agent = new http.Agent({ keepAlive: true, maxSockets: 4 })
  }

  request(method, path, body, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
      const req = http.request(
        {
          host: "127.0.0.1",
          port: this.port,
          method,
          path,
          agent: this.agent,
          timeout: timeoutMs,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
            ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}),
          },
        },
        (res) => {
          const chunks = []
          res.on("data", (c) => chunks.push(c))
          res.on("end", () => {
            let parsed = null
            try {
              parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null
            } catch {
              parsed = null
            }
            if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed)
            const err = new Error(parsed?.error || `Service : HTTP ${res.statusCode}`)
            err.status = res.statusCode
            reject(err)
          })
        }
      )
      req.on("timeout", () => req.destroy(new Error("Le service ne répond pas (délai dépassé)")))
      req.on("error", (e) => {
        if (e.code === "ECONNREFUSED") e.message = "Service injoignable (arrêté ou non installé)"
        reject(e)
      })
      if (data) req.write(data)
      req.end()
    })
  }

  health(timeoutMs = 1500) {
    return this.request("GET", "/health", undefined, timeoutMs)
  }

  state() {
    return this.request("GET", "/state")
  }

  async call(method, args = [], timeoutMs = 60000) {
    const out = await this.request("POST", "/rpc", { method, args }, timeoutMs)
    return out ? out.result : null
  }
}

module.exports = ControlClient
