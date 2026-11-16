#!/bin/sh
# Stowly-Updater (docs/integrationen.md, Abschnitt 10.6; Anleitung: docs/betrieb.md, Abschnitt 9).
#
# Läuft jede Minute als root: auf Synology DSM über den Aufgabenplaner, auf Debian über einen
# systemd-Timer. Jeder Lauf meldet sich beim Stowly-Server (Datei "updater" im Datenvolume) und tut
# sonst nur etwas, wenn der Server eine Anforderung ("request") abgelegt hat. Dann:
#   Image laden, Stowly anhalten, Datenbank kopieren, STOWLY_VERSION in der .env umstellen, starten,
#   auf "healthy" warten; startet die neue Version nicht, die Kopie zurückspielen und die alte starten.
#
# Liest aus der .env des Projekts (ohne sie auszuführen): STOWLY_IMAGE, STOWLY_VERSION, STOWLY_VOLUME.
# Nur POSIX-sh und Werkzeuge, die DSM 6.2 und Debian haben; kein jq, kein Python.

set -u

UPDATER_VERSION=1
# Nach den eigenen Pfaden des Aufrufers: Auf DSM liegt docker unter /usr/local/bin.
PATH="$PATH:/usr/local/bin:/usr/local/sbin:/usr/sbin:/sbin:/usr/bin:/bin"
export PATH

PROJECT_DIR=${STOWLY_PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
ENV_FILE="$PROJECT_DIR/.env"
SERVICE=stowly
CONTAINER=${STOWLY_CONTAINER:-stowly}
PULL_TRIES=${STOWLY_PULL_TRIES:-3}
HEALTH_TRIES=${STOWLY_HEALTH_TRIES:-36}   # 36 × 5 s = 3 Minuten
POLL_S=${STOWLY_UPDATER_POLL_S:-5}
PULL_PAUSE_S=${STOWLY_PULL_PAUSE_S:-10}
KEEP_BACKUPS=3
STALE_LOCK_MIN=30
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+$'

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Ein Wert aus der .env, ohne sie auszuführen: die letzte Zeile NAME=…, Anführungszeichen weg.
env_value() {
  [ -f "$ENV_FILE" ] || return 0
  tr -d '\r' < "$ENV_FILE" \
    | sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" \
    | tail -n 1 \
    | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# Schreibt stdin in eine Datei: erst daneben, dann umbenannt; für alle lesbar (der Server ist uid 10001).
write_file() {
  tmp="$1.tmp.$$"
  cat > "$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$1"
}

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "Weder 'docker compose' noch 'docker-compose' gefunden." >&2
  exit 1
fi
compose() { (cd "$PROJECT_DIR" && $COMPOSE "$@"); }

VOLUME=${STOWLY_VOLUME:-$(env_value STOWLY_VOLUME)}
VOLUME=${VOLUME:-stowly_stowly-data}
DATA=$(docker volume inspect --format '{{ .Mountpoint }}' "$VOLUME" 2>/dev/null)
if [ -z "$DATA" ] || [ ! -d "$DATA" ]; then
  echo "Das Datenvolume $VOLUME gibt es nicht (STOWLY_VOLUME in der .env setzen)." >&2
  exit 1
fi

UPDATE_DIR="$DATA/update"
if [ ! -d "$UPDATE_DIR" ]; then
  # Sonst legt ihn der Server an; gehört er root, könnte der Server dort nichts ablegen.
  mkdir -p "$UPDATE_DIR" && chown 10001:10001 "$UPDATE_DIR"
fi
printf 'seen_at=%s\nupdater=%s\n' "$(now)" "$UPDATER_VERSION" | write_file "$UPDATE_DIR/updater"

REQUEST="$UPDATE_DIR/request"
[ -f "$REQUEST" ] || exit 0

LOCK="$UPDATE_DIR/lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  # Eine Sperre, die älter als 30 Minuten ist, stammt von einem abgebrochenen Lauf.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +"$STALE_LOCK_MIN" 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null
    mkdir "$LOCK" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
trap 'exit 1' INT TERM

LOG="$UPDATE_DIR/log"
: > "$LOG"
chmod 644 "$LOG"
log() { printf '%s %s\n' "$(now)" "$*" | tee -a "$LOG"; }

req_value() { tr -d '\r' < "$REQUEST" | sed -n "s/^$1=//p" | head -n 1; }
NEW=$(req_value version)
OLD=$(env_value STOWLY_VERSION)
IMAGE=$(env_value STOWLY_IMAGE)

# Schreibt den Zustand für den Server (eine Zeile je Schlüssel, die Meldung ohne Zeilenumbruch).
set_state() {
  message=$(printf '%s' "$2" | tr '\r\n' '  ')
  printf 'state=%s\nversion=%s\nfrom=%s\nat=%s\nmessage=%s\n' "$1" "$NEW" "$OLD" "$(now)" "$message" \
    | write_file "$UPDATE_DIR/state"
}

# Das Ende jedes Updates: Ergebnis festhalten, Anforderung löschen.
finish() {
  set_state "$1" "$2"
  log "$2"
  rm -f "$REQUEST"
  if [ "$1" = done ]; then exit 0; fi
  exit 1
}

log "Anforderung: Version '$NEW' (eingestellt: '$OLD', Image: '$IMAGE')."
if ! printf '%s' "$NEW" | grep -Eq "$VERSION_RE"; then
  NEW=""
  finish failed "Die Anforderung nennt keine gültige Version."
fi
if [ -z "$IMAGE" ] || [ -z "$OLD" ]; then
  finish failed "STOWLY_IMAGE und STOWLY_VERSION müssen in der .env stehen (docs/betrieb.md, Abschnitt 9)."
fi
if ! printf '%s' "$OLD" | grep -Eq "$VERSION_RE"; then
  finish failed "STOWLY_VERSION in der .env ist keine Version wie 1.2.3."
fi

# Läuft der Container mit dem Image einer Version? Liefert 0 bei "healthy".
running_image() { docker inspect --format '{{ .Config.Image }}' "$CONTAINER" 2>/dev/null; }
wait_healthy() {
  tries=0
  while [ "$tries" -lt "$HEALTH_TRIES" ]; do
    status=$(docker inspect --format '{{ if .State.Health }}{{ .State.Health.Status }}{{ else }}{{ .State.Status }}{{ end }}' "$CONTAINER" 2>/dev/null)
    case "$status" in
      healthy) return 0 ;;
      unhealthy | exited | dead) return 1 ;;
    esac
    tries=$((tries + 1))
    sleep "$POLL_S"
  done
  return 1
}

if [ "$OLD" = "$NEW" ]; then
  # Ein früherer Lauf brach nach dem Umstellen ab: Läuft die Version, ist das Update fertig.
  if [ "$(running_image)" = "$IMAGE:$NEW" ] && wait_healthy; then
    finish done "Stowly läuft mit $NEW."
  fi
  finish failed "Version $NEW ist schon eingestellt, läuft aber nicht. Bitte auf dem Rechner nachsehen."
fi

set_state installing "Lade $IMAGE:$NEW."
tries=1
until docker pull "$IMAGE:$NEW" >> "$LOG" 2>&1; do
  if [ "$tries" -ge "$PULL_TRIES" ]; then
    finish failed "Das Image $IMAGE:$NEW ließ sich nicht laden. Stowly läuft weiter mit $OLD."
  fi
  tries=$((tries + 1))
  sleep "$PULL_PAUSE_S"
done

# In die vorhandene Datei schreiben, nicht ersetzen: So bleiben Besitzer und Rechte der .env.
set_env_version() {
  tmp="$ENV_FILE.stowly-update.$$"
  if grep -q '^[[:space:]]*STOWLY_VERSION[[:space:]]*=' "$ENV_FILE"; then
    sed "s/^[[:space:]]*STOWLY_VERSION[[:space:]]*=.*/STOWLY_VERSION=$1/" "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp"
    printf 'STOWLY_VERSION=%s\n' "$1" >> "$tmp"
  fi
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

DB="$DATA/stowly.sqlite3"
BACKUP="$UPDATE_DIR/before-$OLD-$(date -u +%Y%m%dT%H%M%SZ).sqlite3"

log "Halte Stowly an."
compose stop "$SERVICE" >> "$LOG" 2>&1
if [ "$(docker inspect --format '{{ .State.Running }}' "$CONTAINER" 2>/dev/null)" = "true" ]; then
  finish failed "Stowly ließ sich nicht anhalten. Es läuft weiter mit $OLD."
fi
if ! cp -p "$DB" "$BACKUP"; then
  compose up -d "$SERVICE" >> "$LOG" 2>&1
  finish failed "Die Datenbank ließ sich nicht sichern. Stowly läuft weiter mit $OLD."
fi
for suffix in -wal -shm; do
  if [ -f "$DB$suffix" ]; then cp -p "$DB$suffix" "$BACKUP$suffix"; fi
done
# Nur die drei neuesten Kopien bleiben.
ls -1t "$UPDATE_DIR"/before-*.sqlite3 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | while read -r old_copy; do
  rm -f "$old_copy" "$old_copy-wal" "$old_copy-shm"
done

cp -p "$ENV_FILE" "$ENV_FILE.bak"
set_env_version "$NEW"
log "Starte Stowly $NEW."
compose up -d "$SERVICE" >> "$LOG" 2>&1

if [ "$(running_image)" = "$IMAGE:$NEW" ] && wait_healthy; then
  # Alte Images aufräumen; die neue und die vorige Version bleiben für eine Rückkehr.
  docker images "$IMAGE" --format '{{ .Tag }}' 2>/dev/null | grep -E "$VERSION_RE" \
    | grep -v -x -e "$NEW" -e "$OLD" | while read -r tag; do
      docker rmi "$IMAGE:$tag" >> "$LOG" 2>&1
    done
  finish done "Aktualisiert von $OLD auf $NEW."
fi

log "Die neue Version wurde nicht healthy. Letzte Zeilen ihres Logs:"
docker logs --tail 50 "$CONTAINER" >> "$LOG" 2>&1
compose stop "$SERVICE" >> "$LOG" 2>&1
cp -p "$BACKUP" "$DB"
rm -f "$DB-wal" "$DB-shm"
for suffix in -wal -shm; do
  if [ -f "$BACKUP$suffix" ]; then cp -p "$BACKUP$suffix" "$DB$suffix"; fi
done
set_env_version "$OLD"
compose up -d "$SERVICE" >> "$LOG" 2>&1
if wait_healthy; then
  finish failed "Die neue Version startete nicht, zurück auf $OLD."
fi
finish failed "Die neue Version startete nicht, und $OLD startet auch nicht mehr. Bitte auf dem Rechner nachsehen (update/log im Datenvolume)."
