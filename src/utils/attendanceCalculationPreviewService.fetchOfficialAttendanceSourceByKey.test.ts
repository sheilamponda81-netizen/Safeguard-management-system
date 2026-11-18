import { describe, it, expect, vi, beforeEach } from 'vitest';

const fromMock = vi.fn();

vi.mock('../lib/supabase', () => ({
  supabase: { from: (...args: unknown[]) => fromMock(...args) },
}));

const { fetchOfficialAttendanceSourceByKey } = await import('./attendanceCalculationPreviewService');

interface ChainableMock {
  select: (...args: unknown[]) => ChainableMock;
  gte: (...args: unknown[]) => ChainableMock;
  lte: (...args: unknown[]) => ChainableMock;
  in: (...args: unknown[]) => ChainableMock;
  range: (...args: unknown[]) => Promise<{ data: unknown; error: unknown; count?: number | null }>;
}

function mockSinglePageFrom(data: unknown) {
  return () => {
    const builder: ChainableMock = {
      select: () => builder,
      gte: () => builder,
      lte: () => builder,
      in: () => builder,
      range: () => Promise.resolve({ data, error: null, count: Array.isArray(data) ? data.length : 0 }),
    };
    return builder;
  };
}

describe('fetchOfficialAttendanceSourceByKey', () => {
  beforeEach(() => fromMock.mockReset());

  it('maps employee_id|date to the row\'s source column, including a genuinely NULL source (a pre-existing row with none recorded)', async () => {
    fromMock.mockImplementation(mockSinglePageFrom([
      { employee_id: 'e1', date: '2026-11-05', source: 'automatic' },
      { employee_id: 'e2', date: '2026-11-05', source: 'manual' },
      { employee_id: 'e3', date: '2026-11-05', source: null },
    ]));
    const result = await fetchOfficialAttendanceSourceByKey(['e1', 'e2', 'e3'], '2026-11-01', '2026-11-30');
    expect(result.get('e1|2026-11-05')).toBe('automatic');
    expect(result.get('e2|2026-11-05')).toBe('manual');
    expect(result.get('e3|2026-11-05')).toBeNull();
    expect(result.get('e4|2026-11-05')).toBeUndefined();
  });

  it('returns an empty map for an empty employee id list, never erroring', async () => {
    fromMock.mockImplementation(mockSinglePageFrom([]));
    const result = await fetchOfficialAttendanceSourceByKey([], '2026-11-01', '2026-11-30');
    expect(result.size).toBe(0);
  });
});
