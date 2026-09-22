const $ = (id) => document.getElementById(id)

const SETTINGS = ["maxParallelFiles", "maxParallelChunks", "chunkSizeMb", "chunkThresholdMb", "maxRetries", "failedRetryDelayMin"]

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
        alert(e?.message || "Impossible de modifier l'option.")
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

function render(state) {
  if (!state) return
  const prev = syncedPrefixes()
  lastState = state
  renderServiceBanner(state.serviceUnreachable || null)
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
  if (c.isLoggedIn) {
    $("loginView").classList.add("hidden")
    $("mainView").classList.remove("hidden")
    $("userLabel").textContent = `${c.userLabel || ""} · ${c.agentLabel || c.hostname || ""}`
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
  $("instDeleteRemoved").checked = false
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
    await window.agent.addInstance({ name, prefix, localDir, deleteRemoved: $("instDeleteRemoved").checked })
    $("instanceDialog").classList.add("hidden")
  } catch (e) {
    $("instError").textContent = e?.message || "Impossible de créer l'instance."
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
  try {
    await window.agent.setSettings(partial)
    $("settingsDialog").classList.add("hidden")
  } catch (e) {
    alert(e?.message || "Impossible d'enregistrer les réglages.")
  }
})
$("autoLaunchToggle").addEventListener("change", (e) => window.agent.setAutoLaunch(e.target.checked))

// ---------- mode service ----------

async function refreshServiceStatus() {
  const badge = $("serviceBadge")
  const info = $("serviceInfo")
  const installBtn = $("serviceInstallBtn")
  const uninstallBtn = $("serviceUninstallBtn")
  const stopBtn = $("serviceStopBtn")
  const startBtn = $("serviceStartBtn")
  try {
    const s = await window.agent.serviceStatus()
    if (!s.supported) {
      badge.textContent = "indisponible"
      badge.className = "badge off"
      info.textContent = s.reason || ""
      installBtn.classList.add("hidden")
      uninstallBtn.classList.add("hidden")
      stopBtn.classList.add("hidden")
      startBtn.classList.add("hidden")
      return
    }
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
    info.textContent = e?.message || "Impossible de lire l'état du service."
  }
}

$("serviceRefreshBtn").addEventListener("click", refreshServiceStatus)
$("settingsBtn").addEventListener("click", refreshServiceStatus)

$("serviceInstallBtn").addEventListener("click", async () => {
  if (
    !confirm(
      "Installer PackSpace S3 Sync comme service de l'ordinateur ?\n\n" +
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
    alert(e?.message || "Installation du service impossible.")
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
    alert(e?.message || "Désinstallation du service impossible.")
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

async function refreshUpdateBanner() {
  try {
    updateInfo = await window.agent.checkUpdate()
  } catch {
    updateInfo = null
  }
  const banner = $("updateBanner")
  if (!updateInfo?.available || updateInfo.version === dismissedUpdateVersion) {
    banner.classList.add("hidden")
    return
  }
  $("updateBannerText").textContent = `Nouvelle version disponible : v${updateInfo.version} (actuelle : v${updateInfo.current || "?"})`
  banner.classList.remove("hidden")
}

$("updateDismissBtn").addEventListener("click", () => {
  dismissedUpdateVersion = updateInfo?.version || null
  $("updateBanner").classList.add("hidden")
})

$("updateApplyBtn").addEventListener("click", async () => {
  if (
    !confirm(
      `Télécharger et installer la version v${updateInfo?.version} ?\n\n` +
        "L'agent va se fermer pour terminer l'installation (mode session) ou redémarrer tout seul (mode service, synchro brièvement interrompue)."
    )
  )
    return
  const btn = $("updateApplyBtn")
  btn.disabled = true
  btn.textContent = "Téléchargement…"
  try {
    await window.agent.applyUpdate()
    $("updateBannerText").textContent = "Mise à jour en cours — l'agent va se fermer ou redémarrer dans quelques secondes."
    btn.classList.add("hidden")
    $("updateDismissBtn").classList.add("hidden")
  } catch (e) {
    alert(e?.message || "Mise à jour impossible.")
    btn.disabled = false
    btn.textContent = "Mettre à jour"
  }
})

setInterval(refreshUpdateBanner, 2 * 60 * 60 * 1000)

// ---------- synchro : actions globales ----------

$("scanNowBtn").addEventListener("click", () => window.agent.scanNow())
$("pauseBtn").addEventListener("click", async () => {
  if (lastState.paused) await window.agent.resume()
  else await window.agent.pause()
})

// ---------- init ----------

window.agent.onStateUpdate(render)
window.agent.onAuthLost(async () => {
  await refreshConfig()
  $("loginError").textContent = "Session terminée : ce poste a été supprimé depuis Packspace ou le jeton a expiré. Reconnectez-vous."
})
refreshConfig()
window.agent.getState().then(render)
refreshUpdateBanner()
