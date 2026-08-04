import { describe, it, expect } from 'vitest';
import { getRegionLetter, buildEmployeeNumberPrefix, nextEmployeeNumber } from './employeeNumberGeneration';

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
