#!/usr/bin/env bash
# Schreibgeschützte SD-Karte: Das Wurzelverzeichnis liegt als Overlay im Arbeitsspeicher
# (raspi-config), die Boot-Partition nur lesbar. Der letzte, eigene Schritt der Einrichtung.
# Anleitung: pi/README.md, Abschnitt „Schreibschutz". In der Zielumgebung ungetestet.
#
#   sudo bash pi/overlay.sh status
#   sudo bash pi/overlay.sh on      # einschalten; wirksam nach dem Neustart
#   sudo bash pi/overlay.sh off     # ausschalten, um etwas zu ändern; wirksam nach dem Neustart
#
# Mit Overlay geht jede Änderung am System beim Neustart verloren, auch eine geänderte
# Konfiguration des Druckdienstes. Deshalb muss die Konfiguration stehen, bevor es eingeschaltet
# wird. Der Druckdienst hält seine Aufträge ohnehin nur im Arbeitsspeicher.
#
# So macht es raspi-config auf Trixie (github.com/RPi-Distro/raspi-config, Zweig trixie):
# - Overlay: das Paket overlayroot und "overlayroot=tmpfs" in der Kernel-Befehlszeile
#   (/boot/firmware/cmdline.txt). Fehlt overlayroot, will raspi-config es aus dem Netz holen;
#   im WLAN des Pi gibt es keins. install.sh spielt es deshalb vorher ein.
# - Boot-Partition: "ro" in ihrer Zeile in /etc/fstab. Das ändert raspi-config nur, solange kein
#   Overlay läuft (sonst ginge die Änderung beim Neustart verloren).
# - "raspi-config nonint do_overlayfs 0" schaltet beides ein, "… 1" beides aus, soweit es geht.
#   Den Erfolg meldet es nicht über den Rückgabewert; dieses Skript prüft ihn selbst.
set -euo pipefail

CONFIG=/etc/stowly-print/stowly-print.toml

step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
fail() {
  printf '\nFEHLER: %s\n' "$*" >&2
  exit 1
}

# Die Abfragen von raspi-config geben 0 aus, wenn das Gefragte zutrifft:
# get_overlay_now (läuft jetzt), get_overlay_conf (nach dem Neustart), dasselbe für bootro.
is_on() { [ "$(raspi-config nonint "$1" 2>/dev/null)" = "0" ]; }

status() {
  if is_on get_overlay_now; then note "Overlay jetzt: an (Änderungen gehen beim Neustart verloren)"; else note "Overlay jetzt: aus"; fi
  if is_on get_overlay_conf; then note "Overlay nach dem Neustart: an"; else note "Overlay nach dem Neustart: aus"; fi
  if is_on get_bootro_now; then note "Boot-Partition jetzt: nur lesbar (ro)"; else note "Boot-Partition jetzt: beschreibbar (rw)"; fi
  if is_on get_bootro_conf; then note "Boot-Partition nach dem Neustart: nur lesbar (ro)"; else note "Boot-Partition nach dem Neustart: beschreibbar (rw)"; fi
  note "Wurzelverzeichnis: $(findmnt -no FSTYPE,OPTIONS / 2>/dev/null || echo unbekannt)"
}

[ $# -eq 1 ] || fail "Aufruf: sudo bash $0 status|on|off"
[ "$(id -u)" -eq 0 ] || fail "Bitte mit sudo starten: sudo bash $0 $1"
command -v raspi-config >/dev/null || fail "raspi-config fehlt: Das gibt es nur auf Raspberry Pi OS."

case "$1" in
  status)
    step "Zustand"
    status
    ;;
  on)
    step "Vorher prüfen: Steht die Konfiguration?"
    [ -f "$CONFIG" ] || fail "$CONFIG fehlt. Erst install.sh, dann den Access Point, zuletzt das Overlay."
    systemctl is-enabled --quiet stowly-print.service || fail "Der Dienst stowly-print ist nicht eingeschaltet (install.sh)."
    dpkg-query -W -f='${Status}' overlayroot 2>/dev/null | grep -q "install ok installed" \
      || fail "Das Paket overlayroot fehlt. Es kommt mit install.sh (braucht Internet; README, „Aktualisieren trotz Schreibschutz\", Schritt 5)."
    if [ ! -f /etc/dnsmasq.d/stowly-ap.conf ]; then
      note "Hinweis: Der Access Point ist nicht eingerichtet (access-point.sh). Trotzdem weiter?"
      read -r -p "    [j/N] " answer || answer=""
      case "$answer" in j | J | ja | y | Y) ;; *) fail "Abgebrochen, nichts geändert." ;; esac
    fi
    step "Overlay und Schreibschutz der Boot-Partition einschalten (raspi-config nonint do_overlayfs 0)"
    raspi-config nonint do_overlayfs 0
    is_on get_overlay_conf || fail "raspi-config hat das Overlay nicht eingetragen (Meldung oben)."
    if ! is_on get_overlay_now && ! is_on get_bootro_conf; then
      note "Die Boot-Partition bleibt beschreibbar (Meldung oben). Von Hand: sudo raspi-config,"
      note "Performance Options → Overlay File System, beide Fragen mit „Ja\"."
    fi
    status
    step "Jetzt neu starten: sudo reboot"
    ;;
  off)
    step "Overlay ausschalten (raspi-config nonint do_overlayfs 1)"
    raspi-config nonint do_overlayfs 1
    ! is_on get_overlay_conf || fail "raspi-config hat das Overlay nicht ausgetragen (Meldung oben)."
    status
    if is_on get_overlay_now && is_on get_bootro_conf; then
      note ""
      note "Die Boot-Partition bleibt auch nach dem Neustart nur lesbar: Das lässt raspi-config erst"
      note "ohne Overlay ändern. Zum Aktualisieren nach README genügt das. Braucht ein Systemupdate"
      note "(apt) die Boot-Partition: nach dem Neustart noch einmal sudo bash pi/overlay.sh off."
    fi
    step "Jetzt neu starten: sudo reboot. Danach ändern, dann wieder: sudo bash pi/overlay.sh on"
    ;;
  *)
    fail "Aufruf: sudo bash $0 status|on|off"
    ;;
esac
