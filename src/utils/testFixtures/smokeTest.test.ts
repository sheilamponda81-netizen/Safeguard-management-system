import { describe, it, expect } from 'vitest';
import { readSheet } from 'read-excel-file/node';
import { buildTestXlsx } from './buildTestXlsx';

// One-off verification that the hand-built OOXML fixture actually round-trips
// through the real read-excel-file library exactly as assumed -- in
// particular that a digit-only string cell like "00000174" comes back as
// the STRING "00000174", not the number 174. If this ever regresses (e.g.
// a read-excel-file upgrade changes cell-type inference), this test fails
// loudly instead of the real parser tests failing confusingly.
describe('buildTestXlsx smoke test', () => {
  it('round-trips a leading-zero digit string as text, not a number', async () => {
    const buffer = await buildTestXlsx([
      ['Person No.', 'Name'],
      ['00000174', 'Test Person'],
    ]);
    const rows = await readSheet(buffer, 1);
    expect(rows[1][0]).toBe('00000174');
    expect(typeof rows[1][0]).toBe('string');
  });

  it('round-trips a numeric cell as a number', async () => {
    const buffer = await buildTestXlsx([
      ['Count'],
      [42],
    ]);
    const rows = await readSheet(buffer, 1);
    expect(rows[1][0]).toBe(42);
    expect(typeof rows[1][0]).toBe('number');
  });

  it('preserves row/column position with blank leading cells', async () => {
    const buffer = await buildTestXlsx([
      ['A1', null, 'C1'],
    ]);
    const rows = await readSheet(buffer, 1);
    expect(rows[0][0]).toBe('A1');
    expect(rows[0][2]).toBe('C1');
  });
});
