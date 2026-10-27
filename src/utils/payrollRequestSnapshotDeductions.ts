// Pure TS parity mirror of ONE expression inside the SQL function
// compute_payroll_request_snapshot() (supabase/migrations/
// 20261104000000_payroll_request_snapshot_deduction_null_safety_fix.sql),
// kept here solely so this fix has fast, repo-committed regression
// coverage without requiring a live database. Not called from any
// production code path -- the real total is always computed server-side.
//
// paye/pension/uniform_deduction are typed as possibly null/undefined
// here (unlike PayrollRecordInput in payrollProcessing.ts) because the
// bug this mirrors was exactly a runtime JSONB value being NULL or
// absent despite the TS interface's optimistic `number` typing.
export interface OrdinaryDeductionFields {
  paye?: number | null;
  pension?: number | null;
  uniform_deduction?: number | null;
}

export function sumOrdinaryDeductionsTotal(records: OrdinaryDeductionFields[]): number {
  return records.reduce(
    (total, r) => total + (r.paye ?? 0) + (r.pension ?? 0) + (r.uniform_deduction ?? 0),
    0
  );
}
