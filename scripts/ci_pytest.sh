#!/bin/sh
# Für GitHub Actions (.github/workflows/tests.yml): pytest für einen Testordner laufen lassen und
# jeden gescheiterten Test als Annotation melden. Annotationen gibt GitHub auch ohne Anmeldung
# heraus (API check-runs/<id>/annotations), das Log eines Laufs nur angemeldet.
#
#   sh scripts/ci_pytest.sh server/tests
log=$(mktemp)
python -m pytest -q "$1" -p no:cacheprovider -rfE > "$log" 2>&1
status=$?
cat "$log"
grep -E '^(FAILED|ERROR) ' "$log" | head -20 | while IFS= read -r line; do
  printf '::error title=%s::%s\n' "$1" "$(printf '%s' "$line" | sed -e 's/%/%25/g')"
done
details=$(grep -E '^E  ' "$log" | head -40 | sed -e 's/%/%25/g' | awk '{ printf "%s%%0A", $0 }')
if [ -n "$details" ]; then
  printf '::error title=%s (Einzelheiten)::%s\n' "$1" "$details"
fi
rm -f "$log"
exit "$status"
