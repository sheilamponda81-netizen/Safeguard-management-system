import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();
const fromResultMock = vi.fn();
vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: () => ({
      select: () => ({
        ilike: () => ({
          order: () => ({
            limit: (...args: unknown[]) => fromResultMock(...args),
          }),
        }),
      }),
    }),
  },
}));

const { getRegionLetter, buildEmployeeNumberPrefix, nextEmployeeNumber, generateEmployeeNumberServerSide, shouldGenerateEmployeeNumber } =
  await import('./employeeNumberGeneration');

describe('getRegionLetter', () => {
  it('uses the region code when one is set', () => {
    expect(getRegionLetter({ code: 'n', name: 'Northern Region' })).toBe('N');
  });

  it('falls back to the first letter of the region name when no code is set', () => {
    expect(getRegionLetter({ code: null, name: 'Northern Region' })).toBe('N');
    expect(getRegionLetter({ code: '', name: 'southern region' })).toBe('S');
  });

  it('falls back to "X" when neither code nor name is usable', () => {
    expect(getRegionLetter({ code: null, name: null })).toBe('X');
    expect(getRegionLetter({ code: '  ', name: '  ' })).toBe('X');
  });
});

describe('buildEmployeeNumberPrefix', () => {
  it('builds "SFG-<letter>-"', () => {
    expect(buildEmployeeNumberPrefix({ code: 'N', name: 'Northern' })).toBe('SFG-N-');
  });
});

describe('nextEmployeeNumber', () => {
  it('starts at 001 when nothing exists yet', () => {
    expect(nextEmployeeNumber('SFG-N-', null)).toBe('SFG-N-001');
    expect(nextEmployeeNumber('SFG-N-', undefined)).toBe('SFG-N-001');
  });

  it('increments the trailing digits of the highest existing number', () => {
    expect(nextEmployeeNumber('SFG-N-', 'SFG-N-007')).toBe('SFG-N-008');
  });

  it('does not zero-pad beyond 3 digits once numbers exceed 999', () => {
    expect(nextEmployeeNumber('SFG-N-', 'SFG-N-999')).toBe('SFG-N-1000');
  });

  it('starts at 001 if the existing value has no trailing digits to increment', () => {
    expect(nextEmployeeNumber('SFG-N-', 'SFG-N-')).toBe('SFG-N-001');
  });
});

describe('generateEmployeeNumberServerSide', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromResultMock.mockReset();
  });

  const region = { code: 'N', name: 'Northern' };

  it('calls generate_employee_number with the region id and returns its value verbatim', async () => {
    rpcMock.mockResolvedValueOnce({ data: 'SFG-N-004', error: null });
    const result = await generateEmployeeNumberServerSide('region-1', region);
    expect(result).toBe('SFG-N-004');
    expect(rpcMock).toHaveBeenCalledWith('generate_employee_number', { p_region_id: 'region-1' });
    expect(fromResultMock).not.toHaveBeenCalled();
  });

  it('falls back to the browser-side highest-existing-number query when the RPC errors', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'function generate_employee_number(uuid) does not exist' } });
    fromResultMock.mockResolvedValueOnce({ data: [{ employee_number: 'SFG-N-007' }] });
    const result = await generateEmployeeNumberServerSide('region-1', region);
    expect(result).toBe('SFG-N-008');
  });

  it('falls back to "001" when the RPC errors and no employees exist yet for the prefix', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    fromResultMock.mockResolvedValueOnce({ data: [] });
    const result = await generateEmployeeNumberServerSide('region-1', region);
    expect(result).toBe('SFG-N-001');
  });

  it('falls back when the RPC throws (network failure) rather than returning an {error}', async () => {
    rpcMock.mockRejectedValueOnce(new Error('network error'));
    fromResultMock.mockResolvedValueOnce({ data: [{ employee_number: 'SFG-N-002' }] });
    const result = await generateEmployeeNumberServerSide('region-1', region);
    expect(result).toBe('SFG-N-003');
  });

  it('two concurrent calls each get whatever distinct value the database RPC returns', async () => {
    rpcMock
      .mockResolvedValueOnce({ data: 'SFG-N-010', error: null })
      .mockResolvedValueOnce({ data: 'SFG-N-011', error: null });
    const [first, second] = await Promise.all([
      generateEmployeeNumberServerSide('region-1', region),
      generateEmployeeNumberServerSide('region-1', region),
    ]);
    expect(first).not.toBe(second);
    expect([first, second].sort()).toEqual(['SFG-N-010', 'SFG-N-011']);
  });
});

// Regression coverage for the real staging bug: a Human Resource Manager's
// region is PRE-ASSIGNED into the Add Employee form's initial state (not
// picked from the region <select>, which only a super admin ever sees --
// see Employees.tsx's AddEmployeeForm), so the OLD implementation (which
// only ever called generateEmployeeNumberServerSide from inside that
// <select>'s onChange) never fired for HR at all: Employee Number stayed
// permanently blank and the required-field validator refused to let HR
// submit the form. shouldGenerateEmployeeNumber is the extracted decision
// AddEmployeeForm's region-driven useEffect now calls instead.
describe('shouldGenerateEmployeeNumber', () => {
  it('HR Manager scenario: a region pre-assigned before any generation has happened (lastGeneratedForRegionId=null) should generate', () => {
    expect(shouldGenerateEmployeeNumber('southern-region-id', null)).toBe(true);
  });

  it('HR Manager never manually selects/changes region -- this alone, with no onChange event at all, is what the auto-generation effect relies on', () => {
    // No onChange required: the form's initial region_id is already the
    // pre-assigned one, and that alone is enough for this function to say
    // "generate" -- exactly what lets the useEffect trigger on mount.
    const regionId = 'southern-region-id';
    expect(shouldGenerateEmployeeNumber(regionId, null)).toBe(true);
  });

  it('Admin selects a region for the first time (lastGeneratedForRegionId=null): should generate', () => {
    expect(shouldGenerateEmployeeNumber('any-region-id', null)).toBe(true);
  });

  it('Admin changes to a DIFFERENT region before submission: should generate again for the new region', () => {
    expect(shouldGenerateEmployeeNumber('region-B', 'region-A')).toBe(true);
  });

  it('no region resolved yet (null/undefined/empty): never generates', () => {
    expect(shouldGenerateEmployeeNumber(null, null)).toBe(false);
    expect(shouldGenerateEmployeeNumber(undefined, null)).toBe(false);
    expect(shouldGenerateEmployeeNumber('', null)).toBe(false);
  });

  it('normal re-render with the SAME region already generated for: does not regenerate (no duplicate generation, no wasted counter increments)', () => {
    expect(shouldGenerateEmployeeNumber('southern-region-id', 'southern-region-id')).toBe(false);
  });

  it('an unrelated field changing does not affect this decision at all -- it is purely a function of region_id vs lastGeneratedForRegionId', () => {
    // Simulates re-evaluating the same two arguments repeatedly, as a
    // useEffect with `[form.region_id]` as its only dependency would do
    // across renders triggered by unrelated form field edits.
    const regionId = 'southern-region-id';
    for (let i = 0; i < 5; i++) {
      expect(shouldGenerateEmployeeNumber(regionId, regionId)).toBe(false);
    }
  });
});
