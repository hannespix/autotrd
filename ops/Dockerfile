# syntax=docker/dockerfile:1
# autotrd — Container-Image. Bauen aus dem Repo-Wurzelverzeichnis:
#   docker build -f ops/Dockerfile -t autotrd .
# Betrieb: ops/README.md (Config unter /etc/autotrd, State-Volume /var/lib/autotrd).

# ── Stufe 1: Build (TypeScript → dist/) ─────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# ── Stufe 2: Laufzeit — nur Produktions-Abhängigkeiten, kein root ───────────
FROM node:22-alpine
ENV NODE_ENV=production
ENV AUTOTRD_HOME=/var/lib/autotrd
WORKDIR /opt/autotrd
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN addgroup -S autotrd && adduser -S -G autotrd -h /opt/autotrd autotrd \
 && mkdir -p /var/lib/autotrd /etc/autotrd \
 && chown -R autotrd:autotrd /var/lib/autotrd /opt/autotrd
USER autotrd
VOLUME /var/lib/autotrd
# Der Status-Endpunkt lauscht nur auf 127.0.0.1 IM Container — bewusst kein
# EXPOSE. Abfrage: docker exec autotrd wget -qO- http://127.0.0.1:8787/status
# SIGINT = geordneter Stopp (Positionen und Broker-Stops bleiben liegen).
STOPSIGNAL SIGINT
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["run", "--config", "/etc/autotrd/config.yaml"]
