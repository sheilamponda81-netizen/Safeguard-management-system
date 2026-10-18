import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Corrective migration for a real cross-file anonymous-event dedup bug
// (2026-10-07), discovered when a newly obtained COMBINED multi-terminal
// HikCentral export was found to re-export the SAME physical HEAD
// OFFICE events (already imported) inside a different workbook/row
// layout. The anonymous branch of event_fingerprint used to depend on
// the importing file's own content hash + the row's position within it
// -- stable for same-file re-import, but NOT stable across two
// different, overlapping exports of the same physical events. See this
// migration's own header for the full collision analysis performed
// against the real STAGING data before choosing the new identity tuple.
//
// This repo has no live-Postgres test harness (see
// hikcentralAttendanceMigration.test.ts's own header for the
// established precedent) -- these tests pin the fix at the SQL SOURCE
// level, proving the corrective migration adopts the new stable
// anonymous identity tuple, backfills the 48 pre-existing anonymous rows
// to match it (with preflight collision checks that abort before any
// write), and leaves every other security/behavioral property of the
// RPC -- including the "Authorized"/"Authorization" acceptance and the
// prior extensions.digest() fix -- completely unchanged.
const migrationSource = fs.readFileSync(
  path.resolve(__dirname, '../../supabase/migrations/20261007010000_hikcentral_anonymous_fingerprint_cross_file_fix.sql'),
  'utf-8'
);

function getRpcBody(): string {
  const rpcBody = migrationSource.match(/CREATE OR REPLACE FUNCTION import_hikcentral_raw_events[\s\S]*?\$\$;/)?.[0];
  expect(rpcBody).toBeTruthy();
  return rpcBody!;
}

describe('HikCentral anonymous fingerprint cross-file fix: the function fix itself', () => {
  it('the ANON branch no longer includes v_batch_file_fingerprint or source_row_ordinal in its hash input', () => {
    const rpcBody = getRpcBody();
    const anonBranch = rpcBody.match(/ELSE\s*\n\s*'ANON\|'[\s\S]*?END,/)?.[0];
    expect(anonBranch).toBeTruthy();
    expect(anonBranch).not.toMatch(/v_batch_file_fingerprint/);
    expect(anonBranch).not.toMatch(/source_row_ordinal/);
  });

  it('the ANON branch now includes event_time, exactly like the ID branch (minus hikcentral_person_no)', () => {
    const rpcBody = getRpcBody();
    const anonBranch = rpcBody.match(/ELSE\s*\n\s*'ANON\|'[\s\S]*?END,/)?.[0];
    expect(anonBranch).toBeTruthy();
    expect(anonBranch).toMatch(/\(r->>'event_time'\)/);
    expect(anonBranch).toMatch(/COALESCE\(r->>'access_point', ''\)/);
    expect(anonBranch).toMatch(/COALESCE\(r->>'card_reader', ''\)/);
    expect(anonBranch).toMatch(/\(r->>'authentication_result'\)/);
    expect(anonBranch).toMatch(/\(r->>'event_type'\)/);
  });

  it('source_row_ordinal is STILL required for an anonymous row to be admitted (unchanged admission invariant, even though no longer hashed)', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/NULLIF\(r->>'hikcentral_person_no', ''\) IS NOT NULL\s*\n\s*OR r->>'source_row_ordinal' IS NOT NULL/);
  });

  it('still branches ID|/ANON| on hikcentral_person_no presence, unchanged', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/WHEN NULLIF\(r->>'hikcentral_person_no', ''\) IS NOT NULL THEN/);
    expect(rpcBody).toMatch(/'ID\|'/);
    expect(rpcBody).toMatch(/'ANON\|'/);
  });

  it('the identified (ID) branch is completely unchanged by this fix', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(
      /'ID\|' \|\| v_tenant_id::text \|\| '\|' \|\| \(r->>'hikcentral_person_no'\) \|\| '\|' \|\|\s*\n\s*\(r->>'event_time'\) \|\| '\|' \|\| COALESCE\(r->>'access_point', ''\) \|\| '\|' \|\|\s*\n\s*COALESCE\(r->>'card_reader', ''\) \|\| '\|' \|\| \(r->>'authentication_result'\) \|\| '\|' \|\|\s*\n\s*\(r->>'event_type'\)/
    );
  });
});

describe('HikCentral anonymous fingerprint cross-file fix: Authorized/Authorization/digest/Failed-exclusion preserved', () => {
  it('still accepts both "Authorized" and legacy "Authorization" in all 5 comparisons', () => {
    const rpcBody = getRpcBody();
    const matches = rpcBody.match(/r->>'authentication_result' IN \('Authorization', 'Authorized'\)/g) || [];
    expect(matches.length).toBe(5);
  });

  it('still calls digest() schema-qualified as extensions.digest() -- not reverted', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/encode\(\s*extensions\.digest\(/);
    expect(rpcBody).not.toMatch(/encode\(\s*digest\(/);
  });

  it('a "Failed" event is still excluded -- the INSERT...SELECT WHERE never matches it', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).not.toMatch(/'Failed'/);
    expect(rpcBody).toMatch(/AND r->>'event_type' = 'Access Granted by Fingerprint'/);
  });

  it('still inserts with ON CONFLICT (tenant_id, event_fingerprint) DO NOTHING', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/ON CONFLICT \(tenant_id, event_fingerprint\) DO NOTHING/);
  });

  it('remains SECURITY DEFINER with the same hardened search_path, and the same REVOKE/GRANT ACL', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/SECURITY DEFINER/);
    expect(rpcBody).toMatch(/SET search_path = public, pg_temp/);
    expect(migrationSource).toMatch(/REVOKE ALL ON FUNCTION import_hikcentral_raw_events\(UUID, JSONB, JSONB\) FROM PUBLIC;/);
    expect(migrationSource).toMatch(/REVOKE ALL ON FUNCTION import_hikcentral_raw_events\(UUID, JSONB, JSONB\) FROM anon;/);
    expect(migrationSource).toMatch(/GRANT EXECUTE ON FUNCTION import_hikcentral_raw_events\(UUID, JSONB, JSONB\) TO authenticated;/);
  });
});

describe('HikCentral anonymous fingerprint cross-file fix: backfill safety', () => {
  it('performs a preflight check for duplicate NEW fingerprints among anonymous rows, and RAISEs EXCEPTION (aborting with no write) if any are found', () => {
    expect(migrationSource).toMatch(/v_dup_among_new/);
    expect(migrationSource).toMatch(/RAISE EXCEPTION[\s\S]*?v_dup_among_new/);
  });

  it('performs a preflight check for a new anonymous fingerprint colliding with a DIFFERENT existing row current fingerprint, and RAISEs EXCEPTION if found', () => {
    expect(migrationSource).toMatch(/v_collides_with_other/);
    expect(migrationSource).toMatch(/RAISE EXCEPTION[\s\S]*?v_collides_with_other/);
    // Must compare against a DIFFERENT row (id <>), not itself.
    expect(migrationSource).toMatch(/other_row\.id <> anon_row\.id/);
  });

  it('the backfill UPDATE only targets anonymous rows (hikcentral_person_no IS NULL), never an identified row', () => {
    const updateBlock = migrationSource.match(/UPDATE hikcentral_raw_events\s*\n\s*SET event_fingerprint[\s\S]*?;/)?.[0];
    expect(updateBlock).toBeTruthy();
    expect(updateBlock).toMatch(/WHERE NULLIF\(hikcentral_person_no, ''\) IS NULL/);
  });

  it('the backfill recomputes event_time as the exact ISO-8601-with-milliseconds-and-Z format the client sends (not a generic ::text cast)', () => {
    // A bare ::text cast of a timestamptz renders as "2026-10-04 15:53:46+00",
    // NOT the "2026-10-04T15:53:46.000Z" the client actually sends and the
    // live RPC hashes -- using the wrong format would make the backfilled
    // fingerprint permanently mismatch what a fresh import computes for the
    // same physical event, defeating the entire fix.
    expect(migrationSource).toMatch(/to_char\(event_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'\) \|\| '\.000Z'/);
    expect(migrationSource).not.toMatch(/event_time::text/);
  });

  it('the backfill UPDATE and both preflight checks use the identical hash formula (same literal structure), so they cannot drift from each other', () => {
    const anonFormulaOccurrences = migrationSource.match(/'ANON\|' \|\| (?:anon_row\.)?tenant_id::text \|\| '\|' \|\|\s*\n\s*\(to_char\((?:anon_row\.)?event_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'\) \|\| '\.000Z'\) \|\| '\|' \|\|/g) || [];
    expect(anonFormulaOccurrences.length).toBe(3); // preflight check 1, preflight check 2, the UPDATE itself
  });

  it('documents the collision analysis performed against real STAGING data (zero collisions found) rather than asserting safety without evidence', () => {
    expect(migrationSource).toMatch(/COLLISION ANALYSIS/);
    expect(migrationSource).toMatch(/ZERO groups with more than one row/);
    expect(migrationSource).toMatch(/0 of the 48 anonymous rows carry a non-null first_name\/last_name/);
  });
});

describe('HikCentral anonymous fingerprint cross-file fix: migration-history integrity and scope', () => {
  it('is a standalone corrective migration, not an edit to any previously-applied migration', () => {
    const priorFiles = [
      '20260929000000_hikcentral_attendance_ingestion_foundation.sql',
      '20260930000000_hikcentral_import_digest_schema_fix.sql',
      '20261007000000_hikcentral_import_authorized_literal_fix.sql',
    ];
    for (const file of priorFiles) {
      const priorSource = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/', file), 'utf-8');
      // All three prior migrations still use the OLD anonymous-branch
      // construction (file_fingerprint + source_row_ordinal) -- proving
      // this fix was not applied by silently editing any of them.
      expect(priorSource).toMatch(/v_batch_file_fingerprint/);
      expect(priorSource).toMatch(/\(r->>'source_row_ordinal'\) \|\|/);
    }
  });

  it('does not create, drop, or alter any table or constraint', () => {
    expect(migrationSource).not.toMatch(/CREATE TABLE/i);
    expect(migrationSource).not.toMatch(/DROP TABLE/i);
    expect(migrationSource).not.toMatch(/ALTER TABLE/i);
  });

  it('has no SQL statement touching attendance/payroll/payment_status/employee_deductions/employees', () => {
    for (const table of ['attendance', 'payroll', 'payment_status', 'employee_deductions', 'employees']) {
      expect(migrationSource).not.toMatch(new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+${table}\\b`, 'i'));
    }
  });

  it('does not INSERT or DELETE against hikcentral_import_batches or hikcentral_person_mappings (the pre-existing UPDATE of hikcentral_import_batches inside the unchanged function body on successful completion is expected and untouched by this fix)', () => {
    expect(migrationSource).not.toMatch(/\bINSERT INTO\s+hikcentral_import_batches\b/i);
    expect(migrationSource).not.toMatch(/\bDELETE FROM\s+hikcentral_import_batches\b/i);
    expect(migrationSource).not.toMatch(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+hikcentral_person_mappings\b/i);
  });

  it('the only UPDATE this migration performs against hikcentral_raw_events sets exclusively the event_fingerprint column', () => {
    const rawEventUpdates = migrationSource.match(/UPDATE hikcentral_raw_events\s*\n\s*SET[\s\S]*?;/g) || [];
    expect(rawEventUpdates.length).toBe(1);
    expect(rawEventUpdates[0]).toMatch(/SET event_fingerprint =/);
    expect(rawEventUpdates[0]).not.toMatch(/SET event_fingerprint = [\s\S]*?,\s*\n?\s*\w+\s*=/); // no second column set
  });

  it('does not delete or reinsert any raw event row -- only updates in place (the INSERT inside the function body is the pre-existing, unchanged live-import statement, not part of the backfill)', () => {
    expect(migrationSource).not.toMatch(/DELETE FROM hikcentral_raw_events/);
    const insertStatements = migrationSource.match(/INSERT INTO hikcentral_raw_events[\s\S]*?;/g) || [];
    expect(insertStatements.length).toBe(1); // exactly the function's own live-import INSERT, unchanged
    expect(insertStatements[0]).toMatch(/FROM jsonb_array_elements\(p_events\) AS r/); // confirms it's the live-import statement, not a backfill re-insert
  });
});
