# PackSpace S3 Sync — image conteneur (Synology Container Manager, Docker,
# Portainer…) : le moteur de synchro en mode service (src/service.js, Node
# pur, sans Electron) + l'interface de pilotage servie en page web sur le
# port 47831 (jeton CONTROL_TOKEN obligatoire pour toute action).
#
#   docker build -t packspace-s3-sync .
#   docker run -d --name packspace-s3-sync --hostname NAS-ATELIER \
#     -p 47831:47831 -e CONTROL_TOKEN=un-long-secret \
#     -v /volume1/docker/packspace-s3-sync:/data -v /volume1/Impression:/sync \
#     packspace-s3-sync
#
# Voir docker-compose.yml et README (section Synology).
FROM node:20-alpine

LABEL org.opencontainers.image.title="PackSpace S3 Sync" \
      org.opencontainers.image.description="Synchronisation des fichiers d'impression Packspace (S3 → dossier local) — mode service pour NAS / Docker" \
      org.opencontainers.image.source="https://github.com/AbdelazizElbaz/PackSpaceS3Sync"

WORKDIR /app
COPY package.json package-lock.json ./
# Dépendances de production uniquement ; node-windows (optionnelle, Windows) exclue.
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY renderer ./renderer

ENV NODE_ENV=production \
    PACKSPACE_SYNC_DATA_DIR=/data \
    CONTROL_BIND=0.0.0.0 \
    CONTROL_PORT=47831 \
    SERVE_UI=1

# /data : config, manifestes, journal — /sync : dossiers de destination
VOLUME ["/data", "/sync"]
EXPOSE 47831

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:47831/ >/dev/null || exit 1

# Arrêt propre (SIGTERM → fermeture des téléchargements, reprise au redémarrage)
STOPSIGNAL SIGTERM
CMD ["node", "src/service.js"]
