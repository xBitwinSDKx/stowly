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
set -euo pipefail

CONFIG=/etc/stowly-print/stowly-print.toml

step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
fail() {
  printf '\nFEHLER: %s\n' "$*" >&2
  exit 1
}

overlay_now() { grep -qw "boot=overlay" /proc/cmdline; }
boot_dir() { if [ -d /boot/firmware ]; then echo /boot/firmware; else echo /boot; fi; }
overlay_next() { grep -qw "boot=overlay" "$(boot_dir)/cmdline.txt" 2>/dev/null; }

status() {
  if overlay_now; then note "Overlay jetzt: an (Änderungen gehen beim Neustart verloren)"; else note "Overlay jetzt: aus"; fi
  if overlay_next; then note "Overlay nach dem Neustart: an"; else note "Overlay nach dem Neustart: aus"; fi
  note "Wurzelverzeichnis: $(findmnt -no FSTYPE,OPTIONS / 2>/dev/null || echo unbekannt)"
  note "Boot-Partition: $(findmnt -no OPTIONS "$(boot_dir)" 2>/dev/null || echo unbekannt)"
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
    if [ ! -f /etc/dnsmasq.d/stowly-ap.conf ]; then
      note "Hinweis: Der Access Point ist nicht eingerichtet (access-point.sh). Trotzdem weiter?"
      read -r -p "    [j/N] " answer
      case "$answer" in j | J | ja | y | Y) ;; *) fail "Abgebrochen, nichts geändert." ;; esac
    fi
    step "Overlay einschalten (raspi-config); dabei kann raspi-config ein Paket nachinstallieren wollen"
    raspi-config nonint do_overlayfs 0
    step "Boot-Partition nur lesbar"
    raspi-config nonint enable_bootro || note "Ging nicht; in sudo raspi-config unter Performance Options → Overlay File System nachholen."
    status
    step "Jetzt neu starten: sudo reboot"
    ;;
  off)
    step "Overlay ausschalten (raspi-config)"
    raspi-config nonint do_overlayfs 1
    step "Boot-Partition wieder beschreibbar"
    raspi-config nonint disable_bootro || note "Ging nicht; nach dem Neustart in sudo raspi-config nachholen."
    status
    step "Jetzt neu starten: sudo reboot. Danach ändern, dann wieder: sudo bash pi/overlay.sh on"
    ;;
  *)
    fail "Aufruf: sudo bash $0 status|on|off"
    ;;
esac
