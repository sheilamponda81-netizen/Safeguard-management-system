import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// New Person Mapping write path: confirm_hikcentral_person_mappings().
// This repo has no live-Postgres test harness (see
// hikcentralAttendanceMigration.test.ts's own header for the established
// precedent) -- these tests pin the function at the SQL SOURCE level,
// proving its SECURITY INVOKER design, its app-level validations (Person
// No. existence, the conflicting-names guardrail, employee active
// status), its remap/history semantics, its transactional all-or-nothing
// shape, and that it never touches any unrelated table.
const migrationSource = fs.readFileSync(
  path.resolve(__dirname, '../../supabase/migrations/20261007140000_hikcentral_person_mapping_confirm_rpc.sql'),
  'utf-8'
);

function getRpcBody(): string {
  const rpcBody = migrationSource.match(/CREATE OR REPLACE FUNCTION confirm_hikcentral_person_mappings[\s\S]*?\$\$;/)?.[0];
  expect(rpcBody).toBeTruthy();
  return rpcBody!;
}

describe('confirm_hikcentral_person_mappings: security model', () => {
  it('is SECURITY INVOKER, not SECURITY DEFINER -- relies on existing RLS for authorization, never re-implements it', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/SECURITY INVOKER/);
    expect(rpcBody).not.toMatch(/SECURITY DEFINER/);
  });

  it('sets a restricted search_path, matching every other HikCentral function in this project', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/SET search_path = public, pg_temp/);
  });

  it('requires authentication explicitly', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/IF v_caller_id IS NULL THEN\s*\n\s*RAISE EXCEPTION 'Not authenticated'/);
  });

  it('is revoked from PUBLIC and anon, granted only to authenticated', () => {
    expect(migrationSource).toMatch(/REVOKE ALL ON FUNCTION confirm_hikcentral_person_mappings\(JSONB\) FROM PUBLIC;/);
    expect(migrationSource).toMatch(/REVOKE ALL ON FUNCTION confirm_hikcentral_person_mappings\(JSONB\) FROM anon;/);
    expect(migrationSource).toMatch(/GRANT EXECUTE ON FUNCTION confirm_hikcentral_person_mappings\(JSONB\) TO authenticated;/);
  });
});

describe('confirm_hikcentral_person_mappings: exact-raw-Person-No. safety', () => {
  it('validates Person No. existence with a plain exact-string comparison, never a numeric cast or normalization', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/WHERE hikcentral_person_no = v_person_no/);
    expect(rpcBody).not.toMatch(/::int/i);
    expect(rpcBody).not.toMatch(/::numeric/i);
    expect(rpcBody).not.toMatch(/lpad\(/i);
    expect(rpcBody).not.toMatch(/ltrim\(v_person_no/i);
  });

  it('rejects a null or empty hikcentral_person_no', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/IF v_person_no IS NULL OR btrim\(v_person_no\) = '' THEN/);
  });

  it('rejects confirmation for a Person No. not present in the caller-visible raw events', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/SELECT EXISTS \(\s*\n\s*SELECT 1 FROM hikcentral_raw_events WHERE hikcentral_person_no = v_person_no\s*\n\s*\) INTO v_event_exists;/);
    expect(rpcBody).toMatch(/IF NOT v_event_exists THEN/);
  });
});

describe('confirm_hikcentral_person_mappings: conflict guardrail', () => {
  it('computes distinct non-empty normalized names for the exact Person No. and rejects confirmation if more than one exists', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/COUNT\(DISTINCT upper\(btrim\(regexp_replace\(COALESCE\(first_name, ''\) \|\| ' ' \|\| COALESCE\(last_name, ''\), '\\s\+', ' ', 'g'\)\)\)\)/);
    expect(rpcBody).toMatch(/IF v_distinct_name_count > 1 THEN\s*\n\s*RAISE EXCEPTION 'Person No % has conflicting names/);
  });

  it('excludes blank names from the conflict count (a blank name is not a conflicting second identity)', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/AND btrim\(COALESCE\(first_name, ''\) \|\| COALESCE\(last_name, ''\)\) <> ''/);
  });
});

describe('confirm_hikcentral_person_mappings: employee validation', () => {
  it('requires the target employee to be Active and not soft-deleted', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/SELECT status, is_deleted INTO v_employee_status, v_employee_deleted\s*\n\s*FROM employees WHERE id = v_employee_id;/);
    expect(rpcBody).toMatch(/IF v_employee_status IS DISTINCT FROM 'Active' OR COALESCE\(v_employee_deleted, false\) THEN/);
  });

  it('rejects an employee_id the caller cannot see at all (RLS-scoped SELECT returning no row)', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/IF NOT FOUND THEN\s*\n\s*RAISE EXCEPTION 'Employee not found or not accessible/);
  });

  it('validates match_method against the same allowed set as the table CHECK constraint', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/IF v_match_method NOT IN \('manual', 'suggested_name', 'suggested_employee_number'\) THEN/);
  });
});

describe('confirm_hikcentral_person_mappings: cardinality and remap/history semantics', () => {
  it('one exact Person No. cannot acquire a second active mapping silently -- an existing active mapping to a DIFFERENT employee is explicitly superseded first', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/WHERE tenant_id = get_current_tenant_id\(\) AND hikcentral_person_no = v_person_no AND is_active;/);
    expect(rpcBody).toMatch(/UPDATE hikcentral_person_mappings\s*\n\s*SET is_active = false, superseded_at = NOW\(\), superseded_by = v_caller_id/);
  });

  it('re-confirming the SAME employee for an already-mapped Person No. is an idempotent no-op, not an error and not a duplicate row', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/IF FOUND AND v_existing_employee_id = v_employee_id THEN/);
    expect(rpcBody).toMatch(/CONTINUE; -- idempotent no-op/);
  });

  it('sets confirmed_by/confirmed_at and is_active=true on every newly-written mapping row', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/INSERT INTO hikcentral_person_mappings \(\s*\n\s*tenant_id, hikcentral_person_no, employee_id, match_method,\s*\n\s*confirmed_by, confirmed_at, is_active\s*\n\s*\) VALUES \(\s*\n\s*get_current_tenant_id\(\), v_person_no, v_employee_id, v_match_method,\s*\n\s*v_caller_id, NOW\(\), true\s*\n\s*\);/);
  });

  it('does not place an UPDATE or DELETE on hikcentral_person_mappings outside the documented supersede path (no unrelated mutation of existing rows)', () => {
    const rpcBody = getRpcBody();
    const updateStatements = rpcBody.match(/UPDATE hikcentral_person_mappings[\s\S]*?;/g) || [];
    expect(updateStatements.length).toBe(1);
    expect(updateStatements[0]).toMatch(/SET is_active = false, superseded_at = NOW\(\), superseded_by = v_caller_id/);
    expect(rpcBody).not.toMatch(/DELETE FROM hikcentral_person_mappings/);
  });
});

describe('confirm_hikcentral_person_mappings: transactional bulk behavior', () => {
  it('loops over a JSON array of confirmations within a single function call (one implicit transaction -- any RAISE EXCEPTION rolls back the whole call)', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/FOR v_item IN SELECT \* FROM jsonb_array_elements\(p_confirmations\)/);
    expect(rpcBody).toMatch(/END LOOP;/);
  });

  it('rejects a null, non-array, or empty confirmations payload up front', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/IF p_confirmations IS NULL OR jsonb_typeof\(p_confirmations\) <> 'array' OR jsonb_array_length\(p_confirmations\) = 0 THEN/);
  });

  it('returns a confirmed_count and already_mapped_count summary', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/RETURN jsonb_build_object\(\s*\n\s*'confirmed_count', v_confirmed_count,\s*\n\s*'already_mapped_count', v_skipped_already_mapped_count\s*\n\s*\);/);
  });
});

describe('confirm_hikcentral_person_mappings: scope and safety boundaries', () => {
  it('is a standalone corrective migration, not an edit to any previously-applied migration', () => {
    const priorFiles = [
      '20260929000000_hikcentral_attendance_ingestion_foundation.sql',
      '20260930000000_hikcentral_import_digest_schema_fix.sql',
      '20261007000000_hikcentral_import_authorized_literal_fix.sql',
      '20261007010000_hikcentral_anonymous_fingerprint_cross_file_fix.sql',
      '20261007130000_hikcentral_person_mapping_allow_multiple_per_employee.sql',
    ];
    for (const file of priorFiles) {
      expect(fs.existsSync(path.resolve(__dirname, '../../supabase/migrations/', file))).toBe(true);
    }
    expect(migrationSource).not.toMatch(/CREATE OR REPLACE FUNCTION import_hikcentral_raw_events/);
  });

  it('does not create, alter, or drop any table, policy, or constraint', () => {
    expect(migrationSource).not.toMatch(/CREATE TABLE/i);
    expect(migrationSource).not.toMatch(/ALTER TABLE/i);
    expect(migrationSource).not.toMatch(/DROP TABLE/i);
    expect(migrationSource).not.toMatch(/\b(CREATE|DROP|ALTER)\s+POLICY/i);
  });

  it('has no SQL statement touching attendance/payroll/payment_status/employee_deductions, and never writes to employees', () => {
    for (const table of ['attendance', 'payroll', 'payment_status', 'employee_deductions']) {
      expect(migrationSource).not.toMatch(new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+${table}\\b`, 'i'));
    }
    expect(migrationSource).not.toMatch(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+employees\b/i);
    expect(migrationSource).not.toMatch(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+hikcentral_raw_events\b/i);
    expect(migrationSource).not.toMatch(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+hikcentral_import_batches\b/i);
  });

  it('only ever writes hikcentral_person_mappings based on caller-supplied (person_no, employee_id, match_method) tuples -- never invents or auto-selects a mapping candidate on its own', () => {
    const rpcBody = getRpcBody();
    expect(rpcBody).toMatch(/v_person_no := v_item->>'hikcentral_person_no';/);
    expect(rpcBody).toMatch(/v_employee_id := \(v_item->>'employee_id'\)::UUID;/);
  });
});
