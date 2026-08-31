import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock only the one Supabase entry point this module touches (`rpc`), so
// these tests exercise approvePayrollRun()'s own request-shape and
// result-handling logic without a live Supabase instance.
//
// The RPC's own server-side atomicity/authorization logic -- the
// distinct-supplied-id-count vs. actual-updated-row-count comparison, the
// RAISE that rolls back the whole UPDATE on a mismatch, and the tenant/
// region re-check against supplied ids -- lives entirely in
// supabase/migrations/20260831000000_payroll_approval_rpc.sql and cannot
// be exercised through a mocked JS client. That SQL was instead verified
// directly against a real local Postgres 16 instance before this file was
// written (not merely reasoned about): the exact function body from the
// migration was loaded into a throwaway database alongside stand-ins for
// auth.uid()/get_current_tenant_id()/is_super_admin()/
// current_user_role_level() and a faithful payroll/employees/profiles
// schema, then exercised with a tampered snapshot (a regional Admin's
// supplied id list padded with another region's -- and separately another
// tenant's -- payroll id). In both cases the function raised, and the
// legitimate ids in the SAME request were confirmed to remain completely
// unmodified afterward -- proving the rollback covers the whole statement,
// not just the id that failed authorization. A super-admin snapshot
// spanning two tenants was also verified to update only the supplied ids,
// not an independently rediscovered global population for the month. The
// throwaway database was dropped and the temporary Postgres instance
// stopped immediately after; nothing here touches Supabase or any
// persistent database. These mocked-client tests below cover what a JS
// unit test legitimately can: approvePayrollRun()'s own request shape and
// its handling of every result the RPC can return.
const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));

vi.mock('../lib/supabase', () => ({
  supabase: { rpc: mockRpc },
}));

import { approvePayrollRun } from './payrollApproval';

function makeIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
}

describe('approvePayrollRun', () => {
  beforeEach(() => {
    mockRpc.mockReset();
  });

  it('approves a small (5-record) payroll run with a single RPC call', async () => {
    const ids = makeIds(5);
    mockRpc.mockResolvedValue({ data: 5, error: null });

    const result = await approvePayrollRun({ month: '2026-08', status: 'approved', notes: null, payrollIds: ids });

    expect(result).toEqual({ success: true, updatedCount: 5 });
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('approves a large (500+ synthetic) payroll run with exactly one RPC call, same shape as a small one', async () => {
    const ids = makeIds(537);
    mockRpc.mockResolvedValue({ data: 537, error: null });

    const result = await approvePayrollRun({ month: '2026-08', status: 'approved', notes: null, payrollIds: ids });

    expect(result).toEqual({ success: true, updatedCount: 537 });
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('sends the id array as an RPC body parameter (p_payroll_ids), not a URL filter, for 500+ ids', async () => {
    const ids = makeIds(537);
    mockRpc.mockResolvedValue({ data: 537, error: null });

    await approvePayrollRun({ month: '2026-08', status: 'approved', notes: 'looks good', payrollIds: ids });

    expect(mockRpc).toHaveBeenCalledWith('approve_payroll_run', {
      p_month: '2026-08',
      p_status: 'approved',
      p_notes: 'looks good',
      p_payroll_ids: ids,
    });
    // supabase.rpc() always sends its second argument as the POST body,
    // never serialized into the request URL the way .in(...) filters are
    // -- this call shape is inherently immune to the URL-length failure
    // this hotfix exists to fix, regardless of array size.
    const callArgs = mockRpc.mock.calls[0][1];
    expect(Array.isArray(callArgs.p_payroll_ids)).toBe(true);
    expect(callArgs.p_payroll_ids).toHaveLength(537);
  });

  it('no .from(\'payroll\').update().in(...) approval path remains, and no client-side batching/looping occurs', async () => {
    mockRpc.mockResolvedValue({ data: 500, error: null });

    await approvePayrollRun({ month: '2026-08', status: 'approved', notes: null, payrollIds: makeIds(500) });

    // The mocked supabase client exposes only `rpc` (see the vi.mock
    // above) -- if approvePayrollRun ever called supabase.from(...), this
    // test file's import would already have thrown on a call to a
    // nonexistent method. Exactly one call proves no per-batch looping.
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('deduplicates supplied ids before sending, though the RPC itself does not depend on this for correctness', async () => {
    const ids = makeIds(3);
    const withDuplicate = [...ids, ids[0]];
    mockRpc.mockResolvedValue({ data: 3, error: null });

    const result = await approvePayrollRun({ month: '2026-08', status: 'approved', notes: null, payrollIds: withDuplicate });

    expect(mockRpc.mock.calls[0][1].p_payroll_ids).toEqual(ids);
    expect(result).toEqual({ success: true, updatedCount: 3 });
  });

  it('treats the RPC\'s own all-or-nothing rollback (a scope-changed error) as a structured failure with a safe message, never as success', async () => {
    // This is what the RPC returns when its server-side count check
    // fails and it RAISEs -- verified against real Postgres to roll back
    // the entire UPDATE, not just the mismatched id(s) (see the file
    // header comment above).
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'Payroll approval scope changed; refresh and retry' },
    });

    const result = await approvePayrollRun({ month: '2026-08', status: 'approved', notes: null, payrollIds: makeIds(10) });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('scope_changed');
    expect(result.updatedCount).toBe(0);
    // Safe, useful message -- not raw Postgres/SQL internals.
    expect(result.error).toBe('Payroll data or approval scope changed. Refresh the payroll and try again.');
    expect(result.error).not.toContain('RAISE');
    expect(result.error).not.toContain('PL/pgSQL');
  });

  it('rejects a generic RPC error (e.g. unauthorized role) as a structured failure, never as success', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'Only managers and admins can approve payroll' },
    });

    const result = await approvePayrollRun({ month: '2026-08', status: 'approved', notes: null, payrollIds: makeIds(5) });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('rpc_error');
    expect(result.updatedCount).toBe(0);
  });

  it('rejects an unauthenticated-caller failure as a structured error', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'Not authenticated' },
    });

    const result = await approvePayrollRun({ month: '2026-08', status: 'approved', notes: null, payrollIds: makeIds(5) });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('rpc_error');
  });

  it('rejects an invalid-status failure as a structured error', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '22023', message: 'Invalid approval status: bogus' },
    });

    const result = await approvePayrollRun({ month: '2026-08', status: 'bogus' as 'approved', notes: null, payrollIds: makeIds(5) });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('rpc_error');
  });

  it('a regional Admin\'s tampered snapshot (ids from another region/tenant mixed in) surfaces as scope_changed, never a partial success', async () => {
    // From the wrapper's perspective this looks identical to any other
    // RPC-level failure: the server's atomicity guarantee means there is
    // no response shape representing "some approved, some rejected" for
    // it to even parse -- see the real-Postgres verification in this
    // file's header comment for the actual rollback proof.
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'Payroll approval scope changed; refresh and retry' },
    });

    const result = await approvePayrollRun({ month: '2026-08', status: 'approved', notes: null, payrollIds: makeIds(4) });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('scope_changed');
  });

  it('a super admin approving a snapshot spanning multiple tenants is a normal full success when the RPC reports the full supplied count', async () => {
    const ids = makeIds(500);
    mockRpc.mockResolvedValue({ data: 500, error: null });

    const result = await approvePayrollRun({ month: '2026-08', status: 'approved', notes: null, payrollIds: ids });

    // The RPC never independently rediscovers a global population for a
    // super admin -- it only ever updates the supplied ids (verified
    // against real Postgres) -- so a full match here is the expected
    // super-admin shape, identical in kind to a regional Admin's smaller
    // snapshot.
    expect(result).toEqual({ success: true, updatedCount: 500 });
  });

  it('treats a network-level throw the same as a structured RPC error, never as success', async () => {
    mockRpc.mockRejectedValue(new Error('Failed to fetch'));

    const result = await approvePayrollRun({ month: '2026-08', status: 'approved', notes: null, payrollIds: makeIds(5) });

    expect(result.success).toBe(false);
    expect(result.reason).toBe('rpc_error');
  });

  it('never exposes raw error internals for a non-scope-changed failure -- error text is always run through the safe error mapper', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'permission denied for table payroll' },
    });

    const result = await approvePayrollRun({ month: '2026-08', status: 'approved', notes: null, payrollIds: makeIds(5) });

    expect(result.error).not.toContain('permission denied for table payroll');
    expect(result.error).toBe('You do not have permission to perform this action.');
  });
});
