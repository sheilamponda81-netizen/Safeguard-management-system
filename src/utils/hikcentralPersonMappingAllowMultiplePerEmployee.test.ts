import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Corrective migration (2026-10-07) for the Person Mapping schema
// foundation: a read-only discovery audit established that the
// cardinality must be "one HikCentral Person No. -> at most one
// employee" but "one employee -> may have multiple HikCentral Person
// Nos" (a guard may be enrolled more than once, or at more than one
// terminal, under a different Person No.). The foundation migration's
// uq_hikcentral_person_mappings_active_employee unique index enforced
// 1:1 in BOTH directions, which is too strict. This migration drops
// that unique index and replaces it with a plain (non-unique) index on
// the same columns, while leaving uq_hikcentral_person_mappings_active_
// person (the Person-No.-side uniqueness) completely untouched.
//
// This repo has no live-Postgres test harness (see
// hikcentralAttendanceMigration.test.ts's own header for the
// established precedent) -- these tests pin the fix at the SQL SOURCE
// level, proving the corrective migration makes exactly this change and
// nothing else: no data touched (table is empty), no RLS/FK/CHECK
// changes, no normalization of hikcentral_person_no anywhere, and no
// write to any unrelated table.
const migrationSource = fs.readFileSync(
  path.resolve(__dirname, '../../supabase/migrations/20261007130000_hikcentral_person_mapping_allow_multiple_per_employee.sql'),
  'utf-8'
);

const ALL_MIGRATION_FILES = fs.readdirSync(path.resolve(__dirname, '../../supabase/migrations')).filter((f) => f.endsWith('.sql'));

function readMigration(filename: string): string {
  return fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/', filename), 'utf-8');
}

describe('HikCentral Person Mapping schema foundation: the fix itself', () => {
  it('drops the active-employee UNIQUE index', () => {
    expect(migrationSource).toMatch(/DROP INDEX IF EXISTS uq_hikcentral_person_mappings_active_employee;/);
  });

  it('replaces it with a NON-UNIQUE index on the identical columns (tenant_id, employee_id) WHERE is_active -- same query-performance shape, no uniqueness', () => {
    expect(migrationSource).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_hikcentral_person_mappings_active_employee\s*\n\s*ON hikcentral_person_mappings \(tenant_id, employee_id\)\s*\n\s*WHERE is_active;/
    );
    expect(migrationSource).not.toMatch(/CREATE UNIQUE INDEX[\s\S]*?active_employee/);
  });

  it('contains no SQL statement (CREATE/DROP/ALTER INDEX) referencing uq_hikcentral_person_mappings_active_person -- Person No. uniqueness is unchanged (it is only mentioned in prose, explaining that it is untouched)', () => {
    expect(migrationSource).not.toMatch(/\b(CREATE|DROP|ALTER)\s+(UNIQUE\s+)?INDEX[^;]*active_person/is);
  });
});

describe('HikCentral Person Mapping schema foundation: cumulative cardinality proof (across all migrations, since this one only drops/re-creates one index)', () => {
  it('uq_hikcentral_person_mappings_active_person is created exactly once (in the foundation migration) and never dropped by any migration -- one Person No. still cannot have two simultaneously active employee mappings', () => {
    const creations = ALL_MIGRATION_FILES
      .map(readMigration)
      .filter((src) => /CREATE UNIQUE INDEX IF NOT EXISTS uq_hikcentral_person_mappings_active_person/.test(src));
    expect(creations.length).toBe(1);
    const drops = ALL_MIGRATION_FILES
      .map(readMigration)
      .filter((src) => /DROP INDEX IF EXISTS uq_hikcentral_person_mappings_active_person\b/.test(src));
    expect(drops.length).toBe(0);
  });

  it('no UNIQUE constraint or index on employee_id (alone, or tenant_id+employee_id) remains anywhere in the cumulative migration set -- one employee CAN have multiple simultaneously active Person Nos (e.g. HikCentral 00000104 and 87 both -> the same employee)', () => {
    const allSources = ALL_MIGRATION_FILES.map(readMigration);
    // The only unique index that ever existed on employee_id was
    // uq_hikcentral_person_mappings_active_employee, created in the
    // foundation migration and dropped (not re-created unique) here.
    const uniqueEmployeeCreations = allSources.filter((src) =>
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_hikcentral_person_mappings_active_employee/.test(src)
    );
    expect(uniqueEmployeeCreations.length).toBe(1); // only the original foundation creation
    const uniqueEmployeeDrops = allSources.filter((src) =>
      /DROP INDEX IF EXISTS uq_hikcentral_person_mappings_active_employee/.test(src)
    );
    expect(uniqueEmployeeDrops.length).toBe(1); // dropped by this migration
    // And the replacement is explicitly non-unique.
    const nonUniqueReplacement = allSources.filter((src) =>
      /CREATE INDEX IF NOT EXISTS idx_hikcentral_person_mappings_active_employee/.test(src)
    );
    expect(nonUniqueReplacement.length).toBe(1);
  });

  it('the foundation migration historically still shows the OLD (now-superseded) unique-both-directions design -- proves this is a layered corrective migration, not a silent edit', () => {
    const foundationSource = readMigration('20260929000000_hikcentral_attendance_ingestion_foundation.sql');
    expect(foundationSource).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_hikcentral_person_mappings_active_employee/);
  });
});

describe('HikCentral Person Mapping schema foundation: no normalization of hikcentral_person_no anywhere', () => {
  it('neither the dropped nor the replacement index is a functional/expression index -- both are plain-column, proving no normalization (lpad/ltrim/numeric cast) is applied to hikcentral_person_no for uniqueness purposes', () => {
    expect(migrationSource).not.toMatch(/lpad\(/i);
    expect(migrationSource).not.toMatch(/ltrim\(/i);
    expect(migrationSource).not.toMatch(/::int/i);
    expect(migrationSource).not.toMatch(/::numeric/i);
  });

  it('no migration anywhere defines a functional/expression index on hikcentral_person_no (it is always the plain column)', () => {
    const allSources = ALL_MIGRATION_FILES.map(readMigration).join('\n');
    expect(allSources).not.toMatch(/INDEX[\s\S]*?\(\s*(?:lpad|ltrim|trim|lower|upper)\([^)]*hikcentral_person_no/i);
  });
});

describe('HikCentral Person Mapping schema foundation: scope and safety boundaries', () => {
  it('is a standalone corrective migration -- does not edit any previously-applied migration file', () => {
    // Confirmed above (foundation migration still shows the old design).
    expect(migrationSource).not.toMatch(/ALTER TABLE hikcentral_import_batches/i);
  });

  it('does not create, alter, or drop any TABLE, and has no SQL statement touching attendance/payroll/payment_status/employee_deductions/employees', () => {
    expect(migrationSource).not.toMatch(/CREATE TABLE/i);
    expect(migrationSource).not.toMatch(/DROP TABLE/i);
    expect(migrationSource).not.toMatch(/ALTER TABLE/i);
    for (const table of ['attendance', 'payroll', 'payment_status', 'employee_deductions', 'employees']) {
      expect(migrationSource).not.toMatch(new RegExp(`\\b(FROM|INTO|UPDATE|JOIN)\\s+${table}\\b`, 'i'));
    }
  });

  it('contains no INSERT/UPDATE/DELETE statement at all -- pure DDL, no data is touched (the table is empty, no backfill needed or performed)', () => {
    expect(migrationSource).not.toMatch(/^\s*INSERT INTO/im);
    expect(migrationSource).not.toMatch(/^\s*UPDATE\s+\w+\s+SET/im);
    expect(migrationSource).not.toMatch(/^\s*DELETE FROM/im);
  });

  it('does not touch RLS policies, the CHECK constraint, or any foreign key on hikcentral_person_mappings (no actual DDL statement for any of these -- only explained in prose as unaffected)', () => {
    expect(migrationSource).not.toMatch(/\b(CREATE|DROP|ALTER)\s+POLICY/i);
    expect(migrationSource).not.toMatch(/\bADD CONSTRAINT\b/i);
    expect(migrationSource).not.toMatch(/\bDROP CONSTRAINT\b/i);
    expect(migrationSource).not.toMatch(/REFERENCES \w+\(/); // no new FK definition
  });

  it('documents the required future collision guardrail (exact-Person-No. with conflicting names must surface for human review, never silently auto-confirmed) without implementing mapping-domain application code in this schema-only step', () => {
    expect(migrationSource).toMatch(/FUTURE COLLISION GUARDRAIL/);
    expect(migrationSource).toMatch(/MUST NOT silently treat an exact\s*\n--\s*Person No\. match as unquestionably clean identity evidence/);
    expect(migrationSource).toMatch(/access-point scoping is\s*\n--\s*explicitly rejected as a workaround/);
  });
});
