const $ = (id) => document.getElementById(id)

const SETTINGS = ["maxParallelFiles", "maxParallelChunks", "chunkSizeMb", "chunkThresholdMb", "maxRetries", "failedRetryDelayMin"]

let currentPrefix = "" // dossier S3 affiché dans l'explorateur ("" = racine PrintProd)
let currentRoot = "PrintProd/PrintWorkSpace"
let lastState = { items: [], instances: [] }

// ---------- helpers ----------

// Message d'erreur lisible : Electron préfixe les erreurs IPC par
// « Error invoking remote method 'auth:ping': Error: … » — retiré, et les
// codes HTTP traduits (503 = serveur indisponible, etc.).
function errMsg(e, fallback = "Erreur") {
  let m = String(e?.message || e || fallback)
  m = m.replace(/^Error invoking remote method '[^']*':\s*/i, "").replace(/^Error:\s*/i, "")
  const code = /status code (\d{3})/i.exec(m)?.[1]
  if (code) {
    const known = { 401: "identifiants refusés", 403: "accès refusé", 404: "espace ou service introuvable", 429: "trop de tentatives, réessayez dans une minute", 500: "erreur du serveur", 502: "serveur injoignable (502)", 503: "service indisponible pour le moment (503)", 504: "serveur trop lent (504)" }
    m = known[code] ? `${known[code]}` : m
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|Network Error/i.test(m)) m = "Connexion impossible : vérifiez le réseau et l'espace client."
  return m
}

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
    err.textContent = errMsg(e, "Impossible de lister le dossier.")
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
            <label class="toggle-del" title="Supprimer localement les fichiers retirés de la source S3"><input type="checkbox" data-act="delrm" data-id="${i.id}" ${i.deleteRemoved ? "checked" : ""}/> Suppr. source</label>
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

  box.querySelectorAll("input[data-act='delrm']").forEach((c) =>
    c.addEventListener("change", async () => {
      try {
        await window.agent.updateInstance(Number(c.dataset.id), { deleteRemoved: c.checked })
      } catch (e) {
        alert(errMsg(e, "Impossible de modifier l'option."))
        c.checked = !c.checked
      }
    })
  )
  box.querySelectorAll("button[data-act]").forEach((b) =>
    b.addEventListener("click", async () => {
      // Les ids d'instances viennent du serveur (nombres) ; dataset est une chaîne.
      const id = Number(b.dataset.id)
      const inst = list.find((x) => Number(x.id) === id)
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
  $("globalStatus").textContent = state.serverError
    ? `⚠ ${state.serverError}`
    : state.paused
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

// Fenêtre de progression de la mise à jour (state.updateProgress, alimenté
// par selfUpdater.js en mode session comme en mode service).
const fmtMb = (b) => `${(Number(b || 0) / 1048576).toFixed(1)} Mo`
function renderUpdateProgress(p) {
  const dlg = $("updateProgressDialog")
  if (!dlg) return
  if (!p || (!p.active && p.phase !== "error" && p.phase !== "restart")) {
    dlg.classList.add("hidden")
    return
  }
  dlg.classList.remove("hidden")
  const bar = $("updateProgressBar")
  const closeBtn = $("updateProgressCloseBtn")
  closeBtn.classList.add("hidden")
  bar.classList.remove("indeterminate")
  $("updateProgressTitle").textContent = p.version ? `Mise à jour vers v${p.version}` : "Mise à jour en cours"
  if (p.phase === "download") {
    $("updateProgressPhase").textContent = "Téléchargement de la nouvelle version…"
    if (p.percent == null) {
      bar.classList.add("indeterminate")
      $("updateProgressDetail").textContent = fmtMb(p.received)
    } else {
      bar.style.width = `${p.percent}%`
      $("updateProgressDetail").textContent = `${p.percent} % — ${fmtMb(p.received)} / ${fmtMb(p.total)}`
    }
  } else if (p.phase === "install") {
    bar.style.width = "100%"
    bar.classList.add("indeterminate")
    $("updateProgressPhase").textContent = "Installation silencieuse en cours… (connexion et réglages conservés)"
    $("updateProgressDetail").textContent = ""
  } else if (p.phase === "restart") {
    bar.style.width = "100%"
    $("updateProgressPhase").textContent = "Installation terminée — l'application redémarre dans quelques secondes."
    $("updateProgressDetail").textContent = ""
  } else if (p.phase === "error") {
    bar.style.width = "100%"
    bar.style.background = "#dc2626"
    $("updateProgressPhase").textContent = "La mise à jour a échoué."
    $("updateProgressDetail").textContent = p.message || ""
    closeBtn.classList.remove("hidden")
  }
}
$("updateProgressCloseBtn")?.addEventListener("click", () => $("updateProgressDialog").classList.add("hidden"))

function render(state) {
  if (!state) return
  const prev = syncedPrefixes()
  lastState = state
  renderServiceBanner(state.serviceUnreachable || null)
  renderUpdateProgress(state.updateProgress || null)
  renderInstances(state)
  renderFiles(state)
  // Les badges "synchronisé" de l'explorateur dépendent des instances.
  const now = syncedPrefixes()
  if (prev.size !== now.size) loadBrowse().catch(() => {})
}

// ---------- config / login ----------

function renderServiceBanner(message) {
  const b = $("serviceBanner")
  if (message) {
    b.textContent = `⚠ Service injoignable : ${message} — ouvrez Réglages → Mode service pour vérifier son état.`
    b.classList.remove("hidden")
  } else {
    b.classList.add("hidden")
  }
}

async function refreshConfig() {
  const c = await window.agent.getConfig()
  $("modeBadge").classList.toggle("hidden", !["service", "web"].includes(c.mode))
  renderServiceBanner(c.serviceUnreachable)
  if (c.appVersion) {
    // Version visible partout : bandeau, titre de la fenêtre (barre des
    // tâches) — même version que celle publiée par le workflow Release.
    $("appVersion").textContent = `v${c.appVersion}`
    document.title = `PrintIOS Sync v${c.appVersion}`
  }
  if (c.isLoggedIn) {
    $("loginView").classList.add("hidden")
    $("mainView").classList.remove("hidden")
    $("logoutBtn").classList.remove("hidden")
    $("userLabel").textContent = `${c.userLabel || ""}${c.role ? ` (${c.role})` : ""} · ${c.agentLabel || c.hostname || ""}`
    // Selon le rôle (voir api.js) : synchro S3 (sync_agent/admin/opérateur)
    // et/ou envoi de fichiers sur les commandes (vendeur/admin/opérateur).
    const canSync = c.canSync !== false
    const canUpload = !!c.canUpload
    $("explorerPane").classList.toggle("hidden", !canSync)
    $("syncHead").classList.toggle("hidden", !canSync)
    $("syncBody").classList.toggle("hidden", !canSync)
    $("uploadPanel").classList.toggle("hidden", !canUpload)
    $("ordersPane").classList.toggle("hidden", !canUpload)
    if (canUpload) loadOrdersList()
    $("autoLaunchToggle").checked = !!c.autoLaunch
    $("autoUpdateToggle").checked = Number(c.autoUpdate) === 1
    for (const k of SETTINGS) $(k).value = c[k]
    $("pollIntervalSec").value = Math.round((c.pollIntervalMs || 5000) / 1000)
    loadBrowse("")
  } else {
    $("loginView").classList.remove("hidden")
    $("mainView").classList.add("hidden")
    $("logoutBtn").classList.add("hidden")
    $("userLabel").textContent = ""
    if (c.serverUrl) $("serverUrl").value = c.serverUrl
    if (c.tenant) $("tenant").value = c.tenant
    if (c.tenant) detectTenant()
  }
}

// Détection automatique de l'espace : dès que le champ est rempli (installeur,
// lien printios-sync://, saisie), l'API est déduite et l'espace affiché AVANT
// la connexion (carte « Espace »). Debounce 600 ms sur la saisie.
let detectTimer = null
let detectSeq = 0
async function detectTenant() {
  const card = $("tenantCard")
  const tenantIn = $("tenant").value.trim()
  const seq = ++detectSeq
  if (!tenantIn) { card.classList.add("hidden"); return }
  card.classList.remove("hidden", "err")
  $("tenantName").textContent = tenantIn
  $("tenantMeta").textContent = "détection…"
  try {
    const r = await window.agent.resolveTenant(tenantIn, $("serverUrl").value.trim())
    if (seq !== detectSeq) return
    if (!$("serverUrl").value.trim()) $("serverUrl").value = r.serverUrl
    $("tenantName").textContent = r.name || r.tenant || tenantIn
    // L'adresse de l'API n'est JAMAIS affichée (demande explicite) : seul
    // l'espace client (nom du magasin + identifiant) est montré.
    $("tenantMeta").textContent = r.tenancy ? `${r.tenant}${r.check?.type === "demo" ? " (démo)" : ""}` : "espace dédié"
  } catch (e) {
    if (seq !== detectSeq) return
    card.classList.add("err")
    $("tenantMeta").textContent = errMsg(e, "espace introuvable")
  }
}
$("tenant").addEventListener("input", () => { clearTimeout(detectTimer); detectTimer = setTimeout(detectTenant, 600) })

$("pingBtn").addEventListener("click", async () => {
  const out = $("pingResult")
  out.className = "hint"
  out.textContent = "Test en cours…"
  try {
    // Espace client saisi → l'adresse de l'API est déduite (sauf champ avancé
    // renseigné) et vérifiée ; l'API retenue est affichée.
    const tenantIn = $("tenant").value.trim()
    let serverUrl = $("serverUrl").value.trim()
    if (tenantIn) {
      const res = await window.agent.resolveTenant(tenantIn, serverUrl)
      serverUrl = res.serverUrl
      $("serverUrl").value = serverUrl
    }
    if (!serverUrl) throw new Error("Indiquez votre espace client.")
    const r = await window.agent.ping(serverUrl, tenantIn)
    const recent = Number(r.desktop_api || 0) >= 2
    let ok = recent
    let text = recent
      ? `OK — ${r.app || "API"} répond`
      : `L'API répond mais sans les endpoints de synchro S3 : redéployer API2.`
    // API multi-client (PrintIOS) : l'espace client est obligatoire et vérifié.
    if (r.tenancy) {
      if (r.tenantRequired) {
        ok = false
        text += " — API multi-client : indiquez votre espace client."
      } else if (r.tenantCheck && r.tenantCheck.found === false) {
        ok = false
        text += ` — espace client « ${r.tenant} » inconnu.`
      } else if (r.tenantCheck?.found) {
        text += ` — espace « ${r.tenantCheck.slug}${r.tenantCheck.type === "demo" ? " (démo)" : ""} »`
      } else {
        text += ` — espace « ${r.tenant} » (vérifié à la connexion)`
      }
    }
    out.className = ok ? "hint ok" : "hint err"
    out.textContent = text
  } catch (e) {
    out.className = "hint err"
    out.textContent = errMsg(e, "Échec du test.")
  }
})

$("loginBtn").addEventListener("click", async () => {
  const err = $("loginError")
  err.textContent = ""
  const serverUrl = $("serverUrl").value.trim()
  const tenant = $("tenant").value.trim()
  const logon = $("logon").value.trim()
  const password = $("password").value
  if ((!serverUrl && !tenant) || !logon || !password) {
    err.textContent = "Espace client, identifiant et mot de passe sont obligatoires."
    return
  }
  const btn = $("loginBtn")
  btn.disabled = true
  btn.textContent = "Connexion…"
  try {
    await window.agent.login({ serverUrl, tenant, logon, password })
    $("password").value = ""
    await refreshConfig()
    // La vérification de version faite au démarrage a pu échouer (pas
    // encore connecté) : on la relance tout de suite.
    refreshUpdateBanner()
  } catch (e) {
    err.textContent = errMsg(e, "Échec de connexion.")
  } finally {
    btn.disabled = false
    btn.textContent = "Se connecter"
  }
})

// Déconnexion — disponible dans les deux modes (bouton de la barre du haut).
// Mode agent : la synchro s'arrête (fichiers partiels conservés pour reprise),
// le poste passe hors ligne dans PrintIOS. Mode utilisateur : les envois en
// attente sont annulés (un autre compte pourra se connecter sur ce poste).
$("logoutBtn").addEventListener("click", async () => {
  const btn = $("logoutBtn")
  const pending = uploadJobs.filter((j) => j.status === "queued" || j.status === "uploading").length
  const lines = ["Se déconnecter de PrintIOS Sync ?"]
  if (!$("syncHead").classList.contains("hidden")) lines.push("La synchronisation s'arrête et ce poste apparaîtra hors ligne dans PrintIOS.")
  if (pending) lines.push(`${pending} envoi(s) de fichier en cours ou en attente seront annulés.`)
  if (!window.confirm(lines.join("\n\n"))) return
  btn.disabled = true
  try {
    await window.agent.logout()
  } catch (e) {
    // Même si l'API est injoignable, la session locale est effacée côté
    // agent : on affiche quand même l'écran de connexion.
    console.warn("logout", e)
  } finally {
    btn.disabled = false
  }
  // Remise à zéro de l'écran utilisateur (commande chargée, liste, envois).
  uploadOrder = null
  uploadJobs = []
  $("uploadOrderId").value = ""
  $("ordersList").innerHTML = ""
  renderUploadOrder()
  renderUploadQueue()
  $("password").value = ""
  await refreshConfig()
  $("loginError").textContent = ""
  $("password").focus()
})

// ---------- explorateur : actions ----------

$("refreshBrowseBtn").addEventListener("click", () => loadBrowse())

$("createInstanceBtn").addEventListener("click", () => {
  $("instPrefix").value = currentPrefix
  $("instName").value = currentPrefix.split("/").filter(Boolean).slice(-2).join(" / ")
  $("instLocalDir").value = ""
  $("instDeleteRemoved").checked = false
  $("instSkipExisting").checked = false
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
  try {
    await window.agent.addInstance({
      name,
      prefix,
      localDir,
      deleteRemoved: $("instDeleteRemoved").checked,
      skipExisting: $("instSkipExisting").checked,
    })
    $("instanceDialog").classList.add("hidden")
  } catch (e) {
    $("instError").textContent = errMsg(e, "Impossible de créer l'instance.")
  }
})

// ---------- réglages ----------

$("settingsBtn").addEventListener("click", async () => {
  // Recharge la config avant d'ouvrir : sinon le formulaire affiche encore
  // les valeurs de l'ouverture de l'app, même si elles ont été modifiées
  // depuis (par cet agent ou depuis le B2B) — le dialogue n'étant jamais
  // rafraîchi tout seul entre deux ouvertures.
  await refreshConfig().catch(() => {})
  $("settingsDialog").classList.remove("hidden")
})
$("settingsCloseBtn").addEventListener("click", () => $("settingsDialog").classList.add("hidden"))
$("saveSettingsBtn").addEventListener("click", async () => {
  const partial = {}
  for (const k of SETTINGS) partial[k] = Number($(k).value)
  partial.pollIntervalMs = Number($("pollIntervalSec").value) * 1000
  partial.autoUpdate = $("autoUpdateToggle").checked ? 1 : 0
  try {
    await window.agent.setSettings(partial)
    $("settingsDialog").classList.add("hidden")
  } catch (e) {
    alert(errMsg(e, "Impossible d'enregistrer les réglages."))
  }
})
$("autoLaunchToggle").addEventListener("change", (e) => window.agent.setAutoLaunch(e.target.checked))

// ---------- mode service ----------

async function refreshServiceStatus() {
  const box = $("serviceBox")
  const badge = $("serviceBadge")
  const info = $("serviceInfo")
  const installBtn = $("serviceInstallBtn")
  const uninstallBtn = $("serviceUninstallBtn")
  const stopBtn = $("serviceStopBtn")
  const startBtn = $("serviceStartBtn")
  try {
    const s = await window.agent.serviceStatus()
    // "Installer le service" (et tout le bloc Mode service) n'a de sens
    // qu'en mode agent desktop — masqué entièrement en mode web/conteneur
    // (voir web-agent.js::serviceStatus(), qui renvoie supported:false),
    // pas juste les boutons d'action. Sur demande explicite de
    // l'utilisateur : "installer service doit s'afficher seulement si on
    // est en mode agent".
    if (!s.supported) {
      box.classList.add("hidden")
      return
    }
    box.classList.remove("hidden")
    if (!s.installed) {
      badge.textContent = "non installé"
      badge.className = "badge off"
      info.textContent = `L'agent tourne dans cette fenêtre (mode session). Données du service : ${s.dataDir}`
      installBtn.classList.remove("hidden")
      uninstallBtn.classList.add("hidden")
      stopBtn.classList.add("hidden")
      startBtn.classList.add("hidden")
      return
    }
    installBtn.classList.add("hidden")
    uninstallBtn.classList.remove("hidden")
    stopBtn.classList.toggle("hidden", !s.running)
    startBtn.classList.toggle("hidden", !!s.running)
    if (s.running && s.reachable !== false) {
      badge.textContent = "actif"
      badge.className = "badge"
      info.textContent = `Service installé et en cours d'exécution — il continue même session fermée. Données : ${s.dataDir}`
    } else if (s.running) {
      badge.textContent = "actif, injoignable"
      badge.className = "badge warn"
      info.textContent = `Le service tourne mais ne répond pas sur l'API locale (${s.error || "jeton de contrôle différent ?"}). Désinstallez puis réinstallez pour resynchroniser la configuration.`
    } else {
      badge.textContent = "arrêté"
      badge.className = "badge err"
      info.textContent = `Le service est installé mais arrêté : aucune synchronisation ne tourne et le poste est hors ligne dans le B2B. Cliquez « Démarrer le service » pour reprendre. Journal : ${s.dataDir}/logs/service.log`
    }
  } catch (e) {
    badge.textContent = "erreur"
    badge.className = "badge err"
    info.textContent = errMsg(e, "Impossible de lire l'état du service.")
  }
}

$("serviceRefreshBtn").addEventListener("click", refreshServiceStatus)
$("settingsBtn").addEventListener("click", () => {
  refreshServiceStatus()
  if (Date.now() - lastUpdateCheckAt > 60 * 1000) refreshUpdateBanner()
  else renderUpdateCheckStatus()
})

$("serviceInstallBtn").addEventListener("click", async () => {
  if (
    !confirm(
      "Installer PrintIOS Sync comme service de l'ordinateur ?\n\n" +
        "• L'agent continuera à synchroniser même session fermée.\n" +
        "• Une élévation (administrateur) va être demandée.\n" +
        "• La configuration actuelle (connexion, instances, fichiers déjà synchronisés) est reprise par le service : rien n'est retéléchargé.\n" +
        "• Les dossiers de destination doivent être sur un disque local (pas de lecteur réseau mappé)."
    )
  )
    return
  const btn = $("serviceInstallBtn")
  btn.disabled = true
  btn.textContent = "Installation…"
  try {
    await window.agent.serviceInstall()
    await refreshConfig()
    await refreshServiceStatus()
  } catch (e) {
    alert(errMsg(e, "Installation du service impossible."))
  } finally {
    btn.disabled = false
    btn.textContent = "Installer le service"
  }
})

async function runServiceAction(btnId, label, busyLabel, fn) {
  const btn = $(btnId)
  btn.disabled = true
  btn.textContent = busyLabel
  try {
    await fn()
    await refreshServiceStatus()
  } catch (e) {
    alert(e?.message || `${label} impossible.`)
  } finally {
    btn.disabled = false
    btn.textContent = label
  }
}

$("serviceStopBtn").addEventListener("click", async () => {
  if (
    !confirm(
      "Arrêter le service ?\n\n• Les téléchargements en cours sont interrompus proprement (ils reprendront là où ils en étaient au redémarrage).\n• Le poste passe hors ligne dans le B2B.\n• Le service reste installé et redémarrera avec l'ordinateur.\n• Une élévation (administrateur) peut être demandée."
    )
  )
    return
  await runServiceAction("serviceStopBtn", "Arrêter le service", "Arrêt…", () => window.agent.serviceStop())
})

$("serviceStartBtn").addEventListener("click", async () => {
  await runServiceAction("serviceStartBtn", "Démarrer le service", "Démarrage…", () => window.agent.serviceStart())
})

$("serviceUninstallBtn").addEventListener("click", async () => {
  if (
    !confirm(
      "Désinstaller le service ?\n\nL'agent repassera en mode session (il ne tournera que quand cette application est ouverte). L'état du service (connexion, fichiers synchronisés) est ramené dans cette fenêtre."
    )
  )
    return
  const btn = $("serviceUninstallBtn")
  btn.disabled = true
  btn.textContent = "Désinstallation…"
  try {
    await window.agent.serviceUninstall()
    await refreshConfig()
    await refreshServiceStatus()
  } catch (e) {
    alert(errMsg(e, "Désinstallation du service impossible."))
  } finally {
    btn.disabled = false
    btn.textContent = "Désinstaller le service"
  }
})

// ---------- mise à jour ----------
// Bannière "nouvelle version disponible" — vérifiée au démarrage puis
// toutes les 2 h (voir Engine.checkUpdate). "Mettre à jour" télécharge et
// lance l'installeur puis ferme l'agent (mode session) ou, si le service
// est installé, la demande part vers le VRAI processus service qui
// s'installe silencieusement et redémarre seul (voir selfUpdater.js) —
// même bouton, l'agent choisit le bon comportement.

let updateInfo = null
let dismissedUpdateVersion = null

let lastUpdateCheckAt = 0
async function refreshUpdateBanner(force = false) {
  try {
    updateInfo = await window.agent.checkUpdate(force)
  } catch {
    updateInfo = null
  }
  lastUpdateCheckAt = Date.now()
  renderUpdateCheckStatus()
  const banner = $("updateBanner")
  if (!updateInfo?.available || updateInfo.version === dismissedUpdateVersion) {
    banner.classList.add("hidden")
    return
  }
  $("updateBannerText").textContent = `Nouvelle version disponible : v${updateInfo.version} (installée : v${updateInfo.current || "?"}). Installation silencieuse, sans désinstallation — votre connexion et vos réglages sont conservés.`
  banner.classList.remove("hidden")
}

$("updateDismissBtn").addEventListener("click", () => {
  dismissedUpdateVersion = updateInfo?.version || null
  $("updateBanner").classList.add("hidden")
})

$("updateApplyBtn").addEventListener("click", async () => {
  if (
    !confirm(
      `Installer la version v${updateInfo?.version} maintenant ?\n\n` +
        "Installation silencieuse en place : l'application redémarre toute seule à la fin (quelques secondes, synchro brièvement interrompue). Connexion, instances et fichiers déjà synchronisés sont conservés."
    )
  )
    return
  const btn = $("updateApplyBtn")
  btn.disabled = true
  btn.textContent = "Téléchargement…"
  renderUpdateProgress({ active: true, phase: "download", percent: null, received: 0, version: updateInfo?.version })
  try {
    await window.agent.applyUpdate()
    $("updateBannerText").textContent = "Mise à jour en cours — l'application redémarre dans quelques secondes."
    btn.classList.add("hidden")
    $("updateDismissBtn").classList.add("hidden")
  } catch (e) {
    renderUpdateProgress({ active: false, phase: "error", message: errMsg(e, "Mise à jour impossible."), version: updateInfo?.version })
    btn.disabled = false
    btn.textContent = "Mettre à jour maintenant"
  }
})

// Nouvelle version affichée au plus vite : toutes les 10 min, et dès que la
// fenêtre revient au premier plan (au plus une fois par minute).
setInterval(() => refreshUpdateBanner(), 10 * 60 * 1000)
window.addEventListener("focus", () => { if (Date.now() - lastUpdateCheckAt > 60 * 1000) refreshUpdateBanner() })
// Tant qu'aucune vérification n'a abouti (pas connecté au démarrage,
// réseau…), on réessaie toutes les 5 min plutôt que d'attendre 2 h.
setInterval(() => {
  if (!updateInfo || updateInfo.reason === "no_server" || updateInfo.reason === "not_logged_in" || updateInfo.reason === "error") refreshUpdateBanner()
}, 5 * 60 * 1000)

// Réglages → "Vérifier maintenant" + ligne d'état lisible (version installée,
// dernière version publiée, raison si rien à installer).
function renderUpdateCheckStatus() {
  const el = $("updateCheckStatus")
  if (!el) return
  const cur = updateInfo?.current ? `v${updateInfo.current}` : ""
  if (!updateInfo) {
    el.textContent = `Version installée : ${cur || "?"} — vérification impossible.`
    return
  }
  if (updateInfo.available) {
    el.textContent = `Version installée : ${cur} — nouvelle version v${updateInfo.version} disponible.`
    return
  }
  const why = {
    not_logged_in: "connectez-vous pour vérifier les mises à jour",
    no_server: "renseignez l'adresse de l'API pour vérifier les mises à jour",
    no_release: updateInfo.message || "aucune version publiée sur le serveur",
    up_to_date: `à jour (dernière publiée : v${updateInfo.version || "?"})`,
    no_asset_for_platform: `v${updateInfo.version} publiée mais sans installeur pour cette plateforme`,
    error: `erreur : ${updateInfo.message || "réseau"}`,
  }[updateInfo.reason] || "à jour"
  el.textContent = `Version installée : ${cur} — ${why}.`
}
// Recherche MANUELLE (bouton de la barre du haut, menu de l'icône) : on
// affiche toujours un résultat — nouvelle version (avec « Mettre à jour
// maintenant ») ou « à jour » / raison, dans la bannière du haut.
let manualCheckTimer = null
async function manualUpdateCheck() {
  const btn = $("topCheckUpdateBtn")
  if (btn) { btn.disabled = true; btn.textContent = "Recherche…" }
  clearTimeout(manualCheckTimer)
  try {
    dismissedUpdateVersion = null
    await refreshUpdateBanner(true)
    const banner = $("updateBanner")
    if (updateInfo?.available) {
      $("updateApplyBtn").classList.remove("hidden")
      $("updateApplyBtn").disabled = false
      $("updateApplyBtn").textContent = "Mettre à jour maintenant"
      $("updateDismissBtn").classList.remove("hidden")
      banner.classList.remove("hidden")
    } else {
      renderUpdateCheckStatus()
      $("updateBannerText").textContent = $("updateCheckStatus")?.textContent || "Aucune mise à jour disponible."
      $("updateApplyBtn").classList.add("hidden")
      $("updateDismissBtn").classList.remove("hidden")
      banner.classList.remove("hidden")
      manualCheckTimer = setTimeout(() => { if (!updateInfo?.available) banner.classList.add("hidden") }, 8000)
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Rechercher une mise à jour" }
  }
}
$("topCheckUpdateBtn")?.addEventListener("click", manualUpdateCheck)
window.agent.onManualUpdateCheck?.(() => manualUpdateCheck())

$("checkUpdateBtn")?.addEventListener("click", async () => {
  const btn = $("checkUpdateBtn")
  btn.disabled = true
  btn.textContent = "Vérification…"
  try {
    await refreshUpdateBanner(true)
  } finally {
    btn.disabled = false
    btn.textContent = "Vérifier maintenant"
  }
})

// Notification système / menu tray (processus principal) → affiche la
// bannière tout de suite, même si elle avait été masquée pour cette version.
window.agent.onUpdateAvailable?.((info) => {
  if (!info?.available) return
  updateInfo = info
  dismissedUpdateVersion = null
  $("updateBannerText").textContent = `Nouvelle version disponible : v${info.version} (installée : v${info.current || "?"}). Installation silencieuse, sans désinstallation — votre connexion et vos réglages sont conservés.`
  $("updateBanner").classList.remove("hidden")
  $("updateApplyBtn").classList.remove("hidden")
  $("updateDismissBtn").classList.remove("hidden")
  $("updateApplyBtn").disabled = false
  $("updateApplyBtn").textContent = "Mettre à jour maintenant"
})

// ---------- synchro : actions globales ----------

$("scanNowBtn").addEventListener("click", () => window.agent.scanNow())
$("pauseBtn").addEventListener("click", async () => {
  if (lastState.paused) await window.agent.resume()
  else await window.agent.pause()
})

// ---------- envoi de fichiers (conception / montage) ----------
// File d'envoi côté processus principal (src/uploadQueue.js) : plusieurs
// fichiers en même temps, en arrière-plan ; ici on affiche l'état.
let uploadOrder = null
let uploadJobs = [] // état complet de la file (upload:queue)

const KIND_LABEL = { design: "Conception", print: "Montage" }

function jobForItem(itemId, kind) {
  return uploadJobs.find((j) => j.itemId === Number(itemId) && j.kind === kind && j.orderId === Number(uploadOrder?.id))
}

function jobStatusHtml(j) {
  if (!j) return ""
  const label = KIND_LABEL[j.kind] || j.kind
  if (j.status === "error") return `<div class="item-status err">${label} : ${j.error || "échec"} <button class="small ghost" data-retry="${j.id}">Réessayer</button></div>`
  if (j.status === "done") return `<div class="item-status ok">${label} envoyé : ${j.name}</div>`
  if (j.status === "queued") return `<div class="item-status">${label} : en attente (${j.name})${j.error ? ` — ${j.error}` : ""}</div>`
  const pct = j.size ? Math.round((j.bytes / j.size) * 100) : 0
  return `<progress max="100" value="${pct}"></progress><div class="item-status">${label} : ${pct}% (${fmtBytes(j.bytes)} / ${fmtBytes(j.size)}${j.speed ? ` · ${fmtBytes(j.speed)}/s` : ""})</div>`
}

function renderUploadOrder() {
  const box = $("uploadOrder")
  if (!uploadOrder) { box.innerHTML = ""; return }
  const o = uploadOrder
  const meta = `<div class="order-meta">Commande <strong>#${o.id}</strong> · ${o.stat || ""}${o.reseller ? ` · ${o.reseller}` : ""}${o.date ? ` · ${String(o.date).slice(0, 10)}` : ""}${o.print_file ? ` · Fichier commande : <a href="#" data-open="${encodeURIComponent(o.print_file_key || "")}" data-name="${encodeURIComponent(o.print_file)}">${o.print_file}</a>` : ""}</div>`
  const items = (o.items || []).map((it) => `<div class="upload-item" data-item="${it.id}">
      <div>
        <div class="item-name">${it.name}${it.quantity ? ` ×${it.quantity}` : ""}</div>
        <div class="item-files">
          <span>Conception : ${it.design_file ? `<a href="#" data-open="${encodeURIComponent(it.design_file_key || "")}" data-name="${encodeURIComponent(it.design_file)}">${it.design_file}</a>` : "—"}</span>
          <span>Montage / impression : ${it.print_file ? `<a href="#" data-open="${encodeURIComponent(it.print_file_key || "")}" data-name="${encodeURIComponent(it.print_file)}">${it.print_file}</a>` : "—"}</span>
        </div>
      </div>
      <button class="small" data-upload="design" data-item="${it.id}">Fichier de conception…</button>
      <button class="small primary" data-upload="print" data-item="${it.id}">Fichier de montage…</button>
      ${jobStatusHtml(jobForItem(it.id, "design"))}${jobStatusHtml(jobForItem(it.id, "print"))}
    </div>`).join("")
  box.innerHTML = meta + (items || `<p class="empty">Aucun article sur cette commande.</p>`)
  box.querySelectorAll("button[data-upload]").forEach((b) => b.addEventListener("click", () => startUpload(Number(b.dataset.item), b.dataset.upload)))
  box.querySelectorAll("button[data-retry]").forEach((b) => b.addEventListener("click", () => window.agent.retryUpload(b.dataset.retry)))
  // Fichiers déjà rattachés : clic = ouverture (URL présignée) dans le navigateur.
  box.querySelectorAll("a[data-open]").forEach((a) => a.addEventListener("click", async (e) => {
    e.preventDefault()
    const key = decodeURIComponent(a.dataset.open || "")
    if (!key) return
    const name = decodeURIComponent(a.dataset.name || "")
    try { await window.agent.openItemFile(key, name) } catch (err) { $("uploadError").textContent = errMsg(err, "Impossible d'ouvrir le fichier.") }
  }))
}

// Liste globale des envois (toutes commandes) sous le panneau.
function renderUploadQueue() {
  const box = $("uploadQueue")
  if (!box) return
  const active = uploadJobs.filter((j) => j.status !== "done")
  const done = uploadJobs.filter((j) => j.status === "done")
  $("uploadQueueSummary").textContent = active.length
    ? `${uploadJobs.filter((j) => j.status === "uploading").length} en cours · ${uploadJobs.filter((j) => j.status === "queued").length} en attente · ${uploadJobs.filter((j) => j.status === "error").length} en erreur`
    : (done.length ? `${done.length} terminé(s)` : "")
  if (!uploadJobs.length) { box.innerHTML = `<p class="empty">Aucun envoi.</p>`; return }
  box.innerHTML = uploadJobs.map((j) => {
    const pct = j.size ? Math.round((j.bytes / j.size) * 100) : 0
    const state = j.status === "uploading" ? `${pct}%${j.speed ? ` · ${fmtBytes(j.speed)}/s` : ""}` : j.status === "queued" ? "en attente" : j.status === "done" ? "envoyé" : "erreur"
    return `<div class="queue-row ${j.status}">
      <div class="queue-main"><strong>#${j.orderId}</strong> · article ${j.itemId} · ${KIND_LABEL[j.kind] || j.kind} · ${j.name} <span class="hint">(${fmtBytes(j.size)})</span></div>
      <div class="queue-state">${state}${j.status === "error" ? ` — ${j.error || ""}` : ""}</div>
      ${j.status === "uploading" ? `<progress max="100" value="${pct}"></progress>` : ""}
      <div class="queue-actions">
        ${j.status === "error" ? `<button class="small" data-retry="${j.id}">Réessayer</button>` : ""}
        ${j.status !== "uploading" ? `<button class="small ghost" data-remove="${j.id}">Retirer</button>` : ""}
      </div>
    </div>`
  }).join("")
  box.querySelectorAll("button[data-retry]").forEach((b) => b.addEventListener("click", () => window.agent.retryUpload(b.dataset.retry)))
  box.querySelectorAll("button[data-remove]").forEach((b) => b.addEventListener("click", () => window.agent.removeUpload(b.dataset.remove)))
}

async function loadUploadOrder() {
  const err = $("uploadError")
  err.textContent = ""
  const id = $("uploadOrderId").value.trim().replace(/^#|^ORD-/i, "")
  if (!id) return
  try {
    uploadOrder = await window.agent.getOrder(id)
    renderUploadOrder()
  } catch (e) {
    uploadOrder = null
    renderUploadOrder()
    err.textContent = errMsg(e, "Commande introuvable.")
  }
}

// Ajoute un envoi à la file et rend la main tout de suite : l'utilisateur
// peut enchaîner sur un autre article / une autre commande.
async function startUpload(itemId, kind) {
  const file = await window.agent.pickUploadFile()
  if (!file || !uploadOrder) return
  try {
    await window.agent.enqueueUpload({ orderId: uploadOrder.id, itemId, filePath: file.path, kind })
  } catch (e) {
    $("uploadError").textContent = errMsg(e, "Impossible d'ajouter l'envoi.")
  }
}

// Liste des commandes PAS ENCORE EXPÉDIÉES (colonne gauche, mode utilisateur) :
// un clic charge la commande dans le panneau de droite. Rafraîchie toutes les 60 s.
let ordersSearchTimer = null
async function loadOrdersList() {
  const box = $("ordersList")
  const err = $("ordersError")
  err.textContent = ""
  try {
    const list = await window.agent.listOrders({ search: $("ordersSearch").value.trim() })
    if (!list.length) { box.innerHTML = `<p class="empty">Aucune commande à expédier.</p>`; return }
    box.innerHTML = list.map((o) => `<div class="browse-row order-row ${uploadOrder && Number(uploadOrder.id) === Number(o.id) ? "active" : ""}" data-order="${o.id}">
        <div class="order-row-main"><strong>#${o.id}</strong> ${o.customer ? `· ${o.customer}` : ""}${o.reseller ? ` <span class="hint">· ${o.reseller}</span>` : ""}</div>
        <div class="hint">${o.stat || ""}${o.date ? ` · ${String(o.date).slice(0, 10)}` : ""}${o.items_count != null ? ` · ${o.items_count} article(s)` : ""}${o.has_shipping ? " · colis créé" : ""}</div>
      </div>`).join("")
    box.querySelectorAll("[data-order]").forEach((el) => el.addEventListener("click", () => {
      $("uploadOrderId").value = el.dataset.order
      loadUploadOrder()
      box.querySelectorAll(".order-row").forEach((r) => r.classList.toggle("active", r === el))
    }))
  } catch (e) {
    err.textContent = errMsg(e, "Impossible de charger les commandes.")
  }
}
$("refreshOrdersBtn").addEventListener("click", loadOrdersList)
$("ordersSearch").addEventListener("input", () => { clearTimeout(ordersSearchTimer); ordersSearchTimer = setTimeout(loadOrdersList, 400) })
setInterval(() => { if (!$("ordersPane").classList.contains("hidden")) loadOrdersList() }, 60 * 1000)

$("uploadLoadBtn").addEventListener("click", loadUploadOrder)
$("uploadOrderId").addEventListener("keydown", (e) => { if (e.key === "Enter") loadUploadOrder() })
$("uploadClearDoneBtn")?.addEventListener("click", () => window.agent.clearDoneUploads())
let refreshOrderTimer = null
window.agent.onUploadQueue((jobs) => {
  const before = uploadJobs
  uploadJobs = Array.isArray(jobs) ? jobs : []
  renderUploadQueue()
  renderUploadOrder()
  // Un envoi de la commande affichée vient de se terminer → recharge pour
  // afficher le fichier rattaché.
  const finishedNow = uploadJobs.some((j) => j.status === "done" && j.orderId === Number(uploadOrder?.id) && before.find((b) => b.id === j.id)?.status !== "done")
  if (finishedNow) { clearTimeout(refreshOrderTimer); refreshOrderTimer = setTimeout(loadUploadOrder, 400) }
})
window.agent.uploadQueue?.().then((jobs) => { uploadJobs = jobs || []; renderUploadQueue() }).catch(() => {})

// ---------- init ----------

window.agent.onStateUpdate(render)
// Lien printios-sync://connect?api=…&tenant=…&logon=… depuis le navigateur :
// remplit l'écran de connexion (l'utilisateur n'a plus que le mot de passe).
if (window.agent.onAuthPrefill) window.agent.onAuthPrefill((p) => {
  if (p?.serverUrl) $("serverUrl").value = p.serverUrl
  if (p?.tenant) $("tenant").value = p.tenant
  if (p?.logon) $("logon").value = p.logon
  detectTenant()
  $("password").focus()
})
window.agent.onAuthLost(async () => {
  await refreshConfig()
  $("loginError").textContent = "Session terminée : ce poste a été supprimé depuis PrintIOS ou le jeton a expiré. Reconnectez-vous."
})
refreshConfig()
window.agent.getState().then(render)
refreshUpdateBanner()
