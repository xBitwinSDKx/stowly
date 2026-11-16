#!/usr/bin/env bash
# Stowly-Druckdienst auf dem Raspberry Pi installieren.
#
# Für Raspberry Pi OS Lite (Trixie, Python 3.13), auch auf dem Pi Zero W (32 Bit). Anleitung:
# pi/README.md. In der Zielumgebung ungetestet; die Prüfliste steht in der Anleitung.
#
#   sudo bash pi/install.sh --pair http://192.168.1.10:8010 ABCD-EFGH   # koppeln (Befehl aus der App)
#   sudo bash pi/install.sh --origin https://stowly.home                # von Hand
#   sudo bash pi/install.sh --origin https://stowly.home --cert pi.crt --key pi.key
#   sudo bash pi/install.sh --offline        # erneut, ohne Internet (Aktualisieren)
#
# --pair ruft das Startskript des Stowly-Servers auf (curl … /api/pi/install.sh | sudo sh -s -- CODE,
# docs/sync-protokoll.md 11.8): Der Pi meldet sich gleich bei Stowly, installiert, was fehlt, koppelt
# sich (Zertifikat, Token, Drucker in Stowly), startet den Dienst und prüft ihn samt Testetikett.
# Ein zweiter Lauf mit neuem Code koppelt neu, ohne alles neu zu installieren.
#
# Was das Skript tut, sagt es vor jedem Schritt. Es ist wiederholbar: Ein zweiter Lauf bringt
# Programm, Dienst und Regeln auf den Stand dieses Ordners und lässt eine vorhandene
# Konfiguration samt Token stehen. Bei einem Fehler bricht es ab.
#
# Es braucht Internet für fehlende Pakete (Debian/Raspberry Pi) und die Brother-Bibliothek von PyPI,
# außer mit --offline. Den Access Point richtet erst access-point.sh ein: erst installieren, dann
# umschalten.
set -euo pipefail
# Python läuft überall mit -P: Der Arbeitsordner (etwa das Home des Benutzers) kommt so nicht in
# sys.path, und keine Datei dort ersetzt ein Modul wie json oder ssl. (python3 --version braucht es nicht.)

PREFIX=/opt/stowly-print
CONFIG_DIR=/etc/stowly-print
CONFIG="$CONFIG_DIR/stowly-print.toml"
TLS_DIR="$CONFIG_DIR/tls"
STATE_DIR=/var/lib/stowly-print
SERVICE_USER=stowly-print
UNIT=/etc/systemd/system/stowly-print.service
UDEV_RULE=/etc/udev/rules.d/99-stowly-brother.rules
JOURNALD_CONF=/etc/systemd/journald.conf.d/stowly.conf
AP_MARKER=/etc/dnsmasq.d/stowly-ap.conf
# So lange wartet apt auf eine Sperre: Gleich nach dem ersten Start lädt apt-daily im Hintergrund.
APT_LOCK_TIMEOUT=300

# Alle gibt es in Trixie für arm64 (Debian) und armhf (Raspbian, Zero W); geprüft am 14.11.2026
# in den Paketlisten von Debian (qa.debian.org/madison.php), raspbian.raspberrypi.com und
# archive.raspberrypi.com. python3-setuptools (78.1.1) baut Druckdienst und packbits
# (--no-build-isolation), ohne dass pip etwas ungeprüft lädt. overlayroot braucht erst
# overlay.sh, ganz am Ende, wenn es im WLAN des Pi kein Internet mehr gibt; raspi-config holte es
# sonst aus dem Netz.
PACKAGES=(
  python3-pil python3-usb python3-segno python3-starlette python3-uvicorn
  python3-venv python3-setuptools
  fonts-dejavu-core libusb-1.0-0 openssl qrencode
  hostapd dnsmasq overlayroot
)

ORIGINS=()
MODEL="QL-800"
MODEL_SET=0
ADDRESS="usb://04f9"
ADDRESS_SET=0
CERT=""
KEY=""
WITH_BROTHER=1
OFFLINE=0
# Koppeln (--pair): Adresse des Stowly-Servers und Code. --address ist die Adresse des Druckers.
PAIR_SERVER=""
PAIR_CODE=""

usage() {
  cat <<'EOF'
Aufruf: sudo bash pi/install.sh [Angaben]

  --pair SERVER CODE   mit Stowly koppeln, etwa --pair http://192.168.1.10:8010 ABCD-EFGH
                       (so ruft es der Befehl aus der App auf; Zertifikat, Token und Ursprünge
                       kommen dann von Stowly, --cert und --key entfallen)
  --origin URL         Ursprung der App, die direkt drucken darf, z. B. https://stowly.home
                       (mehrfach möglich; von Hand nur beim ersten Lauf, danach in der
                       Konfiguration; mit --pair zusätzlich zu denen von Stowly)
  --model NAME         Modell des Druckers (Vorgabe QL-800; auch QL-810W, QL-820NWB; mit --pair
                       nur, wenn am USB keiner erkannt wird)
  --address ADRESSE    Adresse des Druckers (Vorgabe usb://04f9 = erster Brother am USB;
                       genauer usb://04f9:209b, im Netz tcp://192.168.1.60:9100)
  --cert DATEI         Zertifikat für HTTPS (aus pi/make-cert.sh), zusammen mit --key
  --key DATEI          Schlüssel dazu
  --without-brother    ohne die Brother-Bibliothek (nur Bild-Treiber)
  --offline            ohne Internet: keine Pakete, keine Brother-Bibliothek laden, nur das
                       Programm aus diesem Ordner neu einspielen (zum Aktualisieren)
  -h, --help           diese Hilfe
EOF
}

step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
fail() {
  printf '\nFEHLER: %s\n' "$*" >&2
  exit 1
}

CALL="$0 $*"
while [ $# -gt 0 ]; do
  case "$1" in
    --pair)
      [ $# -ge 3 ] || fail "--pair braucht Server und Code, etwa --pair http://192.168.1.10:8010 ABCD-EFGH"
      PAIR_SERVER="$2"
      PAIR_CODE="$3"
      shift 3
      ;;
    --origin | --model | --address | --cert | --key)
      [ $# -ge 2 ] || fail "$1 braucht einen Wert (Hilfe: --help)"
      case "$1" in
        --origin) ORIGINS+=("$2") ;;
        --model) MODEL="$2"; MODEL_SET=1 ;;
        --address) ADDRESS="$2"; ADDRESS_SET=1 ;;
        --cert) CERT="$2" ;;
        --key) KEY="$2" ;;
      esac
      shift 2
      ;;
    --without-brother) WITH_BROTHER=0; shift ;;
    --offline) OFFLINE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) fail "Unbekannte Angabe: $1 (Hilfe: --help)" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# ---------------------------------------------------------------- Angaben prüfen
step "Angaben prüfen"
[ "$(id -u)" -eq 0 ] || fail "Bitte mit sudo starten: sudo bash $CALL"
[ -f "$REPO_DIR/print/pyproject.toml" ] || fail "Neben pi/ fehlt der Ordner print/ ($REPO_DIR/print). Bitte den ganzen Ordner auf den Pi kopieren."
for origin in "${ORIGINS[@]}"; do
  [[ "$origin" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] \
    || fail "--origin $origin: erwartet Schema und Rechner ohne Pfad, etwa https://stowly.home"
done
[[ "$MODEL" =~ ^[A-Za-z0-9-]{2,40}$ ]] || fail "--model $MODEL ist kein Modellname (etwa QL-800)."
[[ "$ADDRESS" =~ ^(usb|tcp)://[A-Za-z0-9.:_/-]+$ ]] || fail "--address $ADDRESS: erwartet usb://04f9:209b oder tcp://Adresse:9100"
if [ -n "$PAIR_SERVER" ]; then
  [[ "$PAIR_SERVER" =~ ^https?://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?$ ]] \
    || fail "--pair $PAIR_SERVER: erwartet die Adresse von Stowly, etwa http://192.168.1.10:8010"
  [[ "$PAIR_CODE" =~ ^[A-Za-z0-9\ -]{8,20}$ ]] || fail "--pair: '$PAIR_CODE' ist kein Kopplungscode (etwa ABCD-EFGH)."
  [ -z "$CERT$KEY" ] || fail "--cert und --key passen nicht zu --pair: Das Zertifikat kommt beim Koppeln von Stowly."
elif [ -n "$CERT$KEY" ]; then
  [ -n "$CERT" ] && [ -n "$KEY" ] || fail "--cert und --key gehören zusammen."
  [ -f "$CERT" ] || fail "Zertifikat $CERT gibt es nicht."
  [ -f "$KEY" ] || fail "Schlüssel $KEY gibt es nicht."
fi
note "Ordner: $REPO_DIR"
if [ -n "$PAIR_SERVER" ]; then
  note "Koppeln mit Stowly unter $PAIR_SERVER"
else
  note "Drucker: $MODEL an $ADDRESS"
fi
if [ ${#ORIGINS[@]} -gt 0 ]; then
  note "Ursprünge der App: ${ORIGINS[*]}"
fi

# ---------------------------------------------------------------- System
step "System prüfen"
# shellcheck disable=SC1091
. /etc/os-release
note "System: ${PRETTY_NAME:-unbekannt}, Architektur $(uname -m)"
if [ "${VERSION_CODENAME:-}" != "trixie" ]; then
  note "Hinweis: gedacht für Raspberry Pi OS Trixie; hier ist es ${VERSION_CODENAME:-unbekannt}. Weiter auf eigene Gefahr."
fi
python3 -P -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' \
  || fail "Python 3.12 oder neuer wird gebraucht (gefunden: $(python3 --version 2>&1))."
note "$(python3 --version)"

# ---------------------------------------------------------------- Bei Stowly melden
if [ -n "$PAIR_SERVER" ]; then
  if [ -f "$AP_MARKER" ]; then
    step "Hinweis: Der Pi ist als Access Point eingerichtet"
    note "Als Access Point erreicht er den Stowly-Server meist nicht. Dann zuerst den Access Point"
    note "entfernen (sudo bash access-point.sh --remove), neu starten und den Befehl aus der App wiederholen."
  fi
  step "Bei Stowly melden ($PAIR_SERVER)"
  # Noch mit dem python3 des Systems und dem Druckdienst aus diesem Ordner: Installiert ist noch nichts.
  PYTHONPATH="$REPO_DIR/print" PYTHONDONTWRITEBYTECODE=1 \
    python3 -P -m stowly_print pair --start --server "$PAIR_SERVER" --code "$PAIR_CODE" \
    || fail "Stowly nimmt den Code nicht an (Meldung oben)."
fi

# ---------------------------------------------------------------- Pakete
missing=()
for package in "${PACKAGES[@]}"; do
  dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q "install ok installed" || missing+=("$package")
done
if [ ${#missing[@]} -eq 0 ]; then
  step "Pakete: alle schon installiert"
elif [ "$OFFLINE" -eq 1 ]; then
  fail "Es fehlen Pakete: ${missing[*]}. Einmal mit Internet ohne --offline laufen lassen."
else
  step "Fehlende Pakete installieren: ${missing[*]}"
  export DEBIAN_FRONTEND=noninteractive
  updated=0
  for attempt in 1 2 3 4 5 6; do
    if apt-get -o DPkg::Lock::Timeout="$APT_LOCK_TIMEOUT" update; then
      updated=1
      break
    fi
    note "apt ist belegt oder das Netz fehlt; neuer Versuch in 20 Sekunden ($attempt von 6)."
    sleep 20
  done
  [ "$updated" -eq 1 ] || fail "apt-get update ging nicht (Meldungen oben). Hat der Pi Internet?"
  apt-get -o DPkg::Lock::Timeout="$APT_LOCK_TIMEOUT" install -y --no-install-recommends "${missing[@]}"
fi

if [ -f "$AP_MARKER" ]; then
  step "Access Point ist eingerichtet: hostapd und dnsmasq bleiben, wie sie sind"
else
  # Debian maskiert hostapd beim Installieren, solange es keine Konfiguration gibt; dnsmasq
  # startet dagegen gleich, mit der Vorgabe von Debian als DNS-Weiterleitung. Je für sich, damit
  # das eine das andere nicht aufhält.
  step "hostapd und dnsmasq ruhen, bis access-point.sh sie einrichtet"
  systemctl disable --now hostapd.service 2>/dev/null || true
  systemctl disable --now dnsmasq.service 2>/dev/null || true
fi

# ---------------------------------------------------------------- Benutzer
step "Benutzer $SERVICE_USER (ohne Anmeldung, in der Gruppe plugdev)"
if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  note "gibt es schon"
else
  useradd --system --user-group --home-dir "$STATE_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi
usermod -a -G plugdev "$SERVICE_USER"

# ---------------------------------------------------------------- Programm
step "Programm nach $PREFIX (venv mit den Systempaketen)"
install -d -m 755 "$PREFIX"
if [ ! -x "$PREFIX/venv/bin/python" ]; then
  python3 -P -m venv --system-site-packages "$PREFIX/venv"
fi
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT
cp -r "$REPO_DIR/print" "$build/print"
rm -rf "$build/print/build" "$build/print/"*.egg-info
# Nur das Paket selbst, ohne nachzuladen: Pillow, segno, Starlette und uvicorn kommen vom System.
PIP_CONFIG_FILE=/dev/null "$PREFIX/venv/bin/pip" install --no-cache-dir --no-deps --no-build-isolation \
  --no-index --force-reinstall "$build/print"

# Sind genau die festgelegten Versionen der Brother-Bibliothek schon da? Dann braucht es kein Internet.
brother_installed() {
  "$PREFIX/venv/bin/python" -P - "$REPO_DIR/print/requirements-brother.txt" <<'PYEOF'
import importlib.metadata as meta
import re
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    wanted = dict(re.findall(r"^([A-Za-z0-9_.-]+)==([^\s\\]+)", handle.read(), re.MULTILINE))
try:
    present = all(meta.version(name) == version for name, version in wanted.items())
except meta.PackageNotFoundError:
    present = False
sys.exit(0 if wanted and present else 1)
PYEOF
}

if [ "$WITH_BROTHER" -eq 0 ]; then
  step "Brother-Bibliothek: übersprungen (--without-brother)"
elif brother_installed; then
  step "Brother-Bibliothek: schon da, in den festgelegten Versionen"
elif [ "$OFFLINE" -eq 1 ]; then
  step "Brother-Bibliothek: übersprungen (--offline), die vorhandene bleibt"
else
  step "Brother-Bibliothek von PyPI, auf Version und Prüfsumme festgelegt (print/requirements-brother.txt)"
  # Nur PyPI, nicht piwheels: Dessen Dateien haben andere Prüfsummen. packbits gibt es nur als
  # Quellpaket; --no-build-isolation baut es mit python3-setuptools, statt setuptools ungeprüft
  # in eine eigene Bau-Umgebung zu laden.
  PIP_CONFIG_FILE=/dev/null "$PREFIX/venv/bin/pip" install --no-cache-dir --no-deps --no-build-isolation \
    --require-hashes --index-url https://pypi.org/simple -r "$REPO_DIR/print/requirements-brother.txt"
fi

step "Prüfen, was der Dienst importiert"
"$PREFIX/venv/bin/python" -P - <<'PYEOF'
import importlib.metadata as meta
import sys

import PIL, segno, starlette, uvicorn  # noqa: F401
import stowly_print

print(f"    Python {sys.version.split()[0]}, stowly_print {stowly_print.__version__}, "
      f"Starlette {starlette.__version__}, uvicorn {uvicorn.__version__}, "
      f"Pillow {PIL.__version__}, segno {segno.__version__}")
try:
    import brother_ql  # noqa: F401
    import usb  # noqa: F401
    print(f"    brother_ql_next {meta.version('brother_ql_next')}, pyusb {meta.version('pyusb')}")
except ImportError as exc:
    print(f"    Brother-Bibliothek fehlt ({exc}): Brother-Drucker melden 'config'.")
PYEOF

# ---------------------------------------------------------------- Drucker am USB
step "udev-Regel für Brother-Drucker (Hersteller 04f9)"
install -m 644 "$SCRIPT_DIR/99-stowly-brother.rules" "$UDEV_RULE"
udevadm control --reload-rules
udevadm trigger --subsystem-match=usb --action=add || true

# ---------------------------------------------------------------- Skripte für später
step "Skripte und Anleitung nach $PREFIX/pi (access-point.sh, overlay.sh, make-cert.sh)"
install -d -m 755 "$PREFIX/pi"
for file in "$SCRIPT_DIR"/*.sh; do
  install -m 755 "$file" "$PREFIX/pi/$(basename "$file")"
done
install -m 644 "$SCRIPT_DIR/README.md" "$PREFIX/pi/README.md"

# ---------------------------------------------------------------- Konfiguration (von Hand)
install -d -m 755 "$CONFIG_DIR"
NEW_TOKEN=""
if [ -z "$PAIR_SERVER" ]; then
  step "Konfiguration $CONFIG"
  if [ -n "$CERT" ]; then
    install -d -m 750 -o root -g "$SERVICE_USER" "$TLS_DIR"
    install -m 644 -o root -g root "$CERT" "$TLS_DIR/pi.crt"
    # Den Schlüssel liest nur der Dienst.
    install -m 600 -o "$SERVICE_USER" -g "$SERVICE_USER" "$KEY" "$TLS_DIR/pi.key"
    note "Zertifikat und Schlüssel liegen in $TLS_DIR"
  fi
  if [ -f "$CONFIG" ]; then
    note "gibt es schon; sie bleibt, wie sie ist (Token, Ursprünge, Drucker)."
    if [ -f "$TLS_DIR/pi.crt" ] && ! grep -q '^\[https\]' "$CONFIG"; then
      note "Hinweis: Ein Zertifikat liegt bereit, die Konfiguration nennt aber kein [https] (README, „Konfiguration\")."
    fi
  else
    NEW_TOKEN="$(python3 -P -c 'import secrets; print(secrets.token_urlsafe(24))')"
    HTTPS=0
    [ -f "$TLS_DIR/pi.crt" ] && [ -f "$TLS_DIR/pi.key" ] && HTTPS=1
    umask 027
    TOKEN="$NEW_TOKEN" MODEL="$MODEL" ADDRESS="$ADDRESS" HTTPS="$HTTPS" TLS_DIR="$TLS_DIR" \
      python3 -P - "${ORIGINS[@]}" >"$CONFIG.neu" <<'PYEOF'
import json
import os
import sys

# Die Datei ist UTF-8, gleich welche Sprache die Sitzung eingestellt hat.
sys.stdout.reconfigure(encoding="utf-8")


def text(value: str) -> str:
    # JSON-Zeichenketten ohne Nicht-ASCII sind gültige TOML-Zeichenketten.
    return json.dumps(value, ensure_ascii=True)


origins = ", ".join(text(origin.rstrip("/").lower()) for origin in sys.argv[1:])
lines = [
    "# Stowly-Druckdienst, angelegt von pi/install.sh. Format: README.md, „Konfiguration\".",
    "# Nach einer Änderung: sudo systemctl restart stowly-print",
    "",
    "# Dasselbe Token trägt Stowly beim Drucker ein.",
    f"token = {text(os.environ['TOKEN'])}",
    "",
    "# Ursprünge der App, die direkt drucken dürfen (ohne Pfad).",
    f"origins = [{origins}]",
    "",
    'log_level = "info"',
    "",
    "[http]",
    'host = "0.0.0.0"',
    "port = 8080",
    "",
]
if os.environ["HTTPS"] == "1":
    tls = os.environ["TLS_DIR"]
    lines += [
        "[https]",
        'host = "0.0.0.0"',
        "port = 8443",
        f"certificate = {text(tls + '/pi.crt')}",
        f"key = {text(tls + '/pi.key')}",
        "",
    ]
lines += [
    "# Der erste Drucker ist der Standarddrucker.",
    "[[printers]]",
    'name = "keller"',
    'driver = "brother_ql"',
    f"model = {text(os.environ['MODEL'])}",
    f"address = {text(os.environ['ADDRESS'])}",
    'media = "62"',
    "",
    "# Zum Ausprobieren ohne Drucker:",
    "# [[printers]]",
    '# name = "bild"',
    '# driver = "image"',
    '# directory = "/var/lib/stowly-print/etiketten"',
]
print("\n".join(lines))
PYEOF
    umask 022
    chown root:"$SERVICE_USER" "$CONFIG.neu"
    chmod 640 "$CONFIG.neu"
    mv "$CONFIG.neu" "$CONFIG"
    note "angelegt; nur root und der Dienst können sie lesen."
    if [ ${#ORIGINS[@]} -eq 0 ]; then
      note "Hinweis: kein --origin angegeben. Ohne Ursprung kann die App nicht direkt drucken (nur über die Seite /p)."
    fi
  fi
  "$PREFIX/venv/bin/python" -P -c "from stowly_print.config import load_config; load_config('$CONFIG')" \
    || fail "Die Konfiguration $CONFIG ist nicht brauchbar (Meldung oben)."
fi

# ---------------------------------------------------------------- Journal, Dienst
step "Journal begrenzen (nur im Arbeitsspeicher, höchstens 16 MB)"
install -d -m 755 "$(dirname "$JOURNALD_CONF")"
install -m 644 "$SCRIPT_DIR/journald-stowly.conf" "$JOURNALD_CONF"
systemctl restart systemd-journald

step "Systemdienst stowly-print (startet immer wieder neu)"
install -m 644 "$SCRIPT_DIR/stowly-print.service" "$UNIT"
install -m 644 "$SCRIPT_DIR/README.md" "$PREFIX/README.md"
systemctl daemon-reload

# ---------------------------------------------------------------- Koppeln
if [ -n "$PAIR_SERVER" ]; then
  step "Mit Stowly koppeln (Schlüssel und Zertifikat, Token, Drucker in Stowly)"
  pair_args=(--server "$PAIR_SERVER" --code "$PAIR_CODE")
  for origin in "${ORIGINS[@]}"; do
    pair_args+=(--origin "$origin")
  done
  if [ "$MODEL_SET" -eq 1 ]; then
    pair_args+=(--model "$MODEL")
  fi
  if [ "$ADDRESS_SET" -eq 1 ]; then
    pair_args+=(--address "$ADDRESS")
  fi
  "$PREFIX/venv/bin/python" -P -m stowly_print pair "${pair_args[@]}" \
    || fail "Das Koppeln ging nicht (Meldung oben). Die bisherige Konfiguration ist unverändert."
fi

systemctl enable stowly-print.service
systemctl restart stowly-print.service
sleep 4
if ! systemctl is-active --quiet stowly-print.service; then
  journalctl -u stowly-print.service -n 40 --no-pager || true
  fail "Der Dienst läuft nicht (Meldungen oben)."
fi

if [ -n "$PAIR_SERVER" ]; then
  step "Selbsttest: HTTP, HTTPS mit dem Zertifikat von Stowly, Testetikett"
  "$PREFIX/venv/bin/python" -P -m stowly_print selftest \
    || fail "Der Selbsttest ging nicht durch (Meldungen oben; Journal: journalctl -u stowly-print -e)."
else
  step "Probe: GET /v1/health"
  "$PREFIX/venv/bin/python" -P - "$CONFIG" <<'PYEOF'
import json
import sys
import urllib.request

from stowly_print.config import load_config

config = load_config(sys.argv[1])
port = config.http.port if config.http else None
if port is None:
    print("    Kein HTTP-Zugang eingeschaltet; Probe übersprungen.")
    sys.exit(0)
with urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/health", timeout=10) as response:
    health = json.load(response)
print(f"    {health['app']} {health['version']}, boot_id {health['boot_id']}")
for printer in health["printers"]:
    status = printer["status"]
    print(f"    Drucker {printer['name']} ({printer['driver']}): erreichbar={status['reachable']}, "
          f"bereit={status['ready']}, Fehler={status['errors'] or 'keine'}")
PYEOF
fi

# ---------------------------------------------------------------- Zusammenfassung
if [ -n "$PAIR_SERVER" ]; then
  step "Fertig: Der Pi ist mit Stowly gekoppelt"
  note "Der Drucker steht in Stowly unter Einstellungen → Drucker; die App zeigt die Kopplung als fertig."
  note "Neu koppeln (neue IP-Adresse, Zertifikat läuft ab): denselben Befehl mit einem neuen Code aus der App."
  note "Später, wenn alles läuft (README): eigener Access Point mit sudo bash $PREFIX/pi/access-point.sh,"
  note "zuletzt der Schreibschutz mit sudo bash $PREFIX/pi/overlay.sh on."
  exit 0
fi
step "Fertig"
if [ -n "$NEW_TOKEN" ]; then
  note "Token des Druckers (in Stowly beim Drucker eintragen, steht auch in $CONFIG):"
  note ""
  note "    $NEW_TOKEN"
  note ""
fi
note "Nächste Schritte (README):"
note "  1. Drucker anschließen (Editor-Lite-Modus aus) und Probe wiederholen:"
note "     curl -s http://127.0.0.1:8080/v1/health"
note "  2. Access Point einrichten: sudo bash pi/access-point.sh --ssid ... (danach kein Internet mehr)"
note "  3. Zuletzt die SD-Karte schreibschützen: sudo bash pi/overlay.sh on"
