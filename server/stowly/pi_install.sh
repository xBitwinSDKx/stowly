#!/bin/sh
# Stowly: Startskript für einen Raspberry Pi (docs/sync-protokoll.md, 11.8; pi/README.md).
#
# Der Stowly-Server liefert dieses Skript unter /api/pi/install.sh aus; die App zeigt den Befehl:
#
#   curl -fsSL http://192.168.1.10:8010/api/pi/install.sh | sudo sh -s -- ABCD-EFGH
#
# Vorher ansehen: dieselbe Adresse ohne "| sudo sh …" aufrufen, etwa curl -fsSL …/api/pi/install.sh | less
#
# Das Skript lädt das Paket mit pi/ und dem Druckdienst von diesem Server, prüft seine SHA-256,
# entpackt es in einen neuen Ordner unter /tmp und startet pi/install.sh --pair. Alles Weitere steht
# dort. Danach wird der Ordner wieder gelöscht.
#
# Alles steht in main(): So liest sh das ganze Skript, bevor etwas läuft, und kein Programm, das von
# der Standardeingabe liest, verschluckt den Rest des Skripts.

main() {
  server='@@SERVER@@'
  sha256='@@SHA256@@'

  fail() {
    printf '\nFEHLER: %s\n' "$*" >&2
    exit 1
  }

  if [ "$(id -u)" -ne 0 ]; then
    fail "Bitte mit sudo starten: curl -fsSL $server/api/pi/install.sh | sudo sh -s -- CODE"
  fi
  if [ $# -ne 1 ]; then
    fail "Genau ein Kopplungscode gehört dazu, etwa: curl -fsSL $server/api/pi/install.sh | sudo sh -s -- ABCD-EFGH"
  fi
  code=$1
  for tool in bash tar sha256sum mktemp; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool fehlt auf diesem Rechner."
  done

  dir=$(mktemp -d /tmp/stowly-pi.XXXXXXXX) || fail "Kein Ordner unter /tmp anzulegen."
  trap 'rm -rf "$dir"' EXIT
  trap 'exit 130' INT TERM HUP

  printf '==> Paket von %s laden\n' "$server"
  url="$server/api/pi/bundle.tar.gz"
  bundle="$dir/stowly-pi.tar.gz"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$bundle" "$url" || fail "Das Paket ließ sich nicht laden ($url)."
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$bundle" "$url" || fail "Das Paket ließ sich nicht laden ($url)."
  elif command -v python3 >/dev/null 2>&1; then
    python3 -I -c 'import sys, urllib.request; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])' "$url" "$bundle" \
      || fail "Das Paket ließ sich nicht laden ($url)."
  else
    fail "Zum Laden fehlen curl, wget und python3."
  fi

  printf '==> Prüfsumme (SHA-256 %s)\n' "$sha256"
  printf '%s  %s\n' "$sha256" "$bundle" | sha256sum -c - >/dev/null 2>&1 \
    || fail "Das Paket stimmt nicht mit der Prüfsumme überein. Bitte den Befehl neu aus der App holen."

  tar -xzf "$bundle" -C "$dir" --no-same-owner || fail "Das Paket ließ sich nicht entpacken."
  [ -f "$dir/stowly/pi/install.sh" ] || fail "Im Paket fehlt pi/install.sh."

  status=0
  bash "$dir/stowly/pi/install.sh" --pair "$server" "$code" </dev/null || status=$?
  exit "$status"
}

main "$@"
