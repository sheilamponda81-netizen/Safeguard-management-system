import { describe, it, expect } from 'vitest';
import { generateGuardId } from './guardIdGeneration';

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
