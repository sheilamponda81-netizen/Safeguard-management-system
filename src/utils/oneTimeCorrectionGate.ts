// Pure gating logic for the one-time SFG-IMP-261110 employee correction
// panel (src/components/OneTimeEmployeeCorrection261110.tsx), split out so
// it's testable without rendering a component or touching Supabase. This
// is UI convenience only -- the real authorization boundary is the
// correct_sfg_imp_261110_import() RPC itself, which independently checks
// is_super_admin() and the caller's tenant_id server-side regardless of
// what this code decides to show.

// Must match the exact confirmation phrase the RPC requires
// (correction_rpc_migration.sql's p_confirm check) -- kept as one named
// constant so the two can never drift apart.
export const CORRECTION_CONFIRM_PHRASE = 'CONFIRM-293-CENTRAL';

export function shouldShowCorrectionPanel(
  profile: { is_super_admin?: boolean | null } | null | undefined,
  importedCount: number
): boolean {
  return Boolean(profile?.is_super_admin) && importedCount > 0;
}

// The only thing standing between the button being visible and the RPC
// actually being called: an explicit, affirmed confirmation. confirmFn is
// injected (rather than calling window.confirm directly) so this can be
// unit-tested with a stub, and so the RPC is never reachable from a bare
// render or an automatic effect -- only from this function returning
// non-null, which only happens after confirmFn() returns true.
export function getCorrectionRpcArgs(
  confirmFn: () => boolean
): { p_confirm: string } | null {
  if (!confirmFn()) return null;
  return { p_confirm: CORRECTION_CONFIRM_PHRASE };
}
