#!/usr/bin/env bash
# Zertifikat für den Druckdienst des Pi: HTTPS auf seine IP-Adresse (docs/etiketten.md, 5.6).
# Anleitung: pi/README.md, Abschnitt „Zertifikat". Läuft mit OpenSSL 1.1.1 oder neuer, auf jedem
# Rechner mit bash (auch auf dem Pi selbst). Den Schlüssel der Zertifizierungsstelle lieber nicht
# auf dem Pi erzeugen und nie dort liegen lassen.
#
#   bash pi/make-cert.sh ca --ip 10.71.83.1
#       eigene Zertifizierungsstelle (stowly-ca.crt, stowly-ca.key) und ein Zertifikat für den Pi
#       (pi.crt, pi.key)
#   bash pi/make-cert.sh issue --ip 10.71.83.1 --ca-cert meine-ca.crt --ca-key meine-ca.key
#       Zertifikat für den Pi mit einer vorhandenen Zertifizierungsstelle (pi.crt, pi.key)
#   bash pi/make-cert.sh csr --ip 10.71.83.1
#       nur Schlüssel und Antrag (pi.key, pi.csr), zum Unterschreiben bei der eigenen Stelle
#   bash pi/make-cert.sh show pi.crt
#       Inhalt eines Zertifikats anzeigen
#
# Immer: Subject Alternative Name mit der IP-Adresse, extendedKeyUsage = serverAuth, höchstens
# 825 Tage gültig (Grenze von Apple für private Zertifizierungsstellen), Schlüssel nur für den
# Besitzer lesbar. Bricht bei Fehlern ab und überschreibt nichts ohne --force.
set -euo pipefail

MODE=""
IPS=()
NAMES=()
OUT="stowly-zertifikat"
DAYS=825
CA_DAYS=3650
CA_NAME="Stowly Drucker-CA"
CA_CERT=""
CA_KEY=""
CHAIN=""
KEY_TYPE="ec"
FORCE=0
MAX_DAYS=825

usage() {
  cat <<'EOF'
Aufruf: bash pi/make-cert.sh ca|issue|csr [Angaben]
        bash pi/make-cert.sh show DATEI

  --ip ADRESSE        IP-Adresse des Pi (Pflicht, mehrfach möglich), z. B. 10.71.83.1
  --dns NAME          zusätzlich ein Name (freiwillig, mehrfach möglich)
  --out ORDNER        wohin die Dateien kommen (Vorgabe: ./stowly-zertifikat)
  --days N            Gültigkeit des Zertifikats für den Pi, 1 bis 825 Tage (Vorgabe 825)
  --key-type ec|rsa   Art des Schlüssels: ECDSA P-256 (Vorgabe, schnell auf dem Pi Zero) oder RSA 2048
  --force             vorhandene Dateien überschreiben

  nur ca:
  --ca-name NAME      Name der Zertifizierungsstelle (Vorgabe: Stowly Drucker-CA)
  --ca-days N         Gültigkeit der Zertifizierungsstelle (Vorgabe 3650 Tage)

  nur issue:
  --ca-cert DATEI     Zertifikat der vorhandenen Zertifizierungsstelle
  --ca-key DATEI      ihr Schlüssel (fragt nach dem Kennwort, falls er eines hat)
  --chain DATEI       Zwischenzertifikat(e), die der Pi mitschicken soll (freiwillig)
EOF
}

step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
fail() {
  printf '\nFEHLER: %s\n' "$*" >&2
  exit 1
}

command -v openssl >/dev/null || fail "openssl fehlt (Debian: sudo apt install openssl)."

if [ $# -eq 0 ]; then
  usage
  exit 1
fi
MODE="$1"
shift
case "$MODE" in
  -h | --help) usage; exit 0 ;;
  show)
    [ $# -eq 1 ] || fail "Aufruf: bash pi/make-cert.sh show DATEI"
    [ -f "$1" ] || fail "Die Datei $1 gibt es nicht."
    openssl x509 -in "$1" -noout -subject -issuer -serial -dates -fingerprint -sha256 \
      -ext subjectAltName,extendedKeyUsage,keyUsage,basicConstraints
    exit 0
    ;;
  ca | issue | csr) ;;
  *) fail "Unbekannte Art '$MODE': ca, issue, csr oder show (Hilfe: --help)" ;;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    --ip | --dns | --out | --days | --key-type | --ca-name | --ca-days | --ca-cert | --ca-key | --chain)
      [ $# -ge 2 ] || fail "$1 braucht einen Wert (Hilfe: --help)"
      case "$1" in
        --ip) IPS+=("$2") ;;
        --dns) NAMES+=("$2") ;;
        --out) OUT="$2" ;;
        --days) DAYS="$2" ;;
        --key-type) KEY_TYPE="$2" ;;
        --ca-name) CA_NAME="$2" ;;
        --ca-days) CA_DAYS="$2" ;;
        --ca-cert) CA_CERT="$2" ;;
        --ca-key) CA_KEY="$2" ;;
        --chain) CHAIN="$2" ;;
      esac
      shift 2
      ;;
    --force) FORCE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) fail "Unbekannte Angabe: $1 (Hilfe: --help)" ;;
  esac
done

# ---------------------------------------------------------------- Angaben prüfen
step "Angaben prüfen"
[ ${#IPS[@]} -gt 0 ] || fail "--ip fehlt: Der Pi wird über seine IP-Adresse angesprochen, nie über einen Namen."
octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
for ip in "${IPS[@]}"; do
  [[ "$ip" =~ ^$octet\.$octet\.$octet\.$octet$ ]] || fail "--ip $ip ist keine IPv4-Adresse."
done
for name in "${NAMES[@]}"; do
  [[ "$name" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]] || fail "--dns $name ist kein Rechnername."
done
[[ "$DAYS" =~ ^[0-9]+$ ]] && [ "$DAYS" -ge 1 ] && [ "$DAYS" -le "$MAX_DAYS" ] \
  || fail "--days $DAYS: erlaubt sind 1 bis $MAX_DAYS Tage (Apple nimmt längere Zertifikate nicht an)."
[[ "$CA_DAYS" =~ ^[0-9]+$ ]] && [ "$CA_DAYS" -ge 1 ] || fail "--ca-days $CA_DAYS ist keine Zahl von Tagen."
case "$KEY_TYPE" in ec | rsa) ;; *) fail "--key-type erwartet ec oder rsa." ;; esac
[[ "$CA_NAME" =~ ^[A-Za-z0-9\ ._-]{1,64}$ ]] || fail "--ca-name: nur Buchstaben, Ziffern, Leerzeichen, . _ - (höchstens 64)."
if [ "$MODE" = "issue" ]; then
  [ -n "$CA_CERT" ] && [ -n "$CA_KEY" ] || fail "issue braucht --ca-cert und --ca-key."
  [ -f "$CA_CERT" ] || fail "Das Zertifikat $CA_CERT gibt es nicht."
  [ -f "$CA_KEY" ] || fail "Den Schlüssel $CA_KEY gibt es nicht."
  [ -z "$CHAIN" ] || [ -f "$CHAIN" ] || fail "Die Datei $CHAIN gibt es nicht."
fi

SAN=""
for ip in "${IPS[@]}"; do SAN="${SAN:+$SAN, }IP:$ip"; done
for name in "${NAMES[@]}"; do SAN="${SAN:+$SAN, }DNS:$name"; done
note "Subject Alternative Name: $SAN"

# Alles, was entsteht, ist zunächst nur für den Besitzer lesbar; Zertifikate werden danach freigegeben.
umask 077
mkdir -p "$OUT"
case "$MODE" in
  ca) FILES=(stowly-ca.key stowly-ca.crt pi.key pi.crt) ;;
  issue) FILES=(pi.key pi.crt) ;;
  csr) FILES=(pi.key pi.csr) ;;
esac
if [ "$FORCE" -eq 0 ]; then
  for file in "${FILES[@]}"; do
    [ ! -e "$OUT/$file" ] || fail "$OUT/$file gibt es schon. Anderer Ordner (--out) oder --force."
  done
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

new_key() {
  if [ "$KEY_TYPE" = "ec" ]; then
    openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -pkeyopt ec_param_enc:named_curve -out "$1"
  else
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$1"
  fi
  chmod 600 "$1"
}

# ECDSA-Schlüssel signieren nur; RSA-Schlüssel dürfen auch verschlüsseln.
if [ "$KEY_TYPE" = "ec" ]; then LEAF_USAGE="critical, digitalSignature"; else LEAF_USAGE="critical, digitalSignature, keyEncipherment"; fi

cat >"$WORK/leaf.cnf" <<EOF
[req]
prompt = no
distinguished_name = dn
req_extensions = leaf

[dn]
CN = ${IPS[0]}
O = Stowly

[leaf]
basicConstraints = critical, CA:false
keyUsage = $LEAF_USAGE
extendedKeyUsage = serverAuth
subjectAltName = $SAN
subjectKeyIdentifier = hash
EOF

cat >"$WORK/sign.cnf" <<EOF
[leaf]
basicConstraints = critical, CA:false
keyUsage = $LEAF_USAGE
extendedKeyUsage = serverAuth
subjectAltName = $SAN
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid, issuer
EOF

sign() {
  # $1 Zertifikat der Stelle, $2 ihr Schlüssel; Seriennummer zufällig, keine .srl-Datei daneben.
  openssl x509 -req -in "$OUT/pi.csr" -CA "$1" -CAkey "$2" -set_serial "0x$(openssl rand -hex 16)" \
    -days "$DAYS" -sha256 -extfile "$WORK/sign.cnf" -extensions leaf -out "$WORK/pi.crt"
}

# ---------------------------------------------------------------- Zertifizierungsstelle
if [ "$MODE" = "ca" ]; then
  step "Eigene Zertifizierungsstelle: $CA_NAME, $CA_DAYS Tage"
  cat >"$WORK/ca.cnf" <<EOF
[req]
prompt = no
distinguished_name = dn
x509_extensions = ca

[dn]
CN = $CA_NAME
O = Stowly

[ca]
basicConstraints = critical, CA:true, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
EOF
  new_key "$OUT/stowly-ca.key"
  openssl req -x509 -new -key "$OUT/stowly-ca.key" -sha256 -days "$CA_DAYS" -config "$WORK/ca.cnf" \
    -out "$OUT/stowly-ca.crt"
  chmod 644 "$OUT/stowly-ca.crt"
  CA_CERT="$OUT/stowly-ca.crt"
  CA_KEY="$OUT/stowly-ca.key"
fi

# ---------------------------------------------------------------- Schlüssel und Antrag des Pi
step "Schlüssel und Antrag für den Pi ($KEY_TYPE)"
new_key "$OUT/pi.key"
openssl req -new -key "$OUT/pi.key" -config "$WORK/leaf.cnf" -out "$OUT/pi.csr"

if [ "$MODE" = "csr" ]; then
  chmod 644 "$OUT/pi.csr"
  step "Fertig: $OUT/pi.key (geheim) und $OUT/pi.csr"
  note "Den Antrag bei der eigenen Zertifizierungsstelle unterschreiben lassen, und zwar mit"
  note "  subjectAltName = $SAN, extendedKeyUsage = serverAuth, höchstens $MAX_DAYS Tage."
  note "Viele Stellen übernehmen die Erweiterungen aus dem Antrag nicht von selbst: Danach mit"
  note "  bash pi/make-cert.sh show pi.crt  prüfen, ob IP-Adresse und serverAuth drinstehen."
  exit 0
fi

# ---------------------------------------------------------------- Unterschreiben
step "Zertifikat für den Pi unterschreiben: $DAYS Tage"
sign "$CA_CERT" "$CA_KEY"
if [ -n "$CHAIN" ]; then
  cat "$WORK/pi.crt" "$CHAIN" >"$OUT/pi.crt"
else
  cp "$WORK/pi.crt" "$OUT/pi.crt"
fi
chmod 644 "$OUT/pi.crt"
rm -f "$OUT/pi.csr"

step "Prüfen"
if [ -n "$CHAIN" ]; then
  openssl verify -CAfile "$CA_CERT" -untrusted "$CHAIN" -purpose sslserver "$WORK/pi.crt"
else
  openssl verify -CAfile "$CA_CERT" -purpose sslserver "$WORK/pi.crt"
fi
openssl x509 -in "$WORK/pi.crt" -noout -subject -dates -ext subjectAltName,extendedKeyUsage | sed 's/^/    /'
note "Fingerabdruck der Zertifizierungsstelle (SHA-256), zum Vergleich auf dem Handy:"
note "  $(openssl x509 -in "$CA_CERT" -noout -fingerprint -sha256 | sed 's/^.*=//')"

step "Fertig"
note "Für den Pi:  $OUT/pi.crt und $OUT/pi.key (geheim)"
note "  sudo bash pi/install.sh ... --cert $OUT/pi.crt --key $OUT/pi.key"
if [ "$MODE" = "ca" ]; then
  note "Für die Handys: $OUT/stowly-ca.crt (README, „Zertifizierungsstelle auf dem Handy\")"
  note "Geheim und nicht auf dem Pi: $OUT/stowly-ca.key. Damit stellt man das nächste Zertifikat aus:"
  note "  bash pi/make-cert.sh issue --ip ${IPS[0]} --ca-cert $OUT/stowly-ca.crt --ca-key $OUT/stowly-ca.key --out neu"
fi
note "Das Zertifikat des Pi läuft ab am: $(openssl x509 -in "$WORK/pi.crt" -noout -enddate | sed 's/^notAfter=//')"
note "Rechtzeitig vorher ein neues ausstellen und mit install.sh einspielen (README)."
