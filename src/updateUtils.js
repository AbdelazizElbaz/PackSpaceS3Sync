// Petits utilitaires partagés entre engine.js (checkUpdate, juste une
// vérification) et selfUpdater.js (applyUpdate, le téléchargement +
// l'installation) — évite de dupliquer la logique de sélection d'installeur
// et de comparaison de version entre les deux.

// Correspondance process.platform → valeurs "os" du manifeste
// desktop-agent/latest.json (voir release.yml du dépôt PackSpaceS3Sync).
const PLATFORM_OS = { win32: "win", darwin: "mac", linux: "linux" }

// Pour Linux, "deb" est préféré à "appimage" : c'est le seul qui permette
// une installation silencieuse sans interaction (mode service, voir
// selfUpdater.js — dpkg -i). "installer" = l'exécutable NSIS (Windows) ou
// le .dmg (mac).
const KIND_PRIORITY = { installer: 0, deb: 1, appimage: 2 }

function pickAsset(assets, platformOs) {
  const candidates = (assets || []).filter((a) => a && a.os === platformOs)
  candidates.sort((a, b) => (KIND_PRIORITY[a.kind] ?? 9) - (KIND_PRIORITY[b.kind] ?? 9))
  return candidates[0] || null
}

// Compare deux versions "1.2.3" (préfixe "v" toléré) : renvoie true si `a`
// est strictement plus récente que `b`.
function isNewerVersion(a, b) {
  const pa = String(a || "")
    .replace(/^v/i, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0)
  const pb = String(b || "")
    .replace(/^v/i, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x > y
  }
  return false
}

module.exports = { PLATFORM_OS, KIND_PRIORITY, pickAsset, isNewerVersion }
