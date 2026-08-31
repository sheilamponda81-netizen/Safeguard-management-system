import { describe, it, expect, vi, beforeEach } from 'vitest';

// logAudit() is called after a successful payroll approval (see
// approvePayroll() in src/pages/Payroll.tsx) -- its own catch block must
// never be able to make a genuinely-successful approval look like a
// failure. These tests prove logAudit() itself never throws/rejects,
// regardless of which internal Supabase call fails, which is the actual
// mechanism that guarantees that can't happen: nothing downstream of
// `await logAudit(...)` in approvePayroll() ever runs inside a try/catch
// that could misattribute an audit-only failure to the payroll write.
const { mockGetUser, mockProfilesSingle, mockAuditInsert } = vi.hoisted(() => ({
  mockGetUser: vi.fn(),
  mockProfilesSingle: vi.fn(),
  mockAuditInsert: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: { getUser: mockGetUser },
    from: (table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              single: mockProfilesSingle,
            }),
          }),
        };
      }
      if (table === 'audit_logs') {
        return { insert: mockAuditInsert };
      }
      throw new Error(`unexpected table in test: ${table}`);
    },
  },
}));

import { logAudit } from './auditLogger';

describe('logAudit', () => {
  beforeEach(() => {
    mockGetUser.mockReset();
    mockProfilesSingle.mockReset();
    mockAuditInsert.mockReset();
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'admin@example.com' } } });
    mockProfilesSingle.mockResolvedValue({ data: { role_level: 1, region_id: 'region-1', full_name: 'Admin', is_super_admin: false }, error: null });
  });

  it('resolves normally on a genuinely successful audit write', async () => {
    mockAuditInsert.mockResolvedValue({ error: null });

    await expect(
      logAudit({ action: 'APPROVE', entity_type: 'payroll', new_data: { month: '2026-08' } })
    ).resolves.toBeUndefined();
  });

  it('never throws when the audit_logs insert itself fails', async () => {
    mockAuditInsert.mockResolvedValue({ error: { code: '42501', message: 'permission denied' } });

    await expect(
      logAudit({ action: 'APPROVE', entity_type: 'payroll', new_data: { month: '2026-08' } })
    ).resolves.toBeUndefined();
  });

  it('never throws when the audit_logs insert rejects at the network level', async () => {
    mockAuditInsert.mockRejectedValue(new Error('Failed to fetch'));

    await expect(
      logAudit({ action: 'APPROVE', entity_type: 'payroll', new_data: { month: '2026-08' } })
    ).resolves.toBeUndefined();
  });

  it('never throws when the profiles lookup (for role/region) fails', async () => {
    mockProfilesSingle.mockResolvedValue({ data: null, error: { code: 'PGRST116', message: 'not found' } });
    mockAuditInsert.mockResolvedValue({ error: null });

    await expect(
      logAudit({ action: 'APPROVE', entity_type: 'payroll', new_data: { month: '2026-08' } })
    ).resolves.toBeUndefined();
  });

  it('never throws when there is no authenticated user at all', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    await expect(
      logAudit({ action: 'APPROVE', entity_type: 'payroll', new_data: { month: '2026-08' } })
    ).resolves.toBeUndefined();
    expect(mockAuditInsert).not.toHaveBeenCalled();
  });

  it('never throws when auth.getUser() itself rejects', async () => {
    mockGetUser.mockRejectedValue(new Error('Failed to fetch'));

    await expect(
      logAudit({ action: 'APPROVE', entity_type: 'payroll', new_data: { month: '2026-08' } })
    ).resolves.toBeUndefined();
  });
});
