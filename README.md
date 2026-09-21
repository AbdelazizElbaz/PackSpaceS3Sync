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

## Pilotage depuis l'app B2B

Depuis Packspace → Paramètres → **Synchro impression** (`/sync-agents`,
admin/opérateur), on voit chaque **poste** (PC) qui a démarré une session
de synchronisation, en ligne / hors ligne, avec le compte utilisé ; on y
modifie les **réglages** de parallélisme et les **instances** (dossier S3 →
dossier local), on suit l'**avancement en direct** (heartbeat toutes les
`pollIntervalMs`), et on consulte l'**historique** (fichiers synchronisés,
sessions, réglages) et les **erreurs**. Les commandes Pause / Reprendre /
Vérifier / Réessayer / Re-vérifier sont exécutées par l'agent au heartbeat
suivant.

Le serveur (`DesktopSyncController`) est la source de vérité pour les
réglages et les instances ; l'agent ne garde en local que les manifestes,
le jeton et un cache de la dernière config. Les instances créées dans une
ancienne version de l'agent sont importées au premier enregistrement du
poste. Chaque fichier synchronisé déclenche une notification in-app
(cloche du B2B) pour admin/opérateur ; chaque erreur aussi ; chaque
démarrage de session, pour les admins.

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

## Packager et publier (téléchargement depuis le B2B)

La publication est automatisée par `.github/workflows/release.yml` :

```bash
npm version 1.0.1            # met à jour package.json + crée le tag v1.0.1
git push && git push --tags  # déclenche "Release"
```

Ou bien onglet Actions → « Release » → *Run workflow* (version optionnelle,
sinon celle de `package.json`). Le job de publication s'exécute dans
l'**environnement GitHub `Prod`** (Settings → Environments → Prod) et y lit
les secrets `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` et les variables
`AWS_REGION` / `AWS_BUCKET` — mêmes valeurs que l'environnement Prod du
monorepo. Activez « Required reviewers » sur cet environnement pour exiger
votre validation avant l'envoi vers S3 (les builds tournent sans attendre).

Le workflow construit sur trois runners (`windows-latest`, `macos-latest`,
`ubuntu-latest`) les installeurs `PackSpace-S3-Sync-<version>-win-x64.exe`,
`…-mac-arm64.dmg`, `…-mac-x64.dmg`, `…-linux-x64.AppImage`, `…-linux-x64.deb`,
puis les envoie dans le bucket S3 principal sous
`desktop-agent/releases/<version>/` et écrit `desktop-agent/latest.json`.

Côté B2B, la page **Paramètres → Synchro impression** lit `latest.json` via
`GET /desktop/sync/releases` (API2, staff uniquement) et affiche une carte
« Installer l'agent sur un poste » avec les boutons de téléchargement par
système (URLs S3 présignées valables 1 h) et les étapes d'installation.

Build manuel sans CI (chaque OS depuis cet OS) :

```bash
npm run dist:win    # .exe NSIS
npm run dist:mac    # .dmg x64 + arm64 (signature/notarization à part)
npm run dist:linux  # .AppImage + .deb
```

Remplacer `build/icon.png` (512×512 ou 1024×1024) avant de packager.

### Installation sur un poste

1. Télécharger l'installeur depuis le B2B (ou `release/` après un build).
2. Windows : lancer le `.exe`, choisir le dossier, « Installer ». Les
   installeurs ne sont pas signés → SmartScreen : « Informations
   complémentaires » → « Exécuter quand même ». macOS : ouvrir le `.dmg`,
   glisser l'app dans Applications, puis clic droit → « Ouvrir » la première
   fois. Linux : `chmod +x *.AppImage && ./*.AppImage` ou
   `sudo dpkg -i *.deb`.
3. Au premier lancement : adresse de l'API (bouton « Tester »), puis
   connexion avec un compte administrateur ou opérateur.
4. Le poste apparaît « En ligne » dans le B2B ; y ajouter les dossiers à
   synchroniser (ou depuis l'agent).
5. L'agent démarre avec la session et vit dans la zone de notification.

Pour supprimer les avertissements de sécurité : certificat de signature
Windows (OV/EV) et Apple Developer ID + notarization, à brancher via les
variables `CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_ID` d'electron-builder
dans le workflow.

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
