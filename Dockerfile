# Stowly: ein Container, ein Prozess. Er liefert die Schnittstelle (/api), den Druckdienst
# (/print) und die gebaute Web-App auf Port 8010 und spricht nur HTTP. HTTPS stellt der
# Reverse Proxy davor bereit (Nginx Proxy Manager oder Tailscale), siehe README.md.
#
# In der Zielumgebung noch nicht gebaut: Auf dem Entwicklungsrechner gibt es kein Docker.

# ---------------------------------------------------------------- Web-App bauen
FROM node:26-slim AS web

WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------- Server
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Erst der Druckdienst, dann der Server, der ihn als Abhängigkeit braucht.
COPY print/ ./print/
COPY server/ ./server/
RUN pip install ./print ./server

COPY --from=web /src/web/dist ./web

# Eigener Benutzer; die Datenbank liegt im Volume /data.
RUN useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin stowly \
    && mkdir -p /data \
    && chown stowly:stowly /data
USER stowly

ENV STOWLY_HOST=0.0.0.0 \
    STOWLY_PORT=8010 \
    STOWLY_DATA_DIR=/data \
    STOWLY_WEB_DIR=/app/web

VOLUME ["/data"]
EXPOSE 8010

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8010/api/health', timeout=3)"]

CMD ["python", "-m", "stowly"]
