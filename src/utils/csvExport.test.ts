import { describe, it, expect } from 'vitest';
import { escapeCsvCell, toCsvRow } from './csvExport';

// Minimal RFC 4180 row parser, test-only: correctly handles a quoted
// field containing commas, newlines, and doubled ("") internal quotes.
// Used below to verify toCsvRow's output round-trips back to the exact
// original values, rather than naively re-splitting on ',' (which is
// exactly the bug this whole fix is about, so the test must not repeat
// it to "verify" the fix).
function parseCsvRow(row: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < row.length) {
    if (row[i] !== '"') throw new Error(`Expected '"' at position ${i}`);
    i++; // skip opening quote
    let field = '';
    while (i < row.length) {
      if (row[i] === '"' && row[i + 1] === '"') {
        field += '"';
        i += 2;
      } else if (row[i] === '"') {
        i++; // closing quote
        break;
      } else {
        field += row[i];
        i++;
      }
    }
    fields.push(field);
    if (row[i] === ',') i++;
  }
  return fields;
}

describe('escapeCsvCell', () => {
  it('wraps a plain value in double quotes', () => {
    expect(escapeCsvCell('John')).toBe('"John"');
  });

  it('doubles internal double quotes (RFC 4180)', () => {
    expect(escapeCsvCell('Say "hi"')).toBe('"Say ""hi"""');
  });

  it('does not break on a value containing a comma -- quoting protects the delimiter', () => {
    expect(escapeCsvCell('Doe, Jane')).toBe('"Doe, Jane"');
  });

  it('handles an embedded newline (valid inside a quoted CSV field per RFC 4180)', () => {
    expect(escapeCsvCell('Line1\nLine2')).toBe('"Line1\nLine2"');
  });

  it('handles unicode names correctly', () => {
    expect(escapeCsvCell('Chikondi Mphande')).toBe('"Chikondi Mphande"');
    expect(escapeCsvCell('José García')).toBe('"José García"');
  });

  it('stringifies numbers', () => {
    expect(escapeCsvCell(12345)).toBe('"12345"');
    expect(escapeCsvCell(0)).toBe('"0"');
  });

  it('treats null/undefined as an empty cell', () => {
    expect(escapeCsvCell(null)).toBe('""');
    expect(escapeCsvCell(undefined)).toBe('""');
  });

  describe('formula-injection protection', () => {
    const triggerChars = ['=', '+', '-', '@', '\t', '\r'];

    it.each(triggerChars)('prefixes a value starting with %s with a leading single quote', (char) => {
      const malicious = `${char}cmd|'/C calc'!A1`;
      const escaped = escapeCsvCell(malicious);
      // The escaped value should contain the neutralizing leading quote
      // right after the opening CSV double-quote, so spreadsheet software
      // treats the whole thing as literal text instead of a formula.
      expect(escaped.startsWith(`"'${char}`)).toBe(true);
    });

    it('does not alter a value that merely contains (but does not start with) a trigger character', () => {
      expect(escapeCsvCell('Total = 500')).toBe('"Total = 500"');
      expect(escapeCsvCell('email@example.com')).toBe('"email@example.com"');
    });

    it('a formula-injection attempt combined with an internal quote is still fully escaped', () => {
      const malicious = '=HYPERLINK("http://evil.example","click")';
      const escaped = escapeCsvCell(malicious);
      expect(escaped).toBe('"\'=HYPERLINK(""http://evil.example"",""click"")"');
    });
  });
});

describe('toCsvRow', () => {
  it('joins escaped cells with commas', () => {
    expect(toCsvRow(['a', 'b', 'c'])).toBe('"a","b","c"');
  });

  it('correctly separates cells even when individual cells contain commas', () => {
    const row = toCsvRow(['Doe, Jane', 'Blantyre, Malawi']);
    // Splitting naively on ',' would (incorrectly) produce 4 pieces; a
    // real CSV parser respecting quotes would produce 2. This test just
    // confirms both cells are still individually present and quoted,
    // i.e. the delimiter-safety property holds.
    expect(row).toBe('"Doe, Jane","Blantyre, Malawi"');
  });

  it('handles a realistic audit-log row containing a JSON blob', () => {
    const original = ['2026-08-03', 'admin@safeguard.mw', 'UPDATE', JSON.stringify({ status: 'approved', amount: 50000, note: 'ok, proceed' })];
    const row = toCsvRow(original);
    // The JSON cell's internal commas/quotes must not add extra fields --
    // verified with a real (if minimal) CSV parser that round-trips the
    // row back to the exact original 4 values, rather than naively
    // splitting on ',' (which is exactly the bug this fix addresses, so
    // the test can't repeat it to "verify" the fix).
    expect(parseCsvRow(row)).toEqual(original);
  });

  it('handles an empty row', () => {
    expect(toCsvRow([])).toBe('');
  });
});
