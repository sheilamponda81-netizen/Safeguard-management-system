import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpcMock = vi.fn();
vi.mock('../lib/supabase', () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

const { generateGuardId, generateGuardIdServerSide } = await import('./guardIdGeneration');

describe('generateGuardId', () => {
  it('matches the "G-" + 4-digit pattern', () => {
    const id = generateGuardId();
    expect(id).toMatch(/^G-\d{4}$/);
  });

  it('generates a number within the documented 1000-9999 range', () => {
    for (let i = 0; i < 200; i++) {
      const num = Number(generateGuardId().slice(2));
      expect(num).toBeGreaterThanOrEqual(1000);
      expect(num).toBeLessThanOrEqual(9999);
    }
  });

  it('has no memoization or dedup state -- two calls can return the same value', () => {
    // Not a "collision prevention" test -- there is no prevention, and
    // this deliberately does NOT assert that a collision happens (that
    // would make the test flaky) or that one can't (that would be
    // asserting a guarantee this function doesn't provide). It documents,
    // mechanically, that repeated calls are independent draws from the
    // same 1000-9999 range with no cross-call state -- i.e. nothing here
    // silently prevents the collision risk described in AUDIT_REPORT.md.
    // Mocking Math.random to return the same value twice proves the
    // function itself applies no de-duplication.
    const originalRandom = Math.random;
    Math.random = () => 0.5;
    try {
      expect(generateGuardId()).toBe(generateGuardId());
    } finally {
      Math.random = originalRandom;
    }
  });
});

describe('generateGuardIdServerSide', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('calls the generate_guard_id RPC and returns its value verbatim', async () => {
    rpcMock.mockResolvedValueOnce({ data: 'G-0042', error: null });
    const id = await generateGuardIdServerSide();
    expect(id).toBe('G-0042');
    expect(rpcMock).toHaveBeenCalledWith('generate_guard_id');
  });

  it('falls back to the client-side generator when the RPC returns an error', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'function generate_guard_id() does not exist' } });
    const id = await generateGuardIdServerSide();
    // Falls back to generateGuardId()'s own format/range, not the RPC shape.
    expect(id).toMatch(/^G-\d{4}$/);
  });

  it('falls back to the client-side generator when the RPC throws (network failure)', async () => {
    rpcMock.mockRejectedValueOnce(new Error('network error'));
    const id = await generateGuardIdServerSide();
    expect(id).toMatch(/^G-\d{4}$/);
  });

  it('falls back to the client-side generator when the RPC resolves with no data', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: null });
    const id = await generateGuardIdServerSide();
    expect(id).toMatch(/^G-\d{4}$/);
  });

  it('two concurrent calls each get whatever distinct value the database RPC returns -- proves the wrapper does not memoize or coalesce concurrent requests', async () => {
    rpcMock
      .mockResolvedValueOnce({ data: 'G-0010', error: null })
      .mockResolvedValueOnce({ data: 'G-0011', error: null });
    const [first, second] = await Promise.all([generateGuardIdServerSide(), generateGuardIdServerSide()]);
    expect(first).not.toBe(second);
    expect([first, second].sort()).toEqual(['G-0010', 'G-0011']);
  });
});
