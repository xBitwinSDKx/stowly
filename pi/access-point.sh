#!/usr/bin/env bash
# Das WLAN des Pi wird zum Access Point für die Handys im Keller (hostapd und dnsmasq, nicht der
# Hotspot des NetworkManager). Anleitung: pi/README.md. In der Zielumgebung ungetestet.
#
#   sudo bash pi/access-point.sh --ssid Stowly-Keller --password 'mindestens acht Zeichen'
#   sudo bash pi/access-point.sh --ssid Stowly-Keller --generate-password
#   sudo bash pi/access-point.sh --remove      # zurück: WLAN wieder als Client (NetworkManager)
#
# Danach hat der Pi kein Internet mehr: Erst install.sh (braucht Internet), dann dieses Skript.
# Wirksam wird alles beim nächsten Neustart; bis dahin bleibt die jetzige Verbindung bestehen.
#
# - WPA2 mit CCMP, sichtbare SSID (Vorgabe) oder versteckt (--hidden)
# - feste Adresse in einem unüblichen Bereich, Vorgabe 10.71.83.1/24
# - DHCP für die Handys; der Pi nennt sich als Router, leitet aber nichts weiter: kein
#   vorgetäuschtes Internet. Kein DNS (dnsmasq mit port=0), also auch kein Umbiegen von Namen.
#
# Wiederholbar: Ein zweiter Lauf schreibt dieselben Dateien neu. Bricht bei Fehlern ab.
set -euo pipefail

INTERFACE=wlan0
SSID=""
PASSWORD=""
PASSWORD_FILE=""
GENERATE=0
ADDRESS="10.71.83.1/24"
COUNTRY="DE"
CHANNEL=6
HIDDEN=0
ASSUME_YES=0
REMOVE=0

HOSTAPD_CONF=/etc/hostapd/hostapd.conf
DNSMASQ_CONF=/etc/dnsmasq.d/stowly-ap.conf
NM_CONF=/etc/NetworkManager/conf.d/99-stowly-ap.conf
ADDRESS_UNIT=/etc/systemd/system/stowly-ap-address.service
SYSCTL_CONF=/etc/sysctl.d/99-stowly-ap.conf

usage() {
  cat <<'EOF'
Aufruf: sudo bash pi/access-point.sh --ssid NAME (--password PW | --password-file DATEI | --generate-password) [Angaben]

  --ssid NAME            Name des WLANs (1 bis 32 Zeichen, nur ASCII)
  --password PW          WLAN-Passwort (8 bis 63 Zeichen, nur ASCII)
  --password-file DATEI  Passwort aus der ersten Zeile dieser Datei
  --generate-password    ein Passwort erzeugen; es wird am Ende angezeigt
                         (ohne eine dieser drei Angaben fragt das Skript nach dem Passwort)
  --address IP/PRÄFIX    Adresse des Pi im eigenen WLAN (Vorgabe 10.71.83.1/24)
  --country CODE         Land für die Funkregeln (Vorgabe DE)
  --channel N            Kanal 1 bis 13 (Vorgabe 6)
  --hidden               SSID verstecken (nicht empfohlen: iPhones verbinden sich dann schlechter)
  --interface NAME       WLAN-Schnittstelle (Vorgabe wlan0)
  --yes                  nicht nachfragen
  --remove               Access Point entfernen; nach dem Neustart ist das WLAN wieder Client
  -h, --help             diese Hilfe
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
    --ssid | --password | --password-file | --address | --country | --channel | --interface)
      [ $# -ge 2 ] || fail "$1 braucht einen Wert (Hilfe: --help)"
      case "$1" in
        --ssid) SSID="$2" ;;
        --password) PASSWORD="$2" ;;
        --password-file) PASSWORD_FILE="$2" ;;
        --address) ADDRESS="$2" ;;
        --country) COUNTRY="$2" ;;
        --channel) CHANNEL="$2" ;;
        --interface) INTERFACE="$2" ;;
      esac
      shift 2
      ;;
    --generate-password) GENERATE=1; shift ;;
    --hidden) HIDDEN=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --remove) REMOVE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) fail "Unbekannte Angabe: $1 (Hilfe: --help)" ;;
  esac
done

confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  local answer
  read -r -p "    Weiter? [j/N] " answer
  case "$answer" in
    j | J | ja | Ja | y | Y) return 0 ;;
    *) fail "Abgebrochen, nichts geändert." ;;
  esac
}

[ "$(id -u)" -eq 0 ] || fail "Bitte mit sudo starten: sudo bash ${CALL/--password */--password …}"

# ---------------------------------------------------------------- Zurück zum Client
if [ "$REMOVE" -eq 1 ]; then
  step "Access Point entfernen: Nach dem Neustart verbindet sich $INTERFACE wieder als Client"
  note "Der Pi ist danach nicht mehr unter seiner festen Adresse im eigenen WLAN zu erreichen,"
  note "sondern wie vor dem Einrichten über das Heim-WLAN (sofern NetworkManager es kennt)."
  confirm
  # Je für sich: Fehlt eine Einheit (zweiter Lauf), bleiben die anderen nicht eingeschaltet.
  for unit in hostapd.service dnsmasq.service stowly-ap-address.service; do
    systemctl disable "$unit" 2>/dev/null || true
  done
  rm -f "$NM_CONF" "$DNSMASQ_CONF" "$ADDRESS_UNIT" "$SYSCTL_CONF"
  systemctl daemon-reload
  note "Entfernt. $HOSTAPD_CONF bleibt liegen (enthält das WLAN-Passwort; bei Bedarf löschen)."
  step "Jetzt neu starten: sudo reboot"
  exit 0
fi

# ---------------------------------------------------------------- Angaben prüfen
step "Angaben prüfen"
LC_ALL=C
[ -n "$SSID" ] || fail "--ssid fehlt (Hilfe: --help)."
[[ "$SSID" =~ ^[[:print:]]{1,32}$ ]] || fail "Die SSID muss 1 bis 32 druckbare ASCII-Zeichen haben."
sources=$(( (${#PASSWORD} > 0) + (${#PASSWORD_FILE} > 0) + GENERATE ))
[ "$sources" -le 1 ] || fail "Nur eine Angabe zum Passwort: --password, --password-file oder --generate-password."
if [ -n "$PASSWORD_FILE" ]; then
  [ -f "$PASSWORD_FILE" ] || fail "Die Datei $PASSWORD_FILE gibt es nicht."
  IFS= read -r PASSWORD <"$PASSWORD_FILE" || true
elif [ "$GENERATE" -eq 1 ]; then
  # 20 Zeichen ohne verwechselbare Zeichen; wird am Ende angezeigt.
  PASSWORD="$(python3 -c 'import secrets; a = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789"; print("".join(secrets.choice(a) for _ in range(20)))')"
elif [ -z "$PASSWORD" ]; then
  [ -t 0 ] || fail "Kein Passwort angegeben (--password, --password-file oder --generate-password)."
  read -r -s -p "    WLAN-Passwort (8 bis 63 Zeichen): " PASSWORD
  echo
  read -r -s -p "    Noch einmal: " again
  echo
  [ "$PASSWORD" = "$again" ] || fail "Die beiden Eingaben stimmen nicht überein."
fi
[[ "$PASSWORD" =~ ^[[:print:]]{8,63}$ ]] || fail "Das Passwort muss 8 bis 63 druckbare ASCII-Zeichen haben."
[[ "$COUNTRY" =~ ^[A-Z]{2}$ ]] || fail "--country erwartet zwei Großbuchstaben, etwa DE."
[[ "$CHANNEL" =~ ^([1-9]|1[0-3])$ ]] || fail "--channel erwartet 1 bis 13."
[[ "$INTERFACE" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || fail "--interface $INTERFACE ist kein Name einer Schnittstelle."

# Adresse, Netz und DHCP-Bereich rechnet Python (ipaddress) aus.
read -r IP PREFIX NETMASK RANGE_START RANGE_END < <(python3 - "$ADDRESS" <<'PYEOF'
import ipaddress
import sys

try:
    interface = ipaddress.IPv4Interface(sys.argv[1])
except ValueError:
    sys.exit("keine IPv4-Adresse mit Präfix")
network = interface.network
if not 16 <= network.prefixlen <= 29 or not network.is_private:
    sys.exit("erwartet eine private Adresse mit Präfix /16 bis /29")
hosts = [host for host in network.hosts() if host != interface.ip]
if len(hosts) < 4:
    sys.exit("das Netz ist zu klein")
# Bis zu 100 Adressen für die Handys, nicht die des Pi.
start = hosts[min(48, len(hosts) // 4)]
end = hosts[min(len(hosts) - 1, hosts.index(start) + 100)]
print(interface.ip, network.prefixlen, network.netmask, start, end)
PYEOF
) || fail "--address $ADDRESS: erwartet etwa 10.71.83.1/24."

command -v hostapd >/dev/null || fail "hostapd fehlt. Zuerst install.sh laufen lassen (braucht Internet)."
command -v dnsmasq >/dev/null || fail "dnsmasq fehlt. Zuerst install.sh laufen lassen (braucht Internet)."
ip link show "$INTERFACE" >/dev/null 2>&1 || fail "Die Schnittstelle $INTERFACE gibt es nicht."

note "SSID: $SSID ($([ "$HIDDEN" -eq 1 ] && echo versteckt || echo sichtbar)), Kanal $CHANNEL, Land $COUNTRY"
note "Adresse des Pi: $IP/$PREFIX, DHCP für die Handys: $RANGE_START bis $RANGE_END"

step "Was jetzt geschieht"
note "Ab dem nächsten Neustart spannt $INTERFACE das WLAN \"$SSID\" auf und verbindet sich mit keinem"
note "anderen WLAN mehr. Der Pi hat dann kein Internet und ist nur noch so erreichbar:"
note "  im WLAN \"$SSID\" unter $IP (SSH: ssh <benutzer>@$IP), oder mit Tastatur und Bildschirm."
note "Pakete installiert danach nur noch install.sh --offline. Zurück: access-point.sh --remove."
confirm

# ---------------------------------------------------------------- Funk
step "Land für die Funkregeln: $COUNTRY, WLAN entsperren"
if command -v raspi-config >/dev/null; then
  raspi-config nonint do_wifi_country "$COUNTRY" || note "raspi-config konnte das Land nicht setzen; es steht trotzdem in hostapd.conf."
fi
rfkill unblock wlan 2>/dev/null || true

# ---------------------------------------------------------------- NetworkManager
step "NetworkManager lässt $INTERFACE ab dem Neustart in Ruhe ($NM_CONF)"
# NetworkManager liest conf.d beim Start; ohne Neustart (oder nmcli general reload) bleibt die
# jetzige Verbindung, wie sie ist. keyfile.unmanaged-devices ist strikt: Weder eine udev-Regel
# noch ein [device]-Abschnitt (etwa von netplan, über das Raspberry Pi OS das WLAN aus dem
# Imager einrichtet) macht die Schnittstelle wieder verwaltet (NetworkManager.conf(5), 1.52).
install -d -m 755 "$(dirname "$NM_CONF")"
cat >"$NM_CONF" <<EOF
# Stowly: $INTERFACE ist der Access Point (hostapd, dnsmasq). Entfernen: pi/access-point.sh --remove
[keyfile]
unmanaged-devices=interface-name:$INTERFACE
EOF
chmod 644 "$NM_CONF"

# ---------------------------------------------------------------- Feste Adresse
step "Feste Adresse $IP/$PREFIX auf $INTERFACE ($ADDRESS_UNIT)"
install -d -m 755 "$(dirname "$ADDRESS_UNIT")" "$(dirname "$SYSCTL_CONF")"
# Die Adresse kommt vor hostapd und dnsmasq. Die Schnittstelle schaltet hostapd selbst ein; das
# "up" hier darf scheitern: Raspberry Pi OS sperrt den Funk beim Start, bis systemd-rfkill den
# gespeicherten Zustand zurückholt (raspberrypi-sys-mods: rfkill default_state=0).
cat >"$ADDRESS_UNIT" <<EOF
# Stowly: feste Adresse für das WLAN des Druckers. Entfernen: pi/access-point.sh --remove
[Unit]
Description=Feste Adresse $IP/$PREFIX auf $INTERFACE (Stowly-Access-Point)
BindsTo=sys-subsystem-net-devices-$INTERFACE.device
After=sys-subsystem-net-devices-$INTERFACE.device
Before=hostapd.service dnsmasq.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/ip address replace $IP/$PREFIX dev $INTERFACE
ExecStart=-/usr/sbin/ip link set $INTERFACE up

[Install]
WantedBy=multi-user.target
EOF
chmod 644 "$ADDRESS_UNIT"
cat >"$SYSCTL_CONF" <<'EOF'
# Stowly: Der Pi leitet nichts weiter. Sein WLAN hat kein Internet, und er tut nicht so.
net.ipv4.ip_forward = 0
EOF
chmod 644 "$SYSCTL_CONF"

# ---------------------------------------------------------------- hostapd
step "hostapd: WPA2 (CCMP) ($HOSTAPD_CONF, nur für root lesbar)"
install -d -m 755 "$(dirname "$HOSTAPD_CONF")"
umask 077
cat >"$HOSTAPD_CONF" <<EOF
# Stowly-Access-Point, geschrieben von pi/access-point.sh
interface=$INTERFACE
driver=nl80211
ssid=$SSID
utf8_ssid=0
country_code=$COUNTRY
ieee80211d=1
hw_mode=g
channel=$CHANNEL
wmm_enabled=1
auth_algs=1
ignore_broadcast_ssid=$HIDDEN
wpa=2
wpa_key_mgmt=WPA-PSK
wpa_pairwise=CCMP
rsn_pairwise=CCMP
wpa_passphrase=$PASSWORD
EOF
umask 022
chmod 600 "$HOSTAPD_CONF"
if [ -f /etc/default/hostapd ] && grep -q '^DAEMON_CONF=' /etc/default/hostapd; then
  sed -i "s|^DAEMON_CONF=.*|DAEMON_CONF=\"$HOSTAPD_CONF\"|" /etc/default/hostapd
fi

# ---------------------------------------------------------------- dnsmasq
step "dnsmasq: nur DHCP, kein DNS ($DNSMASQ_CONF)"
install -d -m 755 "$(dirname "$DNSMASQ_CONF")"
cat >"$DNSMASQ_CONF" <<EOF
# Stowly-Access-Point, geschrieben von pi/access-point.sh
# Kein DNS (port=0): Namen werden weder aufgelöst noch umgebogen. Die Handys sprechen den Pi
# über seine Adresse an.
port=0
interface=$INTERFACE
bind-dynamic
dhcp-authoritative
dhcp-range=$RANGE_START,$RANGE_END,$NETMASK,12h
# Der Pi nennt sich als Router, leitet aber nichts weiter (kein vorgetäuschtes Internet).
dhcp-option=option:router,$IP
EOF
chmod 644 "$DNSMASQ_CONF"

# ---------------------------------------------------------------- Dienste
step "Dienste einschalten (wirksam ab dem Neustart)"
systemctl daemon-reload
# Debian maskiert hostapd beim Installieren, solange es keine Konfiguration gibt.
systemctl unmask hostapd.service 2>/dev/null || true
systemctl enable stowly-ap-address.service hostapd.service dnsmasq.service
# hostapd hat keine Probe der Konfiguration; ob es läuft, zeigt nach dem Neustart: journalctl -u hostapd
# dnsmasq: dieselbe Probe wie beim Start des Dienstes, also mit /etc/dnsmasq.conf und allem in
# /etc/dnsmasq.d (Debian: /etc/default/dnsmasq, CONFIG_DIR).
dnsmasq --test --conf-dir=/etc/dnsmasq.d,.dpkg-dist,.dpkg-old,.dpkg-new \
  || fail "dnsmasq lehnt die Konfiguration ab ($DNSMASQ_CONF, Meldung oben)."

# ---------------------------------------------------------------- WLAN-QR-Code
step "WLAN-QR-Code für den Kellereingang"
escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/;/\\;/g' -e 's/,/\\,/g' -e 's/:/\\:/g' -e 's/"/\\"/g'; }
WIFI="WIFI:T:WPA;S:$(escape "$SSID");P:$(escape "$PASSWORD");"
[ "$HIDDEN" -eq 1 ] && WIFI="${WIFI}H:true;"
WIFI="${WIFI};"
if command -v qrencode >/dev/null; then
  qrencode -t ansiutf8 -m 2 "$WIFI"
fi
note "Inhalt des QR-Codes (zum Ausdrucken, z. B. qrencode -o wlan.png '<Inhalt>'):"
note "$WIFI"
if [ "$GENERATE" -eq 1 ]; then
  note ""
  note "Erzeugtes WLAN-Passwort (bitte notieren): $PASSWORD"
fi

step "Fertig. Jetzt neu starten: sudo reboot"
note "Danach: Handy mit \"$SSID\" verbinden, dann http://$IP:8080/v1/health öffnen."
