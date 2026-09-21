const $ = (id) => document.getElementById(id)

const SETTINGS = ["maxParallelFiles", "maxParallelChunks", "chunkSizeMb", "chunkThresholdMb", "maxRetries"]

let currentPrefix = "" // dossier S3 affiché dans l'explorateur ("" = racine PrintProd)
let currentRoot = "PrintProd/PrintWorkSpace"
let lastState = { items: [], instances: [] }

// ---------- helpers ----------

function fmtBytes(n) {
  if (!n) return "0 o"
  if (n < 1024) return `${n} o`
  if (n < 1048576) return `${(n / 1024).toFixed(0)} Ko`
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} Mo`
  return `${(n / 1073741824).toFixed(2)} Go`
}
const fmtSpeed = (bps) => (bps ? `${fmtBytes(bps)}/s` : "")
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString() : "—")
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
}
const label = (s) =>
  ({ queued: "En attente", downloading: "Téléchargement", done: "Terminé", failed: "Échec" }[s] || s)

// ---------- explorateur S3 ----------

async function loadBrowse(prefix = currentPrefix) {
  const list = $("browseList")
  const err = $("browseError")
  err.textContent = ""
  list.innerHTML = '<p class="empty">Chargement…</p>'
  try {
    const data = await window.agent.browse(prefix)
    currentRoot = data.root || "PrintProd/PrintWorkSpace"
    currentPrefix = data.prefix || currentRoot
    renderCrumbs()
    renderBrowse(data)
  } catch (e) {
    err.textContent = e?.message || "Impossible de lister le dossier."
    list.innerHTML = ""
  }
}

function renderCrumbs() {
  const parts = currentPrefix.split("/").filter(Boolean)
  const html = parts
    .map((p, i) => {
      const target = parts.slice(0, i + 1).join("/")
      const last = i === parts.length - 1
      return last
        ? `<span class="crumb current">${esc(p)}</span>`
        : `<a class="crumb" data-prefix="${esc(target)}">${esc(p)}</a><span class="sep">/</span>`
    })
    .join("")
  $("crumbs").innerHTML = html
  $("crumbs").querySelectorAll("a.crumb").forEach((a) => a.addEventListener("click", () => loadBrowse(a.dataset.prefix)))
}

function renderBrowse(data) {
  const list = $("browseList")
  const synced = syncedPrefixes()
  const rows = []
  for (const f of data.folders || []) {
    const isSynced = synced.has(f.prefix)
    rows.push(
      `<div class="brow folder" data-prefix="${esc(f.prefix)}">
        <span class="ico">📁</span><span class="bname">${esc(f.name)}</span>
        ${isSynced ? '<span class="badge">synchronisé</span>' : ""}
      </div>`
    )
  }
  for (const f of data.files || []) {
    rows.push(
      `<div class="brow file">
        <span class="ico">📄</span><span class="bname" title="${esc(f.key)}">${esc(f.name)}</span>
        <span class="bsize">${fmtBytes(f.size)}</span>
      </div>`
    )
  }
  list.innerHTML = rows.length ? rows.join("") : '<p class="empty">Dossier vide.</p>'
  list.querySelectorAll(".brow.folder").forEach((el) => el.addEventListener("dblclick", () => loadBrowse(el.dataset.prefix)))
  list.querySelectorAll(".brow.folder").forEach((el) => el.addEventListener("click", () => loadBrowse(el.dataset.prefix)))
}

function syncedPrefixes() {
  return new Set((lastState.instances || []).map((i) => i.prefix))
}

// ---------- instances ----------

function renderInstances(state) {
  const box = $("instances")
  const list = state.instances || []
  if (!list.length) {
    box.innerHTML = '<p class="empty">Aucune instance. Choisissez un dossier à gauche puis « Synchroniser ce dossier… ».</p>'
    return
  }
  box.innerHTML = list
    .map((i) => {
      const pct = i.total > 0 ? Math.floor((i.synced / i.total) * 100) : 0
      const status = i.lastError
        ? `<span class="err">${esc(i.lastError)}</span>`
        : !i.enabled
        ? '<span class="muted">désactivée</span>'
        : i.active > 0
        ? `<span class="live">${i.active} en cours</span>`
        : i.queued > 0
        ? `<span class="muted">${i.queued} en attente</span>`
        : `<span class="ok">à jour</span>`
      return `
      <div class="inst ${i.enabled ? "" : "off"}">
        <div class="inst-head">
          <div class="inst-title">
            <strong>${esc(i.name)}</strong>
            <span class="muted mono">${esc(i.prefix)}</span>
          </div>
          <div class="inst-actions">
            <button class="small" data-act="toggle" data-id="${i.id}">${i.enabled ? "Désactiver" : "Activer"}</button>
            <button class="small" data-act="open" data-id="${i.id}">Dossier</button>
            <button class="small" data-act="retry" data-id="${i.id}" ${i.failed ? "" : "disabled"}>Réessayer (${i.failed})</button>
            <button class="small ghost" data-act="reset" data-id="${i.id}" title="Re-vérifier tous les fichiers">Re-vérifier</button>
            <button class="small danger" data-act="remove" data-id="${i.id}">Supprimer</button>
          </div>
        </div>
        <div class="track"><div class="fill" style="width:${pct}%"></div></div>
        <div class="inst-meta">
          <span>${i.synced}/${i.total} fichiers synchronisés</span>
          <span>${status}</span>
          <span class="muted">→ ${esc(i.localDir)}</span>
          <span class="muted">vérifié ${fmtTime(i.lastScanAt)}</span>
        </div>
      </div>`
    })
    .join("")

  box.querySelectorAll("button[data-act]").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = b.dataset.id
      const inst = list.find((x) => x.id === id)
      switch (b.dataset.act) {
        case "toggle":
          await window.agent.updateInstance(id, { enabled: !inst.enabled })
          break
        case "open":
          await window.agent.openInstanceFolder(id)
          break
        case "retry":
          await window.agent.retryFailed(id)
          break
        case "reset":
          await window.agent.resetInstance(id)
          break
        case "remove":
          if (confirm(`Supprimer l'instance « ${inst.name} » ? Les fichiers déjà téléchargés restent sur le disque.`)) {
            await window.agent.removeInstance(id)
          }
          break
      }
    })
  )
}

// ---------- fichiers en cours ----------

function renderFiles(state) {
  const items = state.items || []
  const active = items.filter((i) => i.status === "downloading")
  const totalSpeed = active.reduce((s, i) => s + (i.speed || 0), 0)
  $("summary").textContent = items.length
    ? `${active.length}/${state.maxParallelFiles} threads actifs · ${items.filter((i) => i.status === "queued").length} en attente · ${fmtSpeed(totalSpeed)}`
    : ""
  $("globalStatus").textContent = state.paused
    ? "⏸ en pause"
    : state.scanning
    ? "⟳ vérification…"
    : active.length
    ? `⬇ ${fmtSpeed(totalSpeed)}`
    : ""
  $("pauseBtn").textContent = state.paused ? "Reprendre" : "Pause"

  const list = $("list")
  if (!items.length) {
    list.innerHTML = '<p class="empty">Aucun fichier en cours.</p>'
    return
  }
  const order = { downloading: 0, queued: 1, failed: 2, done: 3 }
  items.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.key.localeCompare(b.key))
  const instName = Object.fromEntries((state.instances || []).map((i) => [i.id, i.name]))

  list.innerHTML = items
    .map((d) => {
      const meta =
        d.status === "downloading"
          ? `${d.percent}% · ${fmtBytes(d.received)} / ${fmtBytes(d.total)} · ${fmtSpeed(d.speed)}`
          : d.status === "failed" || (d.status === "queued" && d.error)
          ? d.error
          : d.status === "queued"
          ? fmtBytes(d.total)
          : label(d.status)
      return `
        <div class="item ${d.status}">
          <div class="name" title="${esc(d.key)}">
            ${esc(d.relative || d.filename)}
            <span class="tag">${esc(instName[d.instanceId] || "")}</span>
          </div>
          <div class="track"><div class="fill" style="width:${d.status === "done" ? 100 : d.percent || 0}%"></div></div>
          <div class="meta"><span>${label(d.status)}${d.attempts > 1 ? ` (essai ${d.attempts})` : ""}</span><span>${esc(meta)}</span></div>
        </div>`
    })
    .join("")
}

function render(state) {
  if (!state) return
  const prev = syncedPrefixes()
  lastState = state
  renderInstances(state)
  renderFiles(state)
  // Les badges "synchronisé" de l'explorateur dépendent des instances.
  const now = syncedPrefixes()
  if (prev.size !== now.size) loadBrowse().catch(() => {})
}

// ---------- config / login ----------

async function refreshConfig() {
  const c = await window.agent.getConfig()
  if (c.isLoggedIn) {
    $("loginView").classList.add("hidden")
    $("mainView").classList.remove("hidden")
    $("userLabel").textContent = c.userLabel || ""
    $("autoLaunchToggle").checked = !!c.autoLaunch
    for (const k of SETTINGS) $(k).value = c[k]
    $("pollIntervalSec").value = Math.round((c.pollIntervalMs || 5000) / 1000)
    loadBrowse("")
  } else {
    $("loginView").classList.remove("hidden")
    $("mainView").classList.add("hidden")
    $("userLabel").textContent = ""
    if (c.serverUrl) $("serverUrl").value = c.serverUrl
  }
}

$("pingBtn").addEventListener("click", async () => {
  const out = $("pingResult")
  out.className = "hint"
  out.textContent = "Test en cours…"
  try {
    const r = await window.agent.ping($("serverUrl").value.trim())
    const recent = Number(r.desktop_api || 0) >= 2
    out.className = recent ? "hint ok" : "hint err"
    out.textContent = recent
      ? `OK — ${r.app || "API"} répond sur ${r.serverUrl}`
      : `L'API répond (${r.serverUrl}) mais sans les endpoints de synchro S3 : redéployer API2.`
  } catch (e) {
    out.className = "hint err"
    out.textContent = e?.message || "Échec du test."
  }
})

$("loginBtn").addEventListener("click", async () => {
  const err = $("loginError")
  err.textContent = ""
  const serverUrl = $("serverUrl").value.trim()
  const logon = $("logon").value.trim()
  const password = $("password").value
  if (!serverUrl || !logon || !password) {
    err.textContent = "Tous les champs sont obligatoires."
    return
  }
  const btn = $("loginBtn")
  btn.disabled = true
  btn.textContent = "Connexion…"
  try {
    await window.agent.login({ serverUrl, logon, password })
    $("password").value = ""
    await refreshConfig()
  } catch (e) {
    err.textContent = e?.message || "Échec de connexion."
  } finally {
    btn.disabled = false
    btn.textContent = "Se connecter"
  }
})

$("logoutBtn").addEventListener("click", async () => {
  await window.agent.logout()
  await refreshConfig()
})

// ---------- explorateur : actions ----------

$("refreshBrowseBtn").addEventListener("click", () => loadBrowse())

$("createInstanceBtn").addEventListener("click", () => {
  $("instPrefix").value = currentPrefix
  $("instName").value = currentPrefix.split("/").filter(Boolean).slice(-2).join(" / ")
  $("instLocalDir").value = ""
  $("instError").textContent = ""
  $("instanceDialog").classList.remove("hidden")
})
$("instChooseDirBtn").addEventListener("click", async () => {
  const dir = await window.agent.chooseDir()
  if (dir) $("instLocalDir").value = dir
})
$("instCancelBtn").addEventListener("click", () => $("instanceDialog").classList.add("hidden"))
$("instSaveBtn").addEventListener("click", async () => {
  const prefix = $("instPrefix").value
  const name = $("instName").value.trim()
  const localDir = $("instLocalDir").value
  if (!localDir) {
    $("instError").textContent = "Choisissez un dossier local de destination."
    return
  }
  if ((lastState.instances || []).some((i) => i.prefix === prefix)) {
    $("instError").textContent = "Ce dossier S3 est déjà synchronisé par une autre instance."
    return
  }
  await window.agent.addInstance({ name, prefix, localDir })
  $("instanceDialog").classList.add("hidden")
})

// ---------- réglages ----------

$("settingsBtn").addEventListener("click", () => $("settingsDialog").classList.remove("hidden"))
$("settingsCloseBtn").addEventListener("click", () => $("settingsDialog").classList.add("hidden"))
$("saveSettingsBtn").addEventListener("click", async () => {
  const partial = {}
  for (const k of SETTINGS) partial[k] = Number($(k).value)
  partial.pollIntervalMs = Number($("pollIntervalSec").value) * 1000
  await window.agent.setSettings(partial)
  $("settingsDialog").classList.add("hidden")
})
$("autoLaunchToggle").addEventListener("change", (e) => window.agent.setAutoLaunch(e.target.checked))

// ---------- synchro : actions globales ----------

$("scanNowBtn").addEventListener("click", () => window.agent.scanNow())
$("pauseBtn").addEventListener("click", async () => {
  if (lastState.paused) await window.agent.resume()
  else await window.agent.pause()
})

// ---------- init ----------

window.agent.onStateUpdate(render)
refreshConfig()
window.agent.getState().then(render)
