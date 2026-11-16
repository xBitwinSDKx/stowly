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
#
# Härtung (seit 0.3.0): In update/ schreibt der Server ohne Rechte, dieses Skript als root. Es folgt dort
# deshalb keinem Symlink. Es arbeitet im Ordner update/ selbst (nach "cd", geprüft mit pwd -P), schreibt
# jede Datei neu unter einem zufälligen Namen (noclobber, also O_EXCL) und benennt sie dann um (mit
# "mv -T", wo das mv des Systems es kann), hält das Log über einen offenen Dateideskriptor und kopiert nur
# echte Dateien. Die Anforderung holt es zuerst in einen eigenen Ordner (mktemp -d, nur root), erst dort
# liest es sie. Liegt ein Link vor, bricht es mit "failed" ab, ohne ihm zu folgen. Eine ältere Version
# als die eingestellte installiert es nie.

set -u
umask 022

UPDATER_VERSION=2
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

# Kann das mv dieses Systems -T (das Ziel nie als Ordner behandeln)? Geprüft an zwei eigenen Dateien
# in einem neuen Ordner unter /tmp des Rechners, nicht im Datenvolume. GNU mv kann es, ein altes
# BusyBox-mv womöglich nicht; dann bleibt es bei der Prüfung mit [ -d ] davor.
MV_T=""
mv_probe=$(mktemp -d 2>/dev/null) && {
  if : > "$mv_probe/a" && : > "$mv_probe/b" && mv -T "$mv_probe/a" "$mv_probe/b" 2>/dev/null; then
    MV_T="-T"
  fi
  rm -rf "$mv_probe"
}

# Schreibt stdin in eine Datei im aktuellen Ordner (update/): zuerst in eine neue Datei mit zufälligem
# Namen, angelegt mit noclobber (O_EXCL: folgt keinem Symlink, auch keinem vorher hingelegten), für alle
# lesbar über die umask (der Server ist uid 10001), dann umbenannt. Ein Symlink am Ziel wird ersetzt,
# nie verfolgt; ein Ordner am Ziel ist ein Fehler.
write_file() {
  if [ -d "$1" ]; then
    return 1
  fi
  tmp=$(mktemp -u "./.stowly-update.XXXXXXXXXX") || return 1
  if ! (set -C; cat > "$tmp") 2>/dev/null; then
    rm -f "$tmp"
    return 1
  fi
  # shellcheck disable=SC2086 # MV_T ist leer oder -T
  mv -f $MV_T "$tmp" "$1"
}

# Ist $1 neuer als $2? Beide X.Y.Z; verglichen werden die drei Zahlen.
newer_than() {
  [ "$1" != "$2" ] \
    && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t . -k1,1n -k2,2n -k3,3n | tail -n 1)" = "$1" ]
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
DATA=$(cd "$DATA" && pwd -P)

# Der Ordner update/: kein Symlink, und danach wirklich darin stehen. Wer ihn später ersetzt, lenkt
# nichts mehr um: Alles Weitere geschieht relativ zum Ordner, in dem das Skript dann steht.
UPDATE_DIR="$DATA/update"
if [ -L "$UPDATE_DIR" ]; then
  echo "$UPDATE_DIR ist ein Symlink; der Updater folgt ihm nicht und tut nichts." >&2
  exit 1
fi
if [ ! -e "$UPDATE_DIR" ]; then
  # Sonst legt ihn der Server an; gehört er root, könnte der Server dort nichts ablegen.
  mkdir "$UPDATE_DIR" && chown -h 10001:10001 "$UPDATE_DIR"
fi
if ! cd "$UPDATE_DIR" 2>/dev/null || [ "$(pwd -P)" != "$UPDATE_DIR" ]; then
  echo "$UPDATE_DIR ist kein echter Ordner; der Updater tut nichts." >&2
  exit 1
fi
printf 'seen_at=%s\nupdater=%s\nkind=script\n' "$(now)" "$UPDATER_VERSION" | write_file updater

REQUEST=request
if [ ! -e "$REQUEST" ] && [ ! -L "$REQUEST" ]; then
  exit 0
fi

NEW=""
OLD=$(env_value STOWLY_VERSION)
IMAGE=$(env_value STOWLY_IMAGE)

# Schreibt den Zustand für den Server (eine Zeile je Schlüssel, die Meldung ohne Zeilenumbruch).
set_state() {
  message=$(printf '%s' "$2" | tr '\r\n' '  ')
  printf 'state=%s\nversion=%s\nfrom=%s\nat=%s\nmessage=%s\n' "$1" "$NEW" "$OLD" "$(now)" "$message" \
    | write_file state
}

# Ein Symlink (oder ein Ordner) an einer der Dateien in update/: failed, ohne ihm zu folgen. Gelöscht
# werden nur die Links selbst.
LINKS=""
for name in request state log lock; do
  if [ -L "$name" ] || { [ "$name" != lock ] && [ -e "$name" ] && [ ! -f "$name" ]; }; then
    LINKS="$LINKS $name"
  fi
done
if [ -n "$LINKS" ]; then
  for name in $LINKS; do
    if [ -L "$name" ]; then
      rm -f "$name"
    elif [ "$name" != lock ] && [ -d "$name" ]; then
      rmdir "$name" 2>/dev/null
    fi
  done
  set_state failed "In update/ liegt ein Symlink oder keine echte Datei (${LINKS# }); der Updater folgt ihm nicht. Stowly läuft unverändert weiter."
  if [ ! -L "$REQUEST" ] && [ -f "$REQUEST" ]; then rm -f "$REQUEST"; fi
  echo "Symlink in $UPDATE_DIR:$LINKS. Abgebrochen." >&2
  exit 1
fi

LOCK=lock
if ! mkdir "$LOCK" 2>/dev/null; then
  # Eine Sperre, die älter als 30 Minuten ist, stammt von einem abgebrochenen Lauf.
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +"$STALE_LOCK_MIN" 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null
    mkdir "$LOCK" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi
REQUEST_DIR=""
trap 'if [ -n "$REQUEST_DIR" ]; then rm -rf "$REQUEST_DIR"; fi; rmdir "$LOCK" 2>/dev/null' EXIT
trap 'exit 1' INT TERM

# Das Log: eine neue Datei (noclobber), offen auf Deskriptor 3, dann unter dem Namen log. Alles
# Weitere schreibt über den Deskriptor, nie über den Namen.
LOG_TMP=$(mktemp -u "./.stowly-update.XXXXXXXXXX") || exit 1
set -C
exec 3>"$LOG_TMP"
set +C
# shellcheck disable=SC2086 # MV_T ist leer oder -T
mv -f $MV_T "$LOG_TMP" log
log() {
  line="$(now) $*"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >&3
}

# Die Anforderung holen: erst in einen eigenen Ordner umbenennen (rename folgt keinem Link; in den Ordner
# kommt nur root), dort prüfen, dass es eine echte Datei ist, und höchstens 4096 Bytes lesen. Danach ist
# sie aus update/ verschwunden; am Ende verschwindet der Ordner samt Anforderung.
REQUEST_DIR=$(mktemp -d "./.stowly-request.XXXXXXXXXX") || exit 1
if ! mv -f "$REQUEST" "$REQUEST_DIR/request" 2>/dev/null; then
  exit 0  # inzwischen weg
fi
if [ -f "$REQUEST_DIR/request" ] && [ ! -L "$REQUEST_DIR/request" ]; then
  NEW=$(head -c 4096 "$REQUEST_DIR/request" | tr -d '\r' | sed -n 's/^version=//p' | head -n 1)
else
  NEW=""
fi

# Das Ende jedes Updates: Ergebnis festhalten; die Anforderung liegt schon nicht mehr in update/.
finish() {
  set_state "$1" "$2"
  log "$2"
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
if [ "$OLD" != "$NEW" ] && ! newer_than "$NEW" "$OLD"; then
  finish failed "Die angeforderte Version $NEW ist älter als $OLD; der Updater geht nur vorwärts."
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
until docker pull "$IMAGE:$NEW" >&3 2>&1; do
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

# Kopiert eine Datei der Datenbank: nur eine echte Datei, nie auf einen Namen, an dem schon etwas liegt.
# Stowly steht dabei; wer vorher einen Link hingelegt hat, wird hier erkannt.
copy_real_file() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  [ ! -e "$2" ] && [ ! -L "$2" ] || return 1
  cp -p "$1" "$2"
}

DB="$DATA/stowly.sqlite3"
BACKUP="before-$OLD-$(date -u +%Y%m%dT%H%M%SZ).sqlite3"

log "Halte Stowly an."
compose stop "$SERVICE" >&3 2>&1
if [ "$(docker inspect --format '{{ .State.Running }}' "$CONTAINER" 2>/dev/null)" = "true" ]; then
  finish failed "Stowly ließ sich nicht anhalten. Es läuft weiter mit $OLD."
fi
backup_ok=1
copy_real_file "$DB" "$BACKUP" || backup_ok=0
for suffix in -wal -shm; do
  if [ -L "$DB$suffix" ]; then
    backup_ok=0
  elif [ -e "$DB$suffix" ]; then
    copy_real_file "$DB$suffix" "$BACKUP$suffix" || backup_ok=0
  fi
done
if [ "$backup_ok" -ne 1 ]; then
  log "Die Datenbank ist keine echte Datei (Symlink?) oder die Kopie ging nicht."
  compose up -d "$SERVICE" >&3 2>&1
  finish failed "Die Datenbank ließ sich nicht sichern. Stowly läuft weiter mit $OLD."
fi
# Nur die drei neuesten Kopien bleiben.
ls -1t before-*.sqlite3 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | while read -r old_copy; do
  rm -f "$old_copy" "$old_copy-wal" "$old_copy-shm"
done

cp -p "$ENV_FILE" "$ENV_FILE.bak"
set_env_version "$NEW"
log "Starte Stowly $NEW."
compose up -d "$SERVICE" >&3 2>&1

if [ "$(running_image)" = "$IMAGE:$NEW" ] && wait_healthy; then
  # Alte Images aufräumen; die neue und die vorige Version bleiben für eine Rückkehr.
  docker images "$IMAGE" --format '{{ .Tag }}' 2>/dev/null | grep -E "$VERSION_RE" \
    | grep -v -x -e "$NEW" -e "$OLD" | while read -r tag; do
      docker rmi "$IMAGE:$tag" >&3 2>&1
    done
  finish done "Aktualisiert von $OLD auf $NEW."
fi

log "Die neue Version wurde nicht healthy. Letzte Zeilen ihres Logs:"
docker logs --tail 50 "$CONTAINER" >&3 2>&1
compose stop "$SERVICE" >&3 2>&1
# Zurückspielen; ein Link an der Datenbank wird entfernt, nie verfolgt.
for name in "$DB" "$DB-wal" "$DB-shm"; do
  if [ -L "$name" ]; then rm -f "$name"; fi
done
rm -f "$DB-wal" "$DB-shm"
if [ -f "$BACKUP" ] && [ ! -L "$BACKUP" ]; then
  cp -p "$BACKUP" "$DB"
fi
for suffix in -wal -shm; do
  if [ -f "$BACKUP$suffix" ] && [ ! -L "$BACKUP$suffix" ]; then cp -p "$BACKUP$suffix" "$DB$suffix"; fi
done
set_env_version "$OLD"
compose up -d "$SERVICE" >&3 2>&1
if wait_healthy; then
  finish failed "Die neue Version startete nicht, zurück auf $OLD."
fi
finish failed "Die neue Version startete nicht, und $OLD startet auch nicht mehr. Bitte auf dem Rechner nachsehen (update/log im Datenvolume)."
