#!/usr/bin/env bash
# Stowly-Druckdienst auf dem Raspberry Pi installieren.
#
# Für Raspberry Pi OS Lite (Trixie, Python 3.13), auch auf dem Pi Zero W (32 Bit). Anleitung:
# pi/README.md. In der Zielumgebung ungetestet; die Prüfliste steht in der Anleitung.
#
#   sudo bash pi/install.sh --origin https://stowly.home
#   sudo bash pi/install.sh --origin https://stowly.home --cert pi.crt --key pi.key
#   sudo bash pi/install.sh --offline        # erneut, ohne Internet (Aktualisieren)
#
# Was das Skript tut, sagt es vor jedem Schritt. Es ist wiederholbar: Ein zweiter Lauf bringt
# Programm, Dienst und Regeln auf den Stand dieses Ordners und lässt eine vorhandene
# Konfiguration samt Token stehen. Bei einem Fehler bricht es ab.
#
# Es braucht Internet (Pakete von Debian/Raspberry Pi, Brother-Bibliothek von PyPI), außer mit
# --offline. Den Access Point richtet erst access-point.sh ein: erst installieren, dann umschalten.
set -euo pipefail

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

PACKAGES=(
  python3-pil python3-usb python3-segno python3-starlette python3-uvicorn
  python3-venv python3-setuptools
  fonts-dejavu-core libusb-1.0-0 openssl qrencode
  hostapd dnsmasq
)

ORIGINS=()
MODEL="QL-800"
ADDRESS="usb://04f9"
CERT=""
KEY=""
WITH_BROTHER=1
OFFLINE=0

usage() {
  cat <<'EOF'
Aufruf: sudo bash pi/install.sh [Angaben]

  --origin URL         Ursprung der App, die direkt drucken darf, z. B. https://stowly.home
                       (mehrfach möglich; nur beim ersten Lauf, danach in der Konfiguration)
  --model NAME         Modell des Druckers (Vorgabe QL-800; auch QL-810W, QL-820NWB)
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
    --origin | --model | --address | --cert | --key)
      [ $# -ge 2 ] || fail "$1 braucht einen Wert (Hilfe: --help)"
      case "$1" in
        --origin) ORIGINS+=("$2") ;;
        --model) MODEL="$2" ;;
        --address) ADDRESS="$2" ;;
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
if [ -n "$CERT$KEY" ]; then
  [ -n "$CERT" ] && [ -n "$KEY" ] || fail "--cert und --key gehören zusammen."
  [ -f "$CERT" ] || fail "Zertifikat $CERT gibt es nicht."
  [ -f "$KEY" ] || fail "Schlüssel $KEY gibt es nicht."
fi
note "Ordner: $REPO_DIR"
note "Drucker: $MODEL an $ADDRESS"
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
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)' \
  || fail "Python 3.12 oder neuer wird gebraucht (gefunden: $(python3 --version 2>&1))."
note "$(python3 --version)"

if [ "$OFFLINE" -eq 0 ]; then
  step "Pakete installieren: ${PACKAGES[*]}"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends "${PACKAGES[@]}"
  # Das Overlay (overlay.sh, ganz am Ende) braucht overlayroot. Jetzt gibt es noch Internet.
  step "Paket overlayroot für den späteren Schreibschutz"
  apt-get install -y --no-install-recommends overlayroot \
    || note "overlayroot ließ sich nicht installieren; raspi-config holt es beim Einschalten des Overlays nach (dann mit Internet)."
else
  step "Pakete: übersprungen (--offline)"
  missing=()
  for package in "${PACKAGES[@]}"; do
    dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q "install ok installed" || missing+=("$package")
  done
  [ ${#missing[@]} -eq 0 ] || fail "Es fehlen Pakete: ${missing[*]}. Einmal mit Internet ohne --offline laufen lassen."
fi

if [ -f "$AP_MARKER" ]; then
  step "Access Point ist eingerichtet: hostapd und dnsmasq bleiben, wie sie sind"
else
  step "hostapd und dnsmasq ruhen, bis access-point.sh sie einrichtet"
  systemctl disable --now hostapd.service dnsmasq.service 2>/dev/null || true
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
  python3 -m venv --system-site-packages "$PREFIX/venv"
fi
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT
cp -r "$REPO_DIR/print" "$build/print"
rm -rf "$build/print/build" "$build/print/"*.egg-info
# Nur das Paket selbst, ohne nachzuladen: Pillow, segno, Starlette und uvicorn kommen vom System.
PIP_CONFIG_FILE=/dev/null "$PREFIX/venv/bin/pip" install --no-cache-dir --no-deps --no-build-isolation \
  --no-index --force-reinstall "$build/print"

if [ "$WITH_BROTHER" -eq 1 ] && [ "$OFFLINE" -eq 0 ]; then
  step "Brother-Bibliothek von PyPI, auf Version und Prüfsumme festgelegt (print/requirements-brother.txt)"
  # Nur PyPI, nicht piwheels: Dessen Dateien haben andere Prüfsummen.
  PIP_CONFIG_FILE=/dev/null "$PREFIX/venv/bin/pip" install --no-cache-dir --no-deps --require-hashes \
    --index-url https://pypi.org/simple -r "$REPO_DIR/print/requirements-brother.txt"
elif [ "$WITH_BROTHER" -eq 1 ]; then
  step "Brother-Bibliothek: übersprungen (--offline), die vorhandene bleibt"
else
  step "Brother-Bibliothek: übersprungen (--without-brother)"
fi

step "Prüfen, was der Dienst importiert"
"$PREFIX/venv/bin/python" - <<'PYEOF'
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

# ---------------------------------------------------------------- Konfiguration
step "Konfiguration $CONFIG"
install -d -m 755 "$CONFIG_DIR"
if [ -n "$CERT" ]; then
  install -d -m 750 -o root -g "$SERVICE_USER" "$TLS_DIR"
  install -m 644 -o root -g root "$CERT" "$TLS_DIR/pi.crt"
  # Den Schlüssel liest nur der Dienst.
  install -m 600 -o "$SERVICE_USER" -g "$SERVICE_USER" "$KEY" "$TLS_DIR/pi.key"
  note "Zertifikat und Schlüssel liegen in $TLS_DIR"
fi
NEW_TOKEN=""
if [ -f "$CONFIG" ]; then
  note "gibt es schon; sie bleibt, wie sie ist (Token, Ursprünge, Drucker)."
  if [ -f "$TLS_DIR/pi.crt" ] && ! grep -q '^\[https\]' "$CONFIG"; then
    note "Hinweis: Ein Zertifikat liegt bereit, die Konfiguration nennt aber kein [https] (README, „Konfiguration\")."
  fi
else
  NEW_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
  HTTPS=0
  [ -f "$TLS_DIR/pi.crt" ] && [ -f "$TLS_DIR/pi.key" ] && HTTPS=1
  umask 027
  TOKEN="$NEW_TOKEN" MODEL="$MODEL" ADDRESS="$ADDRESS" HTTPS="$HTTPS" TLS_DIR="$TLS_DIR" \
    python3 - "${ORIGINS[@]}" >"$CONFIG.neu" <<'PYEOF'
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
"$PREFIX/venv/bin/python" -c "from stowly_print.config import load_config; load_config('$CONFIG')" \
  || fail "Die Konfiguration $CONFIG ist nicht brauchbar (Meldung oben)."

# ---------------------------------------------------------------- Journal, Dienst
step "Journal begrenzen (nur im Arbeitsspeicher, höchstens 16 MB)"
install -d -m 755 "$(dirname "$JOURNALD_CONF")"
install -m 644 "$SCRIPT_DIR/journald-stowly.conf" "$JOURNALD_CONF"
systemctl restart systemd-journald

step "Systemdienst stowly-print (startet immer wieder neu)"
install -m 644 "$SCRIPT_DIR/stowly-print.service" "$UNIT"
install -m 644 "$SCRIPT_DIR/README.md" "$PREFIX/README.md"
systemctl daemon-reload
systemctl enable stowly-print.service
systemctl restart stowly-print.service
sleep 4
if ! systemctl is-active --quiet stowly-print.service; then
  journalctl -u stowly-print.service -n 40 --no-pager || true
  fail "Der Dienst läuft nicht (Meldungen oben)."
fi

step "Probe: GET /v1/health"
"$PREFIX/venv/bin/python" - "$CONFIG" <<'PYEOF'
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

# ---------------------------------------------------------------- Zusammenfassung
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
