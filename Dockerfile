# Stowly: ein Container, ein Prozess. Er liefert die Schnittstelle (/api), den Druckdienst (/print)
# und die gebaute Web-App: über HTTP auf Port 8010 und über HTTPS auf Port 8443, mit einer eigenen
# Zertifizierungsstelle in /data/tls (docs/integrationen.md, Abschnitt 11). Ein Reverse Proxy davor
# geht weiter, ist aber nicht mehr nötig. Dazu liegt das Paket für den Raspberry Pi bei
# (/api/pi/bundle.tar.gz), und aus demselben Image läuft auch der Updater-Container
# (python -m stowly.updater, docs/integrationen.md, 10.7).
#
# Auf dem Entwicklungsrechner gibt es kein Docker. Gebaut ist das Image bisher auf einer Synology
# mit DSM 6.2.4 (docs/betrieb.md, Abschnitt 4.4); die Prüfliste steht in docs/pruefliste.md.

# ---------------------------------------------------------------- Web-App bauen
FROM node:26-slim AS web

WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------- Paket für den Raspberry Pi
# pi/ und der Druckdienst aus print/ als immer gleiches tar.gz (server/stowly/pi_bundle.py, nur
# Standardbibliothek, ohne installiertes Stowly). Der Server liefert es aus STOWLY_PI_BUNDLE aus
# (docs/sync-protokoll.md, 11.8).
FROM python:3.12-slim AS pi-bundle

COPY pi/ /src/pi/
COPY print/pyproject.toml print/requirements-brother.txt /src/print/
COPY print/stowly_print/ /src/print/stowly_print/
COPY server/stowly/pi_bundle.py /build/pi_bundle.py
RUN python -I /build/pi_bundle.py /src /out/pi-bundle.tar.gz

# ---------------------------------------------------------------- Server
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Für den Druck: die Schriften der Etiketten als Rückfall (DejaVu; der Druckdienst bringt sie in
# seinem Paket selbst mit, docs/etiketten.md 3.4) und libusb für einen Brother-Drucker am USB
# (zuschaltbar über docker-compose.usb.yml).
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-dejavu-core libusb-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Python-Pakete: Jede Datei, die von PyPI kommt, ist auf Version und Prüfsumme festgelegt, und
# nichts wird aufgelöst (docs/betrieb.md, Abschnitt 9.1):
#  1. alle Abhängigkeiten aus server/requirements.lock, nur fertige Wheels, dazu setuptools,
#  2. Druckdienst und Server aus dem Quelltext, gebaut mit diesem setuptools, ohne PyPI,
#  3. die Brother-Bibliothek (print/requirements-brother.txt; GPL-3.0, nur im Treiber-Modul
#     geladen), nur mit STOWLY_BROTHER=1 (Vorgabe). packbits gibt es nur als Quellpaket; auch das
#     baut dieses setuptools. Das öffentliche Image aus GitHub Actions entsteht mit
#     STOWLY_BROTHER=0 und enthält so nichts unter der GPL: Ein Brother-Drucker am Server meldet
#     dort "config"; wer einen braucht, baut das Image selbst (docs/betrieb.md, Abschnitt 14.5).
# setuptools braucht nur der Bau. pip check bricht ab, wenn danach eine Abhängigkeit fehlt.
# Installiert wird nach site-packages; die Quellen bleiben nicht im Image. Seit Stufe 2 sind darunter
# cryptography mit cffi (Web-Push, seit 0.3.0 auch die CA), pyrage (Sicherungen im Format age) und
# tzdata (Zeitzonen, denn das schlanke Image bringt keine eigenen mit): alle als fertige Wheels, ohne
# Compiler im Image.
ARG STOWLY_BROTHER=1
COPY print/ /src/print/
COPY server/ /src/server/
RUN pip install --no-deps --require-hashes --only-binary=:all: -r /src/server/requirements.lock \
    && pip install --no-deps --no-build-isolation --no-index /src/print /src/server \
    && if [ "$STOWLY_BROTHER" = "1" ]; then \
         pip install --no-deps --no-build-isolation --require-hashes -r /src/print/requirements-brother.txt; \
       fi \
    && pip uninstall --yes setuptools \
    && pip check \
    && rm -rf /src

WORKDIR /app
COPY --from=web /src/web/dist ./web
COPY --from=pi-bundle /out/pi-bundle.tar.gz ./pi-bundle.tar.gz

# Eigener Benutzer ohne Rechte; Datenbank, Auftragsspeicher, Etikett-Bilder und die CA liegen im
# Volume /data (/data/stowly.sqlite3, /data/print/, /data/tls/). Den Ordner der automatischen
# Sicherungen (/backups) legt das Image absichtlich nicht an: Er kommt aus docker-compose.yml
# (./backups). Fehlt die Einbindung, meldet der Server „Der Ordner für Sicherungen fehlt." statt die
# Sicherungen unbemerkt in den Container zu schreiben. Ein Ordner, den DSM über die Oberfläche
# anlegt, ist für uid 10001 beschreibbar (docs/plan-einrichtung.md, Abschnitt 5).
RUN useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin stowly \
    && mkdir -p /data \
    && chown stowly:stowly /data
USER stowly

# Woher das Image stammt (ohne Tag), unter welchem Tag es erscheint (bei einer Vorabversion etwa
# 0.3.1-rc.1, obwohl sich der Server als 0.3.1 meldet) und das Repository der Releases für den Schalter
# „Nach Updates suchen" in der App. Das veröffentlichte Image setzt alle drei
# (.github/workflows/release.yml); bei einem eigenen Bau bleiben sie leer, und leer heißt: nicht gesetzt.
ARG STOWLY_IMAGE_REF=""
ARG STOWLY_IMAGE_TAG=""
ARG STOWLY_UPDATE_REPO_DEFAULT=""

ENV STOWLY_HOST=0.0.0.0 \
    STOWLY_PORT=8010 \
    STOWLY_HTTPS_PORT=8443 \
    STOWLY_DATA_DIR=/data \
    STOWLY_WEB_DIR=/app/web \
    STOWLY_PI_BUNDLE=/app/pi-bundle.tar.gz \
    STOWLY_IMAGE_REF=${STOWLY_IMAGE_REF} \
    STOWLY_IMAGE_TAG=${STOWLY_IMAGE_TAG} \
    STOWLY_UPDATE_REPO_DEFAULT=${STOWLY_UPDATE_REPO_DEFAULT}

VOLUME ["/data"]
EXPOSE 8010 8443

# Fragt denselben Endpunkt ab wie die App (docs/sync-protokoll.md, 9.5), über HTTP.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/health' % os.environ.get('STOWLY_PORT', '8010'), timeout=3)"]

CMD ["python", "-m", "stowly"]
