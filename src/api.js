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
// DesktopFilesController::AGENT_ROLES côté API2).
const AGENT_ROLES = ["admin", "operator"]

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
    },
    timeout: 30000,
  })
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
async function ping(serverUrl) {
  const base = normalizeServerUrl(serverUrl)
  const res = await axios.get(`${base}/ping`, { headers: { Accept: "application/json" }, timeout: 10000 })
  const data = res.data || {}
  // Ancien healthcheck d'API2 : {"message":"API OK"} sans `ok` ni
  // `desktop_api` → API Packspace reconnue, mais version à vérifier.
  const legacy = !data.ok && /API OK/i.test(String(data.message || ""))
  if (!data.ok && !legacy) throw new Error("Réponse inattendue : ce n'est pas une API Packspace.")
  return { ok: true, desktop_api: 0, ...data, serverUrl: base, legacy }
}

async function login(serverUrl, logon, password) {
  const base = normalizeServerUrl(serverUrl)
  const res = await axios.post(
    `${base}/login`,
    { logon, password },
    { headers: { Accept: "application/json" }, timeout: 15000 }
  )
  if (!res.data?.success) {
    throw new Error(res.data?.message || "Échec de connexion")
  }
  const session = res.data.data // { token, logon, first_name, last_name, role, ... }

  // Seuls les comptes admin / opérateur peuvent faire tourner l'agent
  // (même règle côté API2 : DesktopFilesController::AGENT_ROLES). On
  // refuse ici avec un message clair plutôt que de laisser
  // /desktop/agent-token répondre 403, et on révoque tout de suite la
  // session obtenue pour ne pas la laisser traîner.
  if (!AGENT_ROLES.includes(session.role)) {
    axios
      .post(`${base}/logout`, {}, { headers: { Authorization: `Bearer ${session.token}` }, timeout: 5000 })
      .catch(() => {})
    throw new Error("Ce compte n'est pas autorisé : utilisez un compte administrateur ou opérateur.")
  }

  const agent = await axios.post(
    `${base}/desktop/agent-token`,
    {},
    {
      headers: { Accept: "application/json", Authorization: `Bearer ${session.token}` },
      timeout: 15000,
    }
  )
  if (!agent.data?.token) {
    throw new Error("Impossible d'obtenir le token agent (API2 à jour ?)")
  }

  return { ...session, token: agent.data.token, serverUrl: base }
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
  const res = await client().post("/desktop/agent/register", {
    machine_id: machineId(),
    hostname: HOSTNAME,
    platform: process.platform,
    app_version: APP_VERSION,
    instances: localInstances,
    settings: localSettings,
  })
  return res.data
}

async function fetchAgentConfig() {
  const res = await client().get("/desktop/agent/config")
  return res.data
}

// Instantané d'avancement → serveur ; renvoie { commands:[{command,instance_id}], config_version }.
async function heartbeat(status) {
  const res = await client().post("/desktop/agent/heartbeat", { status, app_version: APP_VERSION })
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
  ping,
  login,
  fetchPendingFiles,
  presignDownload,
  ackFile,
  whoami,
  browse,
  listAllObjects,
  registerAgent,
  fetchAgentConfig,
  heartbeat,
  pushEvents,
  agentOffline,
  updateAgentSettings,
  createInstance,
  updateInstance,
  deleteInstance,
}
