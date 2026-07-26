#!/usr/bin/env bash
# Migrationen + RLS-Tests gegen einen echten Postgres fahren (MS1).
#
# Läuft ohne Docker und ohne Supabase-CLI: Ein nacktes Postgres 16 genügt,
# das auth-Schema bildet supabase/tests/00_local_shim.sql nach. Damit ist
# jede Policy und jeder Constraint lokal UND in CI verifizierbar.
#
# Aufruf:
#   scripts-ci/pg-test.sh                 # lokal: Unix-Socket /tmp, Port 5433
#   scripts-ci/pg-test.sh 5432 tcp        # CI: localhost:5432 mit PGPASSWORD
set -euo pipefail

PORT="${1:-5433}"
MODE="${2:-socket}"
DB="autotrd_test_$$"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$MODE" = "tcp" ]; then
  HOSTARG=(-h localhost)
else
  HOSTARG=(-h /tmp)
fi
PSQL=(psql "${HOSTARG[@]}" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)

if ! pg_isready "${HOSTARG[@]}" -p "$PORT" -q; then
  echo "Kein Postgres auf Port $PORT erreichbar ($MODE)." >&2
  echo "Start z. B.: pg_ctl -D <datadir> -o '-p $PORT -k /tmp' start" >&2
  exit 1
fi

cleanup() { "${PSQL[@]}" -d postgres -c "drop database if exists \"$DB\";" >/dev/null 2>&1 || true; }
trap cleanup EXIT

"${PSQL[@]}" -d postgres -c "create database \"$DB\";" >/dev/null
echo "Testdatenbank $DB angelegt."

"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/tests/00_local_shim.sql" >/dev/null
echo "auth-Shim eingespielt."

for f in "$ROOT"/supabase/migrations/*.sql; do
  "${PSQL[@]}" -d "$DB" -f "$f" >/dev/null
  echo "Migration $(basename "$f") eingespielt."
done

echo
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/tests/rls_test.sql"
