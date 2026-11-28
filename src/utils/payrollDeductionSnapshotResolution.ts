// Salary Advances + Payroll & Payslip Financial Transparency audit --
// end-to-end completion pass. Shared by Payroll.tsx (management
// breakdown + drill-down) and Payslips.tsx (employee payslip) so both
// pages resolve a payroll row's itemized deduction breakdown via the
// EXACT SAME source-order rule, and can never disagree with each other.
//
// Source order, strictly in this priority:
//   1. A VALID, verified payroll_deduction_snapshots row set for this
//      EXACT payroll_id (supabase/migrations/
//      20261204000000_payroll_deduction_snapshot_capture.sql). "Valid"
//      is enforced by this module, not merely assumed from the rows'
//      mere presence -- see validateSnapshotRows() below. Always
//      queried/joined by payroll_id, never by employee+month alone --
//      this is what guarantees a figure is never mixed in from a
//      different payroll run for the same employee/month (a
//      reprocessed, since-superseded run, for instance), and this
//      module independently re-checks that every row's OWN payroll_id
//      actually matches the one the caller asked about, rather than
//      trusting that the caller's own query filter was correct.
//   2. No snapshot rows exist for that payroll_id at all (any month
//      processed before this migration existed, or where the snapshot
//      step itself was skipped -- see that migration's own fail-closed
//      gate) -- fall back to the PRE-EXISTING employee_deductions-row-
//      based logic (buildItemizedAttendanceBreakdown/
//      deriveItemizedAttendanceDeduction), completely unchanged.
//   3. Rows exist for this payroll_id but FAIL validation (a missing
//      category, a duplicate, a negative/non-finite amount, a row whose
//      own payroll_id doesn't match, or a total that doesn't reconcile
//      with the committed bundled deduction) -- this is NOT the same as
//      "no snapshot" and must never silently fall back to the
//      employee_deductions path either, which could show a DIFFERENT,
//      possibly-conflicting explanation for the same money. The caller
//      must surface an explicit integrity warning instead.
//   4. Neither 1 nor 2 nor 3 applies (no rows, see 2) -- the existing
//      honest "not itemized"/"itemized breakdown not available"
//      fallback, completely unchanged.
//
// A snapshot's own 'unallocated' category (see the migration's header)
// is surfaced here as `unallocatedAmount` -- genuinely unresolved
// evidence, never folded into 'uniform' or hidden. This is a NORMAL,
// VALID outcome (the processing-time check couldn't independently
// confirm the leftover was a genuine uniform charge), not a validation
// failure -- do not confuse it with the `invalid` status below, which
// means the snapshot's own data is structurally unsound or doesn't add
// up, never "it honestly couldn't resolve everything."

export type SnapshotCategory = 'uniform' | 'absence' | 'late' | 'lecture' | 'appearance' | 'unallocated';

const REQUIRED_CATEGORIES: readonly SnapshotCategory[] = ['uniform', 'absence', 'late', 'lecture', 'appearance'];
const ALL_KNOWN_CATEGORIES = new Set<string>([...REQUIRED_CATEGORIES, 'unallocated']);

// Matches the SQL capture function's own TOLERANCE (1 currency unit,
// i.e. 1 Kwacha) -- see this file's own header item 10 discussion and
// the migration's TOLERANCE usage. Kept as a single named constant here
// too so the two can never silently drift apart.
const TOLERANCE = 1;

export interface PayrollDeductionSnapshotRow {
  /** The payroll_id this row actually belongs to, as stored -- checked against the context passed to resolveDeductionSnapshot(), never assumed from how the caller happened to query. */
  payrollId: string;
  category: SnapshotCategory;
  amount: number;
  quantity: number | null;
  rate: number | null;
  source: string;
}

export interface ResolvedDeductionSnapshot {
  absenceDeduction: number;
  absenceDays: number | null;
  absenceRate: number | null;
  lateDeduction: number;
  lateDays: number | null;
  lateRate: number | null;
  lectureDeduction: number;
  appearanceDeduction: number;
  /** 0 when the position doesn't require one, or when nothing could be verified (see unallocatedAmount instead). */
  uniformDeduction: number;
  /** Genuinely unresolved evidence -- NOT a deduction type, never a legitimate "Uniform" amount. 0 when fully resolved. */
  unallocatedAmount: number;
  /** False whenever unallocatedAmount > 0 -- the caller must show that remainder explicitly, never hide it by only rendering the other categories. */
  complete: boolean;
}

export type SnapshotResolution =
  | { status: 'none' }
  | { status: 'available'; snapshot: ResolvedDeductionSnapshot }
  | { status: 'invalid'; reason: string };

export interface SnapshotResolutionContext {
  /** The EXACT payroll.id of the row currently being displayed -- every row's own payrollId must match this, not just the caller's query filter. */
  payrollId: string;
  /** The committed payroll.uniform_deduction this snapshot is supposed to explain -- every present category (including 'unallocated') must sum to this, within TOLERANCE. */
  bundledTotal: number;
}

function isFiniteNonNegative(value: number | null | undefined): boolean {
  return value === null || value === undefined || (Number.isFinite(value) && value >= 0);
}

/**
 * Structural + reconciliation validation, independent of whatever the
 * caller's own query happened to filter by. A snapshot is valid only
 * when:
 *   - every row belongs to the EXACT payroll_id being displayed;
 *   - every row's category is one of the known, fixed set (never a
 *     stray/corrupt value);
 *   - no category appears more than once (defense in depth beyond the
 *     database's own UNIQUE(payroll_id, category) constraint, which
 *     proves no duplicate ever got written for ONE payroll_id by THIS
 *     capture function, but says nothing about rows a caller might
 *     combine from more than one source, or a future writer that
 *     doesn't share that constraint);
 *   - all 5 REQUIRED categories (uniform, absence, late, lecture,
 *     appearance) are present -- 'unallocated' is optional;
 *   - every amount/quantity/rate is a finite, non-negative number;
 *   - the sum of every present category (including 'unallocated' when
 *     present) reconciles with the given bundledTotal within TOLERANCE.
 */
function validateSnapshotRows(rows: PayrollDeductionSnapshotRow[], context: SnapshotResolutionContext): string | null {
  const seenCategories = new Set<SnapshotCategory>();
  let total = 0;

  for (const row of rows) {
    if (row.payrollId !== context.payrollId) {
      return `row payroll_id "${row.payrollId}" does not match the displayed payroll_id "${context.payrollId}"`;
    }
    if (!ALL_KNOWN_CATEGORIES.has(row.category)) {
      return `unknown category "${row.category}"`;
    }
    if (seenCategories.has(row.category)) {
      return `duplicate category "${row.category}"`;
    }
    seenCategories.add(row.category);

    if (!isFiniteNonNegative(row.amount) || row.amount === null || row.amount === undefined) {
      return `category "${row.category}" has a non-finite or negative amount`;
    }
    if (!isFiniteNonNegative(row.quantity)) {
      return `category "${row.category}" has a non-finite or negative quantity`;
    }
    if (!isFiniteNonNegative(row.rate)) {
      return `category "${row.category}" has a non-finite or negative rate`;
    }

    total += row.amount;
  }

  const missing = REQUIRED_CATEGORIES.filter(c => !seenCategories.has(c));
  if (missing.length > 0) {
    return `missing required category/categories: ${missing.join(', ')}`;
  }

  if (!isFiniteNonNegative(context.bundledTotal) || context.bundledTotal === null || context.bundledTotal === undefined) {
    return 'bundledTotal supplied for reconciliation is not a finite, non-negative number';
  }

  if (Math.abs(total - context.bundledTotal) > TOLERANCE) {
    return `category total (${total}) does not reconcile with the committed bundled deduction (${context.bundledTotal})`;
  }

  return null;
}

/**
 * Resolves a payroll row's itemized breakdown strictly from its OWN,
 * VALIDATED payroll_deduction_snapshots rows. The caller must pass the
 * exact payroll_id being displayed and the committed bundled deduction
 * it is supposed to explain -- this function independently re-verifies
 * both against the row data, never trusting that whatever the caller
 * queried was already correct or complete.
 *
 *   - `{ status: 'none' }`: no snapshot rows exist for this payroll_id
 *     at all -- the caller falls through to its own employee_deductions-
 *     based fallback, or the honest "not itemized" fallback if that
 *     doesn't exist either.
 *   - `{ status: 'available', snapshot }`: a complete, internally
 *     consistent, reconciled snapshot -- safe to render as the
 *     authoritative explanation.
 *   - `{ status: 'invalid', reason }`: snapshot rows exist for this
 *     payroll_id but failed validation -- the caller MUST surface an
 *     explicit integrity/evidence warning and must NOT silently fall
 *     back to the employee_deductions path instead (that could show a
 *     conflicting explanation for the same money) and must NOT treat
 *     any of these rows as authoritative.
 */
export function resolveDeductionSnapshot(
  rows: PayrollDeductionSnapshotRow[] | null | undefined,
  context: SnapshotResolutionContext
): SnapshotResolution {
  if (!rows || rows.length === 0) return { status: 'none' };

  const invalidReason = validateSnapshotRows(rows, context);
  if (invalidReason) {
    return { status: 'invalid', reason: invalidReason };
  }

  const find = (category: SnapshotCategory) => rows.find(r => r.category === category);
  const absence = find('absence');
  const late = find('late');
  const lecture = find('lecture');
  const appearance = find('appearance');
  const uniform = find('uniform');
  const unallocated = find('unallocated');

  const unallocatedAmount = unallocated?.amount ?? 0;

  return {
    status: 'available',
    snapshot: {
      absenceDeduction: absence?.amount ?? 0,
      absenceDays: absence?.quantity ?? null,
      absenceRate: absence?.rate ?? null,
      lateDeduction: late?.amount ?? 0,
      lateDays: late?.quantity ?? null,
      lateRate: late?.rate ?? null,
      lectureDeduction: lecture?.amount ?? 0,
      appearanceDeduction: appearance?.amount ?? 0,
      uniformDeduction: uniform?.amount ?? 0,
      unallocatedAmount,
      complete: unallocatedAmount <= 0,
    },
  };
}
