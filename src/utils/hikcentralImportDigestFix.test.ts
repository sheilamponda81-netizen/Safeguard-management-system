import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Corrective migration for the real-first-import failure on STAGING
// (2026-09-29): `function digest(text, unknown) does not exist`. Root
// cause, verified on STAGING (not guessed): pgcrypto's digest() lives in
// schema `extensions`, not `public`, and import_hikcentral_raw_events()
// is SECURITY DEFINER with `SET search_path = public, pg_temp`, which
// excludes `extensions`. See this migration's own header for the full
// verification trail.
//
// This repo has no live-Postgres test harness (see
// hikcentralAttendanceMigration.test.ts's own header for the established
// precedent) -- these tests pin the fix at the SQL SOURCE level, proving
// the corrective migration both fixes the digest() call AND leaves every
// other security/behavioral property of the RPC completely unchanged.
const migrationSource = fs.readFileSync(
  path.resolve(__dirname, '../../supabase/migrations/20260930000000_hikcentral_import_digest_schema_fix.sql'),
  'utf-8'
);

function getRpcBody(): string {
  const rpcBody = migrationSource.match(/CREATE OR REPLACE FUNCTION import_hikcentral_raw_events[\s\S]*?\$\$;/)?.[0];
  expect(rpcBody).toBeTruthy();
  return rpcBody!;
}

describe('HikCentral import digest() schema fix: the actual fix', () => {
  it('calls digest() schema-qualified as extensions.digest(), matching the schema verified on STAGING', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/encode\(\s*extensions\.digest\(/);
    expect(rpcBody).not.toMatch(/encode\(\s*digest\(/); // the old, unqualified, broken call must be gone
    expect(rpcBody).toMatch(/'sha256'/);
  });

  it('does NOT schema-qualify encode() -- pg_catalog builtins are always on the search path regardless of SET search_path', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/\bencode\(/);
    expect(rpcBody).not.toMatch(/extensions\.encode\(/);
    expect(rpcBody).not.toMatch(/pg_catalog\.encode\(/);
  });

  it('documents the verified root cause and fix in the migration header, not just the code change', () => {
    expect(migrationSource).toMatch(/function digest\(text, unknown\) does not exist/);
    expect(migrationSource).toMatch(/pgcrypto is installed in schema `extensions`/);
  });
});

describe('HikCentral import digest() schema fix: SECURITY DEFINER / search_path / ACL unchanged', () => {
  it('remains SECURITY DEFINER with the same hardened search_path (public, pg_temp) -- not widened to include extensions', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/SECURITY DEFINER/);
    expect(rpcBody).toMatch(/SET search_path = public, pg_temp/);
    expect(rpcBody).not.toMatch(/search_path = public, pg_temp, extensions/);
    expect(rpcBody).not.toMatch(/search_path = extensions/);
  });

  it('still revokes EXECUTE from PUBLIC and anon', () => {
    expect(migrationSource).toMatch(/REVOKE ALL ON FUNCTION import_hikcentral_raw_events\(UUID, JSONB, JSONB\) FROM PUBLIC;/);
    expect(migrationSource).toMatch(/REVOKE ALL ON FUNCTION import_hikcentral_raw_events\(UUID, JSONB, JSONB\) FROM anon;/);
  });

  it('still intentionally grants EXECUTE to authenticated', () => {
    expect(migrationSource).toMatch(/GRANT EXECUTE ON FUNCTION import_hikcentral_raw_events\(UUID, JSONB, JSONB\) TO authenticated;/);
  });

  it('still re-derives tenant_id/role/active-state directly from profiles (unchanged authorization logic)', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/FROM profiles/);
    expect(rpcBody).toMatch(/has_permission\('attendance\.import_hikcentral'\)/);
    expect(rpcBody).toMatch(/Your account is disabled/);
  });
});

describe('HikCentral import digest() schema fix: canonical fingerprint construction unchanged', () => {
  it('never reads an event_fingerprint field from the client payload -- still nothing for a caller to forge', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).not.toMatch(/r->>'event_fingerprint'/);
  });

  it('still branches on whether hikcentral_person_no is present (identified -- deterministic cross-file dedup) or not (anonymous)', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/WHEN NULLIF\(r->>'hikcentral_person_no', ''\) IS NOT NULL THEN/);
    expect(rpcBody).toMatch(/'ID\|'/);
    expect(rpcBody).toMatch(/'ANON\|'/);
  });

  it('identified-branch fingerprint still keys on tenant_id/person_no/event_time/access_point/card_reader/result/type, unchanged', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(
      /'ID\|' \|\| v_tenant_id::text \|\| '\|' \|\| \(r->>'hikcentral_person_no'\) \|\| '\|' \|\|\s*\n\s*\(r->>'event_time'\) \|\| '\|' \|\| COALESCE\(r->>'access_point', ''\) \|\| '\|' \|\|\s*\n\s*COALESCE\(r->>'card_reader', ''\) \|\| '\|' \|\| \(r->>'authentication_result'\) \|\| '\|' \|\|\s*\n\s*\(r->>'event_type'\)/
    );
  });

  it('anonymous-branch fingerprint still uses the server-side batch file_fingerprint + source_row_ordinal, never inventing identity', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/v_batch_file_fingerprint/);
    expect(rpcBody).toMatch(/r->>'source_row_ordinal'/);
    expect(rpcBody).not.toMatch(/p_file_fingerprint/);
    expect(rpcBody).toMatch(
      /'ANON\|' \|\| v_tenant_id::text \|\| '\|' \|\| COALESCE\(v_batch_file_fingerprint, ''\) \|\| '\|' \|\|\s*\n\s*\(r->>'source_row_ordinal'\)/
    );
  });

  it('still excludes an anonymous row with no source_row_ordinal, rather than hashing a missing/empty ordinal', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/NULLIF\(r->>'hikcentral_person_no', ''\) IS NOT NULL\s*\n\s*OR r->>'source_row_ordinal' IS NOT NULL/);
  });

  it('still recomputes summary counts from p_events itself, not from client-supplied p_summary_counts', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/v_authorization_count, v_with_person_no_count, v_without_person_no_count, v_unique_person_no_count/);
    expect(rpcBody).not.toMatch(/authorization_count = \(p_summary_counts/);
  });

  it('still inserts with ON CONFLICT (tenant_id, event_fingerprint) DO NOTHING -- exact-duplicate protection unchanged', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/ON CONFLICT \(tenant_id, event_fingerprint\) DO NOTHING/);
  });
});

describe('HikCentral import digest() schema fix: migration-history integrity', () => {
  it('is a standalone corrective migration, not an edit to the already-applied foundation migration', () => {
    const foundationPath = path.resolve(
      __dirname,
      '../../supabase/migrations/20260929000000_hikcentral_attendance_ingestion_foundation.sql'
    );
    const foundationSource = fs.readFileSync(foundationPath, 'utf-8');
    // The foundation migration still has the ORIGINAL (unqualified) call --
    // proving this fix was not applied by silently editing that file.
    expect(foundationSource).toMatch(/encode\(\s*digest\(/);
  });

  it('does not create, drop, or alter any table, and has no SQL statement touching attendance/payroll/employee_deductions', () => {
    expect(migrationSource).not.toMatch(/CREATE TABLE/i);
    expect(migrationSource).not.toMatch(/DROP TABLE/i);
    expect(migrationSource).not.toMatch(/ALTER TABLE/i);
    // The header comment legitimately names these tables when explaining
    // what's out of scope -- so this checks actual SQL statement forms
    // (FROM/INTO/UPDATE/JOIN a table), not bare word occurrence in prose.
    for (const table of ['attendance', 'payroll', 'employee_deductions']) {
      expect(migrationSource).not.toMatch(new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+${table}\\b`, 'i'));
    }
  });

  it('does not seed or alter any role_permissions row', () => {
    expect(migrationSource).not.toMatch(/INSERT INTO role_permissions/);
  });

  it('does not delete or otherwise reference the failed first import batch', () => {
    expect(migrationSource).not.toMatch(/DELETE FROM hikcentral_import_batches/);
    expect(migrationSource).not.toMatch(/DELETE FROM hikcentral_raw_events/);
  });
});
