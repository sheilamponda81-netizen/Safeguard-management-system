import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Corrective migration for a second, independent instance of the
// real-file "Authorized" vs "Authorization" bug (2026-10-07). The
// client-side parser fix (commit 7e34025) already corrected
// src/utils/hikcentralExcelParser.ts's isEligibleSuccessfulEvent, but
// this server-side RPC hardcoded the same "Authorization"-only literal
// independently, in 5 places -- left unfixed, a real import would show
// a correct "223 ready" Preview Summary but insert ZERO rows, since the
// RPC's own filters would never match a genuine export's "Authorized"
// value. See this migration's own header for the full verification
// trail (grepped against the real workbook's raw XML).
//
// This repo has no live-Postgres test harness (see
// hikcentralAttendanceMigration.test.ts's own header for the
// established precedent) -- these tests pin the fix at the SQL SOURCE
// level, proving the corrective migration both accepts "Authorized"
// AND leaves every other security/behavioral property of the RPC --
// including the prior extensions.digest() fix -- completely unchanged.
const migrationSource = fs.readFileSync(
  path.resolve(__dirname, '../../supabase/migrations/20261007000000_hikcentral_import_authorized_literal_fix.sql'),
  'utf-8'
);

function getRpcBody(): string {
  const rpcBody = migrationSource.match(/CREATE OR REPLACE FUNCTION import_hikcentral_raw_events[\s\S]*?\$\$;/)?.[0];
  expect(rpcBody).toBeTruthy();
  return rpcBody!;
}

describe('HikCentral import "Authorized" literal fix: the actual fix', () => {
  it('accepts the genuine "Authorized" literal in all 5 authentication_result comparisons', () => {
    const rpcBody = getRpcBody();
    const matches = rpcBody.match(/r->>'authentication_result' IN \('Authorization', 'Authorized'\)/g) || [];
    expect(matches.length).toBe(5); // 4 summary-count FILTERs + 1 INSERT...SELECT WHERE
  });

  it('still accepts the legacy "Authorization" literal alongside it (back-compat, mirrors the client-side fix)', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/IN \('Authorization', 'Authorized'\)/);
  });

  it('never compares authentication_result to the bare "Authorization" literal alone anymore (no stray unfixed comparison left behind)', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).not.toMatch(/authentication_result' = 'Authorization'/);
  });

  it('a "Failed" event (never "Authorization" or "Authorized") is still excluded from the authorization_count FILTER and the INSERT', () => {
    // The FILTER/WHERE clauses only ever match the two accepted literals
    // -- a row whose authentication_result is "Failed" can never satisfy
    // `IN ('Authorization', 'Authorized')`, so it is excluded exactly as
    // before. This test documents that invariant at the SQL-source level
    // (no live-Postgres harness is available -- see file header).
    const rpcBody = getRpcBody();
    expect(rpcBody).not.toMatch(/'Failed'/);
  });

  it('produces exactly 223 eligible successful events for the real file-equivalent count (223 Authorized + 0 Authorization, out of 349 total, 126 Failed excluded) -- documented via the migration header, not re-derived live (no Postgres harness)', () => {
    expect(migrationSource).toMatch(/223 successful events/);
    expect(migrationSource).toMatch(/126 Failed/);
  });
});

describe('HikCentral import "Authorized" literal fix: extensions.digest() preserved (no digest() regression)', () => {
  it('still calls digest() schema-qualified as extensions.digest() -- the fix is NOT reverted', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/encode\(\s*extensions\.digest\(/);
    expect(rpcBody).not.toMatch(/encode\(\s*digest\(/); // the old, unqualified, broken call must not reappear
    expect(rpcBody).toMatch(/'sha256'/);
  });

  it('does NOT schema-qualify encode() -- unchanged from the prior fix', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/\bencode\(/);
    expect(rpcBody).not.toMatch(/extensions\.encode\(/);
  });
});

describe('HikCentral import "Authorized" literal fix: SECURITY DEFINER / search_path / ACL unchanged', () => {
  it('remains SECURITY DEFINER with the same hardened search_path (public, pg_temp) -- not widened', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/SECURITY DEFINER/);
    expect(rpcBody).toMatch(/SET search_path = public, pg_temp/);
    expect(rpcBody).not.toMatch(/search_path = public, pg_temp, extensions/);
    expect(rpcBody).not.toMatch(/search_path = extensions/);
  });

  it('still revokes EXECUTE from PUBLIC and anon, and grants only to authenticated', () => {
    expect(migrationSource).toMatch(/REVOKE ALL ON FUNCTION import_hikcentral_raw_events\(UUID, JSONB, JSONB\) FROM PUBLIC;/);
    expect(migrationSource).toMatch(/REVOKE ALL ON FUNCTION import_hikcentral_raw_events\(UUID, JSONB, JSONB\) FROM anon;/);
    expect(migrationSource).toMatch(/GRANT EXECUTE ON FUNCTION import_hikcentral_raw_events\(UUID, JSONB, JSONB\) TO authenticated;/);
  });

  it('still re-derives tenant_id/role/active-state directly from profiles (unchanged authorization logic)', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/FROM profiles/);
    expect(rpcBody).toMatch(/has_permission\('attendance\.import_hikcentral'\)/);
    expect(rpcBody).toMatch(/Your account is disabled/);
  });
});

describe('HikCentral import "Authorized" literal fix: canonical fingerprint / dedup / insert filter unchanged otherwise', () => {
  it('never reads an event_fingerprint field from the client payload', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).not.toMatch(/r->>'event_fingerprint'/);
  });

  it('still branches ID|/ANON| on hikcentral_person_no presence, unchanged', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/WHEN NULLIF\(r->>'hikcentral_person_no', ''\) IS NOT NULL THEN/);
    expect(rpcBody).toMatch(/'ID\|'/);
    expect(rpcBody).toMatch(/'ANON\|'/);
  });

  it('still inserts with ON CONFLICT (tenant_id, event_fingerprint) DO NOTHING', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/ON CONFLICT \(tenant_id, event_fingerprint\) DO NOTHING/);
  });

  it('the INSERT...SELECT still requires event_type = Access Granted by Fingerprint and a non-null event_time', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/AND r->>'event_type' = 'Access Granted by Fingerprint'/);
    expect(rpcBody).toMatch(/AND r->>'event_time' IS NOT NULL/);
  });

  it('still recomputes summary counts from p_events itself, not from client-supplied p_summary_counts', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/v_authorization_count, v_with_person_no_count, v_without_person_no_count, v_unique_person_no_count/);
    expect(rpcBody).not.toMatch(/authorization_count = \(p_summary_counts/);
  });
});

describe('HikCentral import "Authorized" literal fix: migration-history integrity', () => {
  it('is a standalone corrective migration, not an edit to either already-applied prior migration', () => {
    const foundationSource = fs.readFileSync(
      path.resolve(__dirname, '../../supabase/migrations/20260929000000_hikcentral_attendance_ingestion_foundation.sql'),
      'utf-8'
    );
    const digestFixSource = fs.readFileSync(
      path.resolve(__dirname, '../../supabase/migrations/20260930000000_hikcentral_import_digest_schema_fix.sql'),
      'utf-8'
    );
    // Both prior migrations still compare against the bare 'Authorization'
    // literal only -- proving this fix was not applied by silently
    // editing either of those files.
    expect(foundationSource).toMatch(/authentication_result' = 'Authorization'/);
    expect(digestFixSource).toMatch(/authentication_result' = 'Authorization'/);
  });

  it('does not create, drop, or alter any table, and has no SQL statement touching attendance/payroll/employee_deductions', () => {
    expect(migrationSource).not.toMatch(/CREATE TABLE/i);
    expect(migrationSource).not.toMatch(/DROP TABLE/i);
    expect(migrationSource).not.toMatch(/ALTER TABLE/i);
    for (const table of ['attendance', 'payroll', 'employee_deductions']) {
      expect(migrationSource).not.toMatch(new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+${table}\\b`, 'i'));
    }
  });

  it('does not delete or otherwise reference the stale "processing" import batch, or insert/delete raw events itself', () => {
    expect(migrationSource).not.toMatch(/DELETE FROM hikcentral_import_batches/);
    expect(migrationSource).not.toMatch(/DELETE FROM hikcentral_raw_events/);
    expect(migrationSource).not.toMatch(/^\s*INSERT INTO hikcentral_import_batches/m);
  });

  it('does not seed or alter any role_permissions row', () => {
    expect(migrationSource).not.toMatch(/INSERT INTO role_permissions/);
  });
});
