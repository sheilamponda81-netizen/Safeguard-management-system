import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// This repo has no live-Postgres test harness (no pg-mem, no local
// Supabase instance spun up in CI) -- every other RLS/constraint-level
// expectation in this codebase is therefore pinned at the SQL SOURCE
// level, not exercised against a real database (see e.g.
// src/pages/payslipsNavigation.test.ts's own header for the established
// precedent). These tests do the same for the HikCentral ingestion
// migration: they assert the SQL text contains the specific
// tenant-isolation/RLS/constraint clauses the design calls for, so a
// future edit that silently drops one of them fails a test instead of
// only being caught in a manual STAGING review.
const migrationSource = fs.readFileSync(
  path.resolve(__dirname, '../../supabase/migrations/20260929000000_hikcentral_attendance_ingestion_foundation.sql'),
  'utf-8'
);

describe('HikCentral ingestion migration: tenant isolation / RLS expectations (test 14)', () => {
  it('enables RLS on all three new tables', () => {
    expect(migrationSource).toMatch(/ALTER TABLE hikcentral_import_batches ENABLE ROW LEVEL SECURITY/);
    expect(migrationSource).toMatch(/ALTER TABLE hikcentral_raw_events ENABLE ROW LEVEL SECURITY/);
    expect(migrationSource).toMatch(/ALTER TABLE hikcentral_person_mappings ENABLE ROW LEVEL SECURITY/);
  });

  it('every SELECT/INSERT/UPDATE policy checks tenant_id = get_current_tenant_id() (never a bare/unscoped policy)', () => {
    const policyBlocks = migrationSource.match(/CREATE POLICY[\s\S]*?;/g) || [];
    const hikcentralPolicies = policyBlocks.filter((p) => p.includes('HikCentral'));
    expect(hikcentralPolicies.length).toBeGreaterThanOrEqual(6); // 2 (batches) + 1 (raw_events SELECT) + 3 (mappings)
    for (const policy of hikcentralPolicies) {
      expect(policy).toMatch(/tenant_id = get_current_tenant_id\(\)/);
      expect(policy).toMatch(/is_current_user_active\(\)/);
      expect(policy).toMatch(/is_super_admin\(\)/);
    }
  });

  it('hikcentral_raw_events has NO client-facing INSERT/UPDATE/DELETE policy -- writes only via the SECURITY DEFINER RPC', () => {
    // Only one CREATE POLICY for this table (the SELECT one) should exist.
    const rawEventPolicies = (migrationSource.match(/CREATE POLICY "HikCentral raw events:[\s\S]*?;/g) || []);
    expect(rawEventPolicies).toHaveLength(1);
    expect(rawEventPolicies[0]).toMatch(/FOR SELECT/);
  });

  it('hikcentral_import_batches has no client-facing UPDATE policy -- only the RPC transitions status/counts', () => {
    const batchPolicies = migrationSource.match(/CREATE POLICY "HikCentral import batches:[\s\S]*?;/g) || [];
    expect(batchPolicies).toHaveLength(2); // SELECT + INSERT only
    expect(batchPolicies.some((p) => /FOR UPDATE/.test(p))).toBe(false);
  });

  it('neither hikcentral_raw_events nor hikcentral_import_batches has a DELETE policy (permanent audit records)', () => {
    expect(migrationSource).not.toMatch(/CREATE POLICY[^;]*hikcentral_raw_events[\s\S]*?FOR DELETE/);
    expect(migrationSource).not.toMatch(/CREATE POLICY[^;]*hikcentral_import_batches[\s\S]*?FOR DELETE/);
  });

  it('the ingestion RPC re-derives tenant_id/role/active-state directly from profiles, and never CALLS the one helper known to break under a restrictive search_path (get_current_tenant_id) -- mentioning it in an explanatory comment is fine, invoking it is not', () => {
    const rpcBody = migrationSource.match(/CREATE OR REPLACE FUNCTION import_hikcentral_raw_events[\s\S]*?\$\$;/)?.[0];
    expect(rpcBody).toBeTruthy();
    expect(rpcBody).toMatch(/FROM profiles/);
    expect(rpcBody).toMatch(/v_tenant_id/);
    const codeOnly = rpcBody!
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(codeOnly).not.toMatch(/get_current_tenant_id\(\)/);
  });

  it('the ingestion RPC validates the batch belongs to the caller\'s own tenant before inserting any raw events (cross-tenant write protection)', () => {
    const rpcBody = migrationSource.match(/CREATE OR REPLACE FUNCTION import_hikcentral_raw_events[\s\S]*?\$\$;/)?.[0];
    expect(rpcBody).toMatch(/v_batch_tenant_id <> v_tenant_id/);
  });

  it('the ingestion RPC is revoked from PUBLIC/anon and granted only to authenticated', () => {
    expect(migrationSource).toMatch(/REVOKE ALL ON FUNCTION import_hikcentral_raw_events\([^)]*\) FROM PUBLIC/);
    expect(migrationSource).toMatch(/REVOKE ALL ON FUNCTION import_hikcentral_raw_events\([^)]*\) FROM anon/);
    expect(migrationSource).toMatch(/GRANT EXECUTE ON FUNCTION import_hikcentral_raw_events\([^)]*\) TO authenticated/);
  });

  it('exact-duplicate protection: hikcentral_raw_events has UNIQUE(tenant_id, event_fingerprint) and the RPC inserts with ON CONFLICT DO NOTHING against it', () => {
    expect(migrationSource).toMatch(/UNIQUE \(tenant_id, event_fingerprint\)/);
    expect(migrationSource).toMatch(/ON CONFLICT \(tenant_id, event_fingerprint\) DO NOTHING/);
  });

  it('this migration never touches the attendance table (zero official attendance writes in this PR)', () => {
    expect(migrationSource).not.toMatch(/ALTER TABLE attendance\b/);
    expect(migrationSource).not.toMatch(/INSERT INTO attendance\b/);
    expect(migrationSource).not.toMatch(/UPDATE attendance\b/i);
  });

  it('does not create an "apply attendance" permission (out of scope for this PR)', () => {
    expect(migrationSource).not.toMatch(/attendance\.apply/);
  });
});

describe('HikCentral person-mapping model constraints (test 15)', () => {
  it('enforces at most one ACTIVE mapping per HikCentral Person No. per tenant via a partial unique index', () => {
    expect(migrationSource).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_hikcentral_person_mappings_active_person\s+ON hikcentral_person_mappings \(tenant_id, hikcentral_person_no\)\s+WHERE is_active/
    );
  });

  it('enforces at most one ACTIVE Person No. per employee per tenant via a partial unique index', () => {
    expect(migrationSource).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_hikcentral_person_mappings_active_employee\s+ON hikcentral_person_mappings \(tenant_id, employee_id\)\s+WHERE is_active/
    );
  });

  it('does NOT enforce a permanent table-level UNIQUE(tenant_id, employee_id) or UNIQUE(tenant_id, hikcentral_person_no) that would block re-mapping/history', () => {
    // A plain (non-partial) UNIQUE constraint on either column pair would
    // make superseding a mapping impossible without deleting the old row
    // first -- explicitly rejected by the approved product decision.
    expect(migrationSource).not.toMatch(/UNIQUE \(tenant_id, employee_id\)/);
    expect(migrationSource).not.toMatch(/UNIQUE \(tenant_id, hikcentral_person_no\)/);
  });

  it('has no DELETE policy on hikcentral_person_mappings -- history is superseded (is_active=false), never destroyed', () => {
    expect(migrationSource).not.toMatch(/CREATE POLICY[^;]*hikcentral_person_mappings[\s\S]*?FOR DELETE/);
  });

  it('supports supersede-history fields: is_active, superseded_at, superseded_by, alongside match_method/confirmed_by/confirmed_at', () => {
    const tableBlock = migrationSource.match(/CREATE TABLE IF NOT EXISTS hikcentral_person_mappings[\s\S]*?\n\);/)?.[0];
    expect(tableBlock).toBeTruthy();
    expect(tableBlock).toMatch(/is_active BOOLEAN NOT NULL DEFAULT true/);
    expect(tableBlock).toMatch(/superseded_at TIMESTAMPTZ/);
    expect(tableBlock).toMatch(/superseded_by UUID/);
    expect(tableBlock).toMatch(/match_method TEXT NOT NULL CHECK \(match_method IN \('manual', 'suggested_name', 'suggested_employee_number'\)\)/);
    expect(tableBlock).toMatch(/confirmed_by UUID/);
    expect(tableBlock).toMatch(/confirmed_at TIMESTAMPTZ/);
  });

  it('hikcentral_person_mappings SELECT/INSERT/UPDATE policies are region-scoped via employee_region_allowed(), matching the attendance/payroll convention', () => {
    const mappingPolicies = migrationSource.match(/CREATE POLICY "HikCentral person mappings:[\s\S]*?;/g) || [];
    expect(mappingPolicies).toHaveLength(3); // SELECT, INSERT, UPDATE
    for (const policy of mappingPolicies) {
      expect(policy).toMatch(/employee_region_allowed\(hikcentral_person_mappings\.employee_id\)/);
    }
  });

  it('hikcentral_raw_events does NOT store mapped_employee_id (resolved by JOIN against the active mapping, never frozen on the row)', () => {
    const tableBlock = migrationSource.match(/CREATE TABLE IF NOT EXISTS hikcentral_raw_events[\s\S]*?\n\);/)?.[0];
    expect(tableBlock).toBeTruthy();
    expect(tableBlock).not.toMatch(/mapped_employee_id/);
  });

  it('hikcentral_raw_events does NOT store a processing_status column (dynamic "unmapped" state is never frozen as an immutable fact)', () => {
    const tableBlock = migrationSource.match(/CREATE TABLE IF NOT EXISTS hikcentral_raw_events[\s\S]*?\n\);/)?.[0];
    expect(tableBlock).toBeTruthy();
    expect(tableBlock).not.toMatch(/processing_status/);
  });
});
