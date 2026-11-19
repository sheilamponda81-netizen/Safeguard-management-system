#!/usr/bin/env bash
# Builds a from-scratch copy of this repo's current schema against a
# disposable Postgres (NEVER production) by applying:
#   1. bootstrap_stub.sql (Supabase-platform stand-ins -- see its own
#      header for exactly what and why).
#   2. every file in supabase/migrations/*.sql, in filename order,
#      except the 3 listed in SKIP_MIGRATIONS below.
#
# Used by .github/workflows/ci.yml against a disposable `postgres:16`
# service container, and safe to run the same way on a developer's own
# throwaway local Postgres. Takes its connection from the standard
# libpq PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE environment
# variables (read directly by psql) -- set those to point anywhere
# BUT a real Supabase project before running this.
#
# SKIP_MIGRATIONS, and why each is skipped (verified empirically by
# applying the full chain against an empty database and reading the
# resulting error for each):
#   - 20240618000000_create_indexes.sql,
#     20240619000000_tenant_isolation.sql: both predate
#     20260727000000_reconstructed_base_schema.sql, which that file's
#     own header explains is a full from-scratch reconstruction of the
#     base tables (employees, profiles, payroll, attendance, ...) that
#     were originally created outside of any migration. These two
#     files only ever bare `ALTER TABLE <table> ADD COLUMN ...` with no
#     existence guard, assuming those tables already exist -- on an
#     empty database they fail immediately. (20240619000001_
#     create_tenants.sql, the third pre-2026 file, is NOT skipped: it
#     only `CREATE TABLE IF NOT EXISTS tenants`, which the
#     reconstruction migration itself depends on and does not recreate.)
#   - 20260730000000_company_logo_storage.sql: creates a real Supabase
#     Storage bucket (storage.buckets row + bucket-level config) for
#     the company-logo upload feature -- entirely unrelated to
#     attendance/payroll/roster correctness, and storage.buckets'
#     real-Supabase-managed behavior (e.g. actual file storage) cannot
#     be meaningfully replicated in a plain Postgres container anyway.
#     The storage.objects RLS *policies* that reference this bucket
#     (defined in later migrations) still apply cleanly against this
#     script's storage.objects stub table in bootstrap_stub.sql.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$SCRIPT_DIR/../migrations"

SKIP_MIGRATIONS=(
  "20240618000000_create_indexes.sql"
  "20240619000000_tenant_isolation.sql"
  "20260730000000_company_logo_storage.sql"
)

is_skipped() {
  local f="$1"
  for s in "${SKIP_MIGRATIONS[@]}"; do
    [[ "$f" == "$s" ]] && return 0
  done
  return 1
}

echo "Applying CI schema bootstrap..."
psql -v ON_ERROR_STOP=1 -f "$SCRIPT_DIR/bootstrap_stub.sql"

while IFS= read -r f; do
  base="$(basename "$f")"
  if is_skipped "$base"; then
    echo "Skipping $base (see SKIP_MIGRATIONS in this script's header)"
    continue
  fi
  echo "Applying $base"
  psql -v ON_ERROR_STOP=1 -f "$f"
done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' | LC_ALL=C sort)

echo "CI schema build complete."
