# PackSpace S3 Sync

Agent desktop (Windows / macOS / Linux, Electron) qui tourne en arrière-plan
(icône dans la zone de notification) et synchronise **automatiquement et en
multi-thread** les dossiers d'impression Packspace (S3, dossier `PrintProd`)
vers des dossiers locaux de l'atelier.

Successeur de `desktop-print-agent/` (monorepo Packspace), qui ne
téléchargeait qu'un fichier à la fois et ne savait pas surveiller un dossier.

## Principe : les instances de synchronisation

1. **Connexion** (une fois) avec un compte Packspace **administrateur ou opérateur** (les autres rôles sont refusés, côté agent et côté API2) → `POST /login`, puis
   `POST /desktop/agent-token` : jeton Sanctum dédié `desktop-agent`, valable
   **1 an**, préservé par les reconnexions web du même compte. Le mot de
   passe n'est jamais stocké.
2. **Explorateur S3** (colonne de gauche) : parcourt l'arborescence du
   dossier d'impression via `GET /desktop/s3/browse?prefix=`, en s'ouvrant
   directement sur `PrintProd/PrintWorkSpace` — machines,
   dates, types, clients, commandes, fichiers avec leur taille. Toujours
   contraint sous `PrintProd/PrintWorkSpace` côté API2 (`AWS_BUCKET_PRINTNAME` /
   `AWS_BUCKET_WRKSPACE`).
3. **« Synchroniser ce dossier… »** crée une **instance** : un dossier S3
   (préfixe) → un dossier local. Autant d'instances que voulu (une par
   machine, par jour, par client…).
4. Toutes les N secondes, chaque instance active liste récursivement son
   préfixe (`GET /desktop/s3/objects`, paginé) et compare avec son
   **manifeste local** (clé → taille + etag). Dès qu'un fichier est copié
   dans S3 (nouveau ou modifié), il est mis en file.
5. La file est servie par un **pool de worker threads** (`worker_threads`,
   un fichier par thread, `maxParallelFiles` en parallèle). Chaque thread :
   - demande une URL S3 présignée à API2 (`POST /s3file/presignDownload`) ;
   - télécharge **en direct depuis S3/CloudFront**, jamais via Laravel ;
   - fichier < `chunkThresholdMb` → un flux ; sinon morceaux de
     `chunkSizeMb`, `maxParallelChunks` requêtes `Range` simultanées,
     concaténation ordonnée + `rename` atomique ;
   - **reprise** des `.part` / `.chunks/part-N` existants ; un fichier déjà
     complet sur disque n'est pas re-téléchargé.
6. **Retry** : `maxRetries` tentatives avec backoff exponentiel ; URL
   expirée (403) → re-signée immédiatement.
7. Une fois écrit, le fichier est inscrit dans le manifeste et
   l'arborescence S3 relative est reproduite sous le dossier local
   (`<local>/<type>/<client>/<commande>/fichier.pdf`).

L'UI affiche, par instance, une barre « N/M fichiers synchronisés », l'état
(à jour / en cours / erreur), et en dessous la liste des fichiers en cours
avec **barre de progression, octets reçus, vitesse et numéro de tentative**.
Le tooltip du tray résume l'activité (nb de fichiers, débit cumulé).

Côté backend : `API2/app/Http/Controllers/DesktopFilesController.php`
(`browse`, `listObjects`, `agentToken`), `S3FileController::presignDownload`.

## Développement

```bash
npm install
npm start          # lance l'app (tray + fenêtre)
npm run check      # node --check sur tous les fichiers JS
```

Adresse de l'API : l'hôte suffit (`/api` ajouté automatiquement), ex.
`https://api.om.packspace.ma`. Le bouton « Tester » appelle `GET /api/ping`
(healthcheck public) et vérifie que les endpoints de synchro sont déployés.
Fermer la fenêtre la masque seulement ;
« Quitter » dans le menu du tray arrête réellement l'agent.

## Réglages (bouton « Réglages »)

| Réglage | Défaut | Rôle |
|---|---|---|
| Fichiers en parallèle | min(4, nb CPU) | nombre de worker threads |
| Morceaux par fichier | 4 | requêtes Range simultanées par fichier |
| Taille d'un morceau | 8 Mo | |
| Découper à partir de | 16 Mo | en dessous : flux unique |
| Vérification des dossiers | 5 s | fréquence de scan des instances |
| Tentatives max | 3 | avant état « Échec » |

Ils prennent effet immédiatement, sans redémarrage.

## Actions par instance

- **Désactiver / Activer** : suspend le scan et les téléchargements de
  cette instance, sans la supprimer.
- **Dossier** : ouvre le dossier local.
- **Réessayer (n)** : remet en file les fichiers en échec.
- **Re-vérifier** : oublie le manifeste et recompare tout avec S3 (les
  fichiers déjà présents à la bonne taille ne sont pas re-téléchargés).
- **Supprimer** : retire l'instance ; les fichiers locaux restent.

## Packager

```bash
npm run dist:win    # .exe NSIS (depuis Windows)
npm run dist:mac    # .dmg/.zip (depuis macOS ; signature/notarization à part)
npm run dist:linux  # .AppImage/.deb
```

Remplacer `build/icon.png` (512×512 ou 1024×1024) avant de packager.
Packager chaque OS depuis cet OS (ou via des runners CI
`windows-latest` / `macos-latest` / `ubuntu-latest`).

## Config locale

`electron-store` → fichier JSON dans le dossier de données de l'app :
adresse API, jeton agent, instances, manifestes, réglages, démarrage auto.

## Limites connues

- Un seul agent par compte : régénérer le jeton (nouvelle connexion) révoque
  celui du poste précédent.
- Détection des changements par taille + etag S3, pas de checksum local
  après téléchargement.
- Les suppressions côté S3 ne sont pas répercutées localement (volontaire :
  on ne supprime jamais un fichier d'impression sur le poste).
- Le scan est un polling (pas de notification S3 push) : latence = intervalle
  de vérification.
