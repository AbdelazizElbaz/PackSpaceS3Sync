const axios = require("axios")
const os = require("os")
const store = require("./store")

// Identité du poste envoyée à API2 sur chaque appel "agent" (en-têtes
// X-Agent-Id + X-Agent-Host, voir DesktopSyncController::agentFor).
// AGENT_HOSTNAME : nom du poste affiché dans le B2B (utile en conteneur, où
// os.hostname() renvoie un identifiant Docker).
const HOSTNAME = (process.env.AGENT_HOSTNAME || "").trim() || os.hostname()

// Identifiant MACHINE stable (UUID généré une fois et persisté dans la
// config) : c'est lui, pas le compte connecté, qui identifie le poste côté
// API2 (DesktopSyncController::agentFor). Se déconnecter puis se reconnecter
// avec un autre compte retrouve donc le MÊME poste, ses instances et ses
// manifestes — sur demande : "déconnexion connexion ça crée une nouvelle
// session".
function machineId() {
  let id = store.get("machineId")
  if (!id) {
    id = require("crypto").randomUUID()
    store.set("machineId", id)
  }
  return id
}
const APP_VERSION = (() => {
  try {
    return require("../package.json").version
  } catch {
    return "0.0.0"
  }
})()

// Rôles Packspace autorisés à utiliser l'agent (miroir de
// DesktopFilesController::AGENT_RUNTIME_ROLES côté API2) : le compte DÉDIÉ
// "sync_agent" (créé depuis la page Synchronisation du B2B — usage
// recommandé) ou, à défaut, un compte administrateur/opérateur.
const AGENT_ROLES = ["sync_agent", "admin", "operator"]
// Rôles qui peuvent utiliser l'agent pour ENVOYER des fichiers (conception /
// montage) sur les commandes — sans synchronisation S3 (réservée à
// AGENT_ROLES) : un vendeur se connecte avec son compte habituel et
// travaille sur ses commandes ; admin/opérateur ont les deux.
const UPLOAD_ROLES = ["vendeur", "admin", "operator"]
const SYNC_ROLES = ["sync_agent", "admin", "operator"]

// Client HTTP vers l'API Packspace (Laravel API2). Le token 'desktop-agent'
// est rejoué sur chaque appel via Authorization: Bearer — l'agent est un
// client Sanctum comme le frontend web (ui/src/lib/api.js).
function client() {
  return axios.create({
    baseURL: normalizeServerUrl(store.get("serverUrl")),
    headers: {
      Authorization: `Bearer ${store.get("token")}`,
      Accept: "application/json",
      "X-Agent-Host": HOSTNAME,
      "X-Agent-Id": machineId(),
      ...tenantHeaders(),
    },
    timeout: 30000,
  })
}

// ---------- multi-client (PrintIOS) ----------
// Une seule API (api.printios.ma) sert tous les clients : chaque appel porte
// l'en-tête X-Tenant (ResolveTenant côté API2 : slug, ou hôte résolu via les
// sous-domaines / domaines propres). Sans valeur → aucun en-tête (API
// Packspace mono-client inchangée).
function tenantHeaders(tenant = store.get("tenant")) {
  const t = normalizeTenant(tenant)
  return t ? { "X-Tenant": t } : {}
}

// Saisie libre de l'utilisateur → valeur X-Tenant :
//   "packspace"                          → "packspace" (slug)
//   "packspace.printios.ma"              → hôte (sous-domaine ou domaine propre)
//   "https://om.printios.ma/t/packspace" → "packspace" (lien d'accès /t/<slug>)
//   "https://packspace.printios.ma/dashboard" → "packspace.printios.ma"
function normalizeTenant(input) {
  let t = String(input || "").trim().toLowerCase()
  if (!t) return ""
  if (/^https?:\/\//.test(t) || t.includes("/")) {
    try {
      const u = new URL(/^https?:\/\//.test(t) ? t : `https://${t}`)
      const m = u.pathname.match(/^\/t\/([a-z0-9-]+)(?:\/|$)/)
      t = m ? m[1] : u.hostname
    } catch {
      t = t.replace(/^https?:\/\//, "").split("/")[0]
    }
  }
  return t.replace(/[^a-z0-9.-]/g, "")
}

// API par défaut de la plateforme (PrintIOS). Surchargeable par variable
// d'environnement (build dédié) ou par l'installeur (a_<hôte>, voir main.js).
const DEFAULT_API_URL = (process.env.PRINTIOS_API_URL || "https://api.printios.ma").replace(/\/+$/, "")

// Déduit l'adresse de l'API à partir de la saisie « espace client » — sur
// demande : on n'affiche plus le champ API, il est déduit automatiquement.
//   "packspace"                          → API par défaut (api.printios.ma)
//   "packspace.printios.ma"              → https://api.printios.ma (api.<domaine parent>)
//   "https://om.printios.ma/t/packspace" → idem, espace = packspace
//   "om.packspace.ma" (domaine propre)   → https://api.om.packspace.ma (ancien Packspace
//                                          dédié), sinon API par défaut
// Chaque candidate est testée (GET /ping puis /tenancy/host) ; la première qui
// reconnaît l'espace gagne. `hint` = adresse imposée (champ avancé / installeur).
async function resolveServerForTenant(input, hint = "") {
  const t = normalizeTenant(input)
  if (!t) throw new Error("Indiquez votre espace client (ex. packspace ou packspace.printios.ma).")
  const candidates = []
  if (hint) candidates.push(normalizeServerUrl(hint))
  const raw = String(input || "").trim()
  const host = /^https?:\/\//.test(raw) || raw.includes("/") ? (() => { try { return new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).hostname } catch { return "" } })() : (t.includes(".") ? t : "")
  if (host) {
    const parts = host.split(".")
    if (parts.length >= 3) candidates.push(`https://api.${parts.slice(1).join(".")}/api`) // sous-domaine → api.<parent>
    candidates.push(`https://api.${host}/api`) // domaine propre → api.<domaine>
  }
  candidates.push(`${DEFAULT_API_URL}/api`)
  const tried = []
  for (const base of [...new Set(candidates)]) {
    try {
      const p = await axios.get(`${base}/ping`, { headers: { Accept: "application/json" }, timeout: 6000 })
      const data = p.data || {}
      if (!data.ok && !/API OK/i.test(String(data.message || ""))) { tried.push(`${base} : réponse inattendue`); continue }
      if (!data.tenancy) return { serverUrl: base, tenant: "", tenancy: false } // API dédiée mono-client
      const check = await checkTenant(base, t).catch(() => ({ found: false }))
      if (check?.found) {
        // Nom du magasin (GET /store-info, public) pour l'afficher avant la connexion.
        let name = null
        try {
          const si = await axios.get(`${base}/store-info`, { headers: { Accept: "application/json", "X-Tenant": t }, timeout: 6000 })
          name = si.data?.name || null
        } catch { name = null }
        return { serverUrl: base, tenant: t, tenancy: true, check, name }
      }
      tried.push(`${base} : espace « ${t} » inconnu`)
    } catch (err) {
      tried.push(`${base} : ${err?.message || "injoignable"}`)
    }
  }
  throw new Error(`Espace client « ${t} » introuvable. Essais : ${tried.join(" ; ")}`)
}

// Vérifie l'espace client auprès de l'API (GET /tenancy/host, public) :
// { found, slug, type } — found=false = espace inconnu.
async function checkTenant(serverUrl, tenant) {
  const base = normalizeServerUrl(serverUrl)
  const t = normalizeTenant(tenant)
  if (!t) return { found: false }
  const q = t.includes(".") ? { host: t } : { slug: t }
  const res = await axios.get(`${base}/tenancy/host`, { params: q, headers: { Accept: "application/json" }, timeout: 10000 })
  return res.data || { found: false }
}

// Étape 1 : connexion classique (POST /login) → token de session 12 jours.
// Étape 2 : avec ce token, on demande un token AGENT longue durée
// (POST /desktop/agent-token, 1 an, préservé par les reconnexions web —
// voir DesktopFilesController::agentToken). C'est CE token qu'on stocke.
// Le token de session intermédiaire n'est jamais persisté.
// Toutes les routes API2 sont sous /api (voir routes/api.php + RouteServiceProvider).
// On accepte que l'utilisateur saisisse l'hôte seul ("https://api.x.ma") ou
// avec le préfixe ("https://api.x.ma/api") : on normalise vers ".../api".
function normalizeServerUrl(input) {
  let u = String(input || "").trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`
  if (!/\/api$/i.test(u)) u = `${u}/api`
  return u
}

// Healthcheck GET /api/ping (public, voir routes/api.php). Renvoie
// { ok, app, time, desktop_api } — desktop_api >= 2 signifie que les
// endpoints agent-token / s3/browse / s3/objects sont déployés.
async function ping(serverUrl, tenant = "") {
  const base = normalizeServerUrl(serverUrl)
  const res = await axios.get(`${base}/ping`, { headers: { Accept: "application/json" }, timeout: 10000 })
  const data = res.data || {}
  // Ancien healthcheck d'API2 : {"message":"API OK"} sans `ok` ni
  // `desktop_api` → API Packspace reconnue, mais version à vérifier.
  const legacy = !data.ok && /API OK/i.test(String(data.message || ""))
  if (!data.ok && !legacy) throw new Error("Réponse inattendue : ce n'est pas une API PrintIOS.")
  const out = { ok: true, desktop_api: 0, ...data, serverUrl: base, legacy }
  // API multi-client : l'espace est obligatoire, et on le vérifie tout de suite.
  if (data.tenancy) {
    const t = normalizeTenant(tenant)
    out.tenant = t
    if (!t) out.tenantRequired = true
    else {
      try {
        out.tenantCheck = await checkTenant(base, t)
      } catch {
        out.tenantCheck = null // API sans /tenancy/host : vérifié à la connexion
      }
    }
  }
  return out
}

function tenantErrorMessage(tenant, apiMessage) {
  return normalizeTenant(tenant)
    ? `Espace client « ${normalizeTenant(tenant)} » inconnu sur cette API. ${apiMessage || ""}`.trim()
    : "Cette API est multi-client (PrintIOS) : indiquez votre espace client (ex. packspace ou packspace.printios.ma)."
}

async function login(serverUrl, logon, password, tenant = "") {
  const base = normalizeServerUrl(serverUrl)
  const th = tenantHeaders(tenant)

  // 1) COMPTE DE SERVICE de l'agent (Packspace → Synchronisation → « Comptes
  //    de l'agent ») : POST /desktop/agent/login renvoie directement le jeton
  //    longue durée. 401 = identifiants inconnus côté comptes de service → on
  //    retombe sur la connexion utilisateur (admin/opérateur) ci-dessous ;
  //    404/405 = API antérieure sans cet endpoint.
  try {
    const svc = await axios.post(
      `${base}/desktop/agent/login`,
      { logon, password },
      { headers: { Accept: "application/json", ...th }, timeout: 15000 }
    )
    if (svc.data?.success && svc.data?.data?.token) {
      return { ...svc.data.data, serverUrl: base }
    }
  } catch (err) {
    const status = err?.response?.status
    // 404 « Tenant inconnu » (API multi-client) : inutile de retenter.
    if (status === 404 && /tenant/i.test(String(err.response?.data?.message || ""))) {
      throw new Error(tenantErrorMessage(tenant, err.response.data.message))
    }
    if (status && status !== 401 && status !== 404 && status !== 405) {
      throw new Error(err.response?.data?.message || `Échec de connexion (${status})`)
    }
    // sinon : on tente le compte utilisateur
  }

  // 2) Compte utilisateur admin / opérateur (ancien flux)
  let res
  try {
    res = await axios.post(
      `${base}/login`,
      { logon, password },
      { headers: { Accept: "application/json", ...th }, timeout: 15000 }
    )
  } catch (err) {
    const status = err?.response?.status
    const msg = String(err?.response?.data?.message || "")
    if (status === 404 && /tenant/i.test(msg)) throw new Error(tenantErrorMessage(tenant, msg))
    if (status === 403 || status === 402) throw new Error(msg || `Accès refusé (${status})`)
    throw err
  }
  if (!res.data?.success) {
    throw new Error(res.data?.message || "Échec de connexion")
  }
  const session = res.data.data // { token, logon, first_name, last_name, role, ... }

  // Seuls le compte dédié sync_agent et les comptes admin / opérateur peuvent faire tourner l'agent
  // (même règle côté API2 : DesktopFilesController::AGENT_ROLES). On
  // refuse ici avec un message clair plutôt que de laisser
  // /desktop/agent-token répondre 403, et on révoque tout de suite la
  // session obtenue pour ne pas la laisser traîner.
  if (!AGENT_ROLES.includes(session.role) && !UPLOAD_ROLES.includes(session.role)) {
    axios
      .post(`${base}/logout`, {}, { headers: { Authorization: `Bearer ${session.token}`, ...th }, timeout: 5000 })
      .catch(() => {})
    throw new Error("Ce compte n'est pas autorisé : utilisez un compte de l'agent (PrintIOS → Synchronisation → « Comptes de l'agent »), un compte administrateur/opérateur, ou un compte vendeur (envoi de fichiers).")
  }

  // Vendeur : pas de jeton agent (réservé admin/opérateur côté API2), on
  // garde le jeton de session (12 jours) — mode « envoi de fichiers » seul.
  if (!SYNC_ROLES.includes(session.role)) {
    return { ...session, serverUrl: base, capabilities: { sync: false, upload: true } }
  }

  const agent = await axios.post(
    `${base}/desktop/agent-token`,
    {},
    {
      headers: { Accept: "application/json", Authorization: `Bearer ${session.token}`, ...th },
      timeout: 15000,
    }
  )
  if (!agent.data?.token) {
    throw new Error("Impossible d'obtenir le token agent (API2 à jour ?)")
  }

  return { ...session, token: agent.data.token, serverUrl: base, capabilities: { sync: true, upload: UPLOAD_ROLES.includes(session.role) } }
}

// ---------- envoi de fichiers sur une commande (conception / montage) ----------

// Détail d'une commande (articles, fichiers déjà attachés) — GET /orders/{id},
// scopé côté API2 (un vendeur ne voit que les commandes de son revendeur).
async function getOrder(orderId) {
  const res = await client().get(`/orders/${encodeURIComponent(orderId)}`)
  const o = res.data || {}
  const resellerName = `${o.reseller?.user?.first_name || ""} ${o.reseller?.user?.last_name || ""}`.trim()
  return {
    id: o.id,
    stat: o.stat,
    reseller: resellerName,
    notes: o.notes || "",
    date: o.date || o.created_at,
    items: (o.items || []).map((it) => ({
      id: it.id,
      name: it.product_type_name || it.name || `Article ${it.id}`,
      category: it.product_category_name || "",
      quantity: it.quantity,
      print_file: it.printfile?.original_filename || it.printfile?.filename || null,
      design_file: it.designfile?.original_filename || it.designfile?.filename || null,
    })),
  }
}

// md5 hexadécimal d'un fichier (flux, sans le charger en mémoire).
function md5File(filePath) {
  return new Promise((resolve, reject) => {
    const h = require("crypto").createHash("md5")
    require("fs").createReadStream(filePath).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject)
  })
}

// Envoi multipart d'un fichier local vers S3 via API2 (initMultipart /
// signPart / completeMultipart — même flux que le front, voir
// ui/src/features/uploads/multipartUpload.js) puis rattachement à l'article :
//   kind = "design" → POST orders/{o}/items/{i}/design-file (fichier de conception)
//   kind = "print"  → POST orders/{o}/items/{i}/file        (fichier de montage / impression)
async function uploadItemFile({ orderId, itemId, filePath, kind, onProgress, chunkSize = 10 * 1024 * 1024, concurrency = 4 }) {
  const fs = require("fs")
  const path = require("path")
  const mime = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".tif": "image/tiff", ".tiff": "image/tiff", ".ai": "application/postscript", ".eps": "application/postscript", ".psd": "image/vnd.adobe.photoshop", ".svg": "image/svg+xml", ".zip": "application/zip", ".cdr": "application/cdr" }
  const name = path.basename(filePath)
  const size = fs.statSync(filePath).size
  const contentType = mime[path.extname(name).toLowerCase()] || "application/octet-stream"
  const c = client()

  const init = await c.post("/s3file/initMultipart", { filename: name, contentType, size })
  const { uploadId, key } = init.data || {}
  if (!uploadId || !key) throw new Error("Init multipart : réponse invalide")

  const total = Math.max(1, Math.ceil(size / chunkSize))
  const parts = new Array(total)
  const done = new Array(total).fill(0)
  const report = () => onProgress?.({ bytes: done.reduce((a, b) => a + b, 0), size })
  const fd = fs.openSync(filePath, "r")
  try {
    let next = 0
    const worker = async () => {
      while (next < total) {
        const index = next++
        const start = index * chunkSize
        const len = Math.min(chunkSize, size - start)
        const buf = Buffer.alloc(len)
        fs.readSync(fd, buf, 0, len, start)
        let lastErr
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const sign = await c.post("/s3file/signPart", { uploadId, partNumber: index + 1, key })
            const put = await axios.put(sign.data.url, buf, { headers: { "Content-Type": contentType }, timeout: 0, maxBodyLength: Infinity })
            const etag = String(put.headers.etag || put.headers.ETag || "").replace(/"/g, "")
            if (!etag) throw new Error(`ETag manquant (partie ${index + 1})`)
            parts[index] = { ETag: etag, PartNumber: index + 1 }
            done[index] = len
            report()
            lastErr = null
            break
          } catch (err) {
            lastErr = err
            await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)))
          }
        }
        if (lastErr) throw lastErr
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker))
  } finally {
    fs.closeSync(fd)
  }

  const complete = await c.post("/s3file/completeMultipart", { uploadId, key, parts, filename: name })
  const s3key = complete.data?.key
  if (!s3key) throw new Error("Finalisation multipart : réponse invalide")

  // Copie locale : le fichier reste sur ce poste → déclaré à l'API (clé
  // complète + nom de base renvoyé par completeMultipart) avec son md5, pour
  // que l'agent d'impression le récupère sur le LAN (voir peerServer.js).
  try {
    const checksum = await md5File(filePath)
    const keys = [String(key).replace(/^\/+/, ""), String(s3key).replace(/^\/+/, "")]
    require("./peerServer").rememberLocalCopy(keys, filePath, size, checksum)
    await declareLocalCopy({ keys, localPath: filePath, size, checksum })
  } catch (err) {
    // optimisation seulement : jamais bloquant
    void err
  }

  const attach = kind === "design"
    ? await c.post(`/orders/${orderId}/items/${itemId}/design-file`, { design_file: s3key, design_file_original_name: name, design_filesize: size, design_filecontenttype: contentType })
    : await c.post(`/orders/${orderId}/items/${itemId}/file`, { print_file: s3key, print_file_original_name: name, print_filesize: size, print_filecontenttype: contentType })
  return { ok: true, name, size, kind, data: attach.data }
}

// Fichiers d'impression prêts, pas encore acquittés — scopés côté backend
// par reseller pour un reseller/vendeur, tous pour le staff.
async function fetchPendingFiles(limit = 100) {
  const res = await client().get("/desktop/print-files", { params: { limit } })
  return Array.isArray(res.data) ? res.data : []
}

// URL S3 présignée (GET uniquement, ~20 min). Le téléchargement des octets
// se fait ensuite en direct vers S3/CloudFront depuis le worker, pas via
// Laravel.
async function presignDownload(s3Key) {
  const res = await client().post("/s3file/presignDownload", { filename: s3Key, expires: 20 })
  if (!res.data?.url) throw new Error("Pas d'URL présignée renvoyée")
  return res.data.url
}

// Acquittement : le fichier ne sera plus renvoyé par les prochains polls.
async function ackFile(fileId) {
  await client().post(`/desktop/print-files/${fileId}/ack`)
}

// Un niveau de l'arborescence d'impression S3 (PrintProd/...) :
// { root, prefix, folders:[{name,prefix}], files:[{key,name,size,etag,last_modified}] }
async function browse(prefix = "") {
  const res = await client().get("/desktop/s3/browse", { params: { prefix } })
  return res.data
}

// Listing récursif complet sous un préfixe (suit la pagination) :
// [{ key, relative, size, etag, last_modified }]
async function listAllObjects(prefix, maxPages = 50) {
  const out = []
  let token = null
  let pages = 0
  do {
    const res = await client().get("/desktop/s3/objects", { params: { prefix, token: token || undefined } })
    for (const o of res.data?.objects || []) out.push(o)
    token = res.data?.next_token || null
    pages++
  } while (token && pages < maxPages)
  return out
}

// ---------- pilotage centralisé (DesktopSyncController) ----------

// Enregistre le poste (ou le retrouve) et récupère la config serveur :
// { agent_id, label, settings, instances:[{id,name,prefix,localDir,enabled}], config_version }.
// `localInstances` = instances locales existantes, importées UNIQUEMENT si
// le poste est nouveau côté serveur (migration depuis electron-store).
async function registerAgent(localInstances = [], localSettings = {}) {
  const peer = require("./peerServer")
  const res = await client().post("/desktop/agent/register", {
    machine_id: machineId(),
    hostname: HOSTNAME,
    platform: process.platform,
    app_version: APP_VERSION,
    lan_host: peer.lanAddress(),
    lan_port: peer.peerPort(),
    instances: localInstances,
    settings: localSettings,
  })
  if (res.data?.peer_token) store.set("peerToken", res.data.peer_token)
  return res.data
}

// ---------- copies locales (partage LAN entre agents) ----------

// Déclare à l'API qu'un fichier envoyé existe sur ce poste (clé S3 + alias).
async function declareLocalCopy({ keys, localPath, size, checksum }) {
  const [s3_key, ...aliases] = keys
  const res = await client().post("/desktop/local-copies", { s3_key, aliases, local_path: localPath, size, checksum })
  return res.data
}

// Qui possède déjà ce fichier ? [{self, local_path, lan_host, lan_port, peer_token, online, size, checksum}]
async function lookupLocalCopies(key) {
  const res = await client().get("/desktop/local-copies", { params: { key }, timeout: 8000 })
  return res.data?.copies || []
}

async function fetchAgentConfig() {
  const res = await client().get("/desktop/agent/config")
  return res.data
}

// Instantané d'avancement → serveur ; renvoie { commands:[{command,instance_id}], config_version }.
async function heartbeat(status) {
  const peer = require("./peerServer")
  const res = await client().post("/desktop/agent/heartbeat", { status, app_version: APP_VERSION, lan_host: peer.lanAddress(), lan_port: peer.peerPort() })
  return res.data
}

// Déclare la fin de session (tray "Quitter") — best effort, timeout court.
async function agentOffline() {
  try {
    await client().post("/desktop/agent/offline", {}, { timeout: 4000 })
  } catch {
    // ignore
  }
}

async function pushEvents(events) {
  if (!events.length) return { stored: 0 }
  const res = await client().post("/desktop/agent/events", { events })
  return res.data
}

// Réglages de parallélisme → serveur (même endpoint que le B2B).
async function updateAgentSettings(agentId, settings) {
  const res = await client().patch(`/desktop/sync/agents/${agentId}`, { settings })
  return res.data
}

// CRUD instances — mêmes endpoints que le B2B, le serveur vérifie via
// X-Agent-Host que l'agent ne touche que son propre poste.
async function createInstance(agentId, payload) {
  const res = await client().post(`/desktop/sync/agents/${agentId}/instances`, payload)
  return res.data
}
async function updateInstance(id, patch) {
  const res = await client().patch(`/desktop/sync/instances/${id}`, patch)
  return res.data
}
async function deleteInstance(id) {
  await client().delete(`/desktop/sync/instances/${id}`)
}

// Dernière version publiée (installeurs présignés 1 h, voir
// DesktopSyncController::releases()) — même endpoint que la carte de
// téléchargement du B2B ; l'agent y a accès avec son propre jeton (rôle
// admin/operator). { available, version, assets:[{os,arch,kind,name,size,url}] }
async function fetchLatestRelease() {
  // Endpoint PUBLIC (GET /desktop/agent/release) : la mise à jour doit
  // fonctionner même déconnecté (écran de connexion, jeton expiré) — seule
  // l'adresse du serveur (et l'espace client) est nécessaire. Repli sur
  // l'ancien endpoint authentifié pour une API2 antérieure.
  const base = normalizeServerUrl(store.get("serverUrl"))
  try {
    const res = await axios.get(`${base}/desktop/agent/release`, {
      // X-Agent-Id : limite de débit PAR POSTE côté API (et non par IP du magasin)
      headers: { Accept: "application/json", "X-Agent-Id": machineId(), "X-Agent-Host": HOSTNAME, ...tenantHeaders() },
      timeout: 15000,
    })
    return res.data
  } catch (err) {
    if (err?.response?.status !== 404 || !store.get("token")) throw err
    const res = await client().get("/desktop/sync/releases")
    return res.data
  }
}

// Vérifie que le token stocké est encore valide (GET /me) — utilisé au
// démarrage pour afficher "reconnexion nécessaire" plutôt que de laisser
// le poll échouer silencieusement en 401.
async function whoami() {
  const res = await client().get("/me")
  return res.data?.user || null
}

module.exports = {
  HOSTNAME,
  machineId,
  APP_VERSION,
  normalizeServerUrl,
  normalizeTenant,
  tenantHeaders,
  checkTenant,
  resolveServerForTenant,
  DEFAULT_API_URL,
  ping,
  login,
  getOrder,
  uploadItemFile,
  declareLocalCopy,
  lookupLocalCopies,
  md5File,
  SYNC_ROLES,
  UPLOAD_ROLES,
  fetchPendingFiles,
  presignDownload,
  ackFile,
  whoami,
  browse,
  listAllObjects,
  registerAgent,
  fetchAgentConfig,
  fetchLatestRelease,
  heartbeat,
  pushEvents,
  agentOffline,
  updateAgentSettings,
  createInstance,
  updateInstance,
  deleteInstance,
}
