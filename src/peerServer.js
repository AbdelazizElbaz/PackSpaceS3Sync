// Serveur PAIR de l'agent : sert sur le réseau local les fichiers que CE
// poste a envoyés vers S3 (panneau « Envoyer des fichiers ») aux autres
// agents du magasin, pour qu'ils les copient sur le LAN au lieu de les
// re-télécharger depuis S3 (voir API2 FileLocalCopyController et
// workers/downloadWorker.js → fetchFromPeer).
//
// Sécurité : écoute sur toutes les interfaces (0.0.0.0) mais ne sert QUE les
// fichiers déclarés (store "localCopies" : clé S3 → chemin), jamais un chemin
// arbitraire, et exige le jeton pair (`peer_token`) que l'API remet à
// l'agent à l'enregistrement — un demandeur ne l'obtient qu'auprès de l'API,
// donc authentifié sur le même tenant. Aucune écriture, aucun listing.
//
//   GET /peer/file?key=<clé S3>      Authorization: Bearer <peer_token>
//     → 200 + octets (Content-Length, X-Checksum md5), 404 si inconnu/absent
//   GET /peer/ping                    → { ok, hostname, version }
const http = require("http")
const fs = require("fs")
const os = require("os")
const store = require("./store")

// Port 443 par défaut (demande explicite : passe les pare-feu d'atelier sans
// règle particulière) ; s'il est déjà pris (IIS, VPN, Skype…) ou interdit,
// repli sur 47832. Le port RÉELLEMENT écouté est publié à l'API
// (lan_port, voir api.js registerAgent/heartbeat) pour que les autres
// agents s'adressent au bon port. Réglable : store "peerPort".
const PEER_PORT = 443
const PEER_FALLBACK_PORT = 47832
let listeningPort = null

// Port effectivement en écoute (null si le serveur pair n'a pas démarré).
function peerPort() {
  return listeningPort || Number(store.get("peerPort")) || PEER_PORT
}

// Première IPv4 non interne (celle vue par les autres PC du magasin).
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === "IPv4" && !i.internal && !String(i.address).startsWith("169.254.")) return i.address
    }
  }
  return null
}

// Mémorise (config) qu'un fichier envoyé existe localement sous <clé S3>.
function rememberLocalCopy(keys, filePath, size, checksum) {
  const all = store.get("localCopies") || {}
  for (const k of keys) all[String(k).replace(/^\/+/, "")] = { path: filePath, size, checksum, at: Date.now() }
  // borne : 500 entrées les plus récentes
  const entries = Object.entries(all).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 500)
  store.set("localCopies", Object.fromEntries(entries))
}

function localCopyFor(key) {
  const all = store.get("localCopies") || {}
  return all[String(key || "").replace(/^\/+/, "")] || null
}

function startPeerServer({ port = Number(store.get("peerPort")) || PEER_PORT, token, version = "", hostname = "", log = () => {} } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x")
    if (req.method === "GET" && url.pathname === "/peer/ping") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true, hostname, version }))
      return
    }
    if (req.method !== "GET" || url.pathname !== "/peer/file") {
      res.writeHead(404); res.end(); return
    }
    const auth = String(req.headers.authorization || "")
    const t = (typeof token === "function" ? token() : token) || ""
    if (!t || auth !== `Bearer ${t}`) {
      res.writeHead(401); res.end(); return
    }
    const copy = localCopyFor(url.searchParams.get("key"))
    if (!copy) { res.writeHead(404); res.end(); return }
    let st
    try { st = fs.statSync(copy.path) } catch { res.writeHead(404); res.end(); return }
    if (copy.size && st.size !== copy.size) { res.writeHead(409); res.end(); return } // modifié depuis l'envoi
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": st.size,
      "X-Checksum": copy.checksum || "",
      "Cache-Control": "no-store",
    })
    const stream = fs.createReadStream(copy.path)
    stream.on("error", () => { try { res.destroy() } catch { /* ignore */ } })
    stream.pipe(res)
    log("info", `Fichier servi au pair ${req.socket.remoteAddress} : ${url.searchParams.get("key")}`)
  })
  let tried = 0
  const listen = (p) => {
    tried++
    server.listen(p, "0.0.0.0")
  }
  server.on("error", (err) => {
    // 443 occupé (EADDRINUSE) ou interdit (EACCES) → repli une seule fois.
    if (tried === 1 && port !== PEER_FALLBACK_PORT && ["EADDRINUSE", "EACCES"].includes(err.code)) {
      log("warn", `Port ${port} indisponible (${err.code}) : repli sur ${PEER_FALLBACK_PORT}`)
      setTimeout(() => listen(PEER_FALLBACK_PORT), 100)
      return
    }
    listeningPort = null
    log("warn", `Serveur pair indisponible (${err.message})`)
  })
  server.on("listening", () => {
    listeningPort = server.address().port
    log("info", `Serveur pair LAN en écoute sur ${lanAddress() || "?"}:${listeningPort}`)
  })
  listen(port)
  return server
}

module.exports = { PEER_PORT, PEER_FALLBACK_PORT, peerPort, lanAddress, rememberLocalCopy, localCopyFor, startPeerServer }
