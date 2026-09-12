import { describe, it, expect } from 'vitest';
import { formatAuditTimestamp, formatAuditValue } from './terminalDuesAudit';

describe('formatAuditTimestamp', () => {
  it('a NULL timestamp (pre-existing row, before the audit trail existed) reads as an honest explanation, not a blank', () => {
    expect(formatAuditTimestamp(null)).toBe('Recorded before payment audit trail');
  });

  it('a real timestamp is rendered as a locale date/time string, not echoed raw', () => {
    const iso = '2026-09-04T09:14:00.000Z';
    expect(formatAuditTimestamp(iso)).toBe(new Date(iso).toLocaleString());
  });
});

describe('formatAuditValue', () => {
  it('a NULL value (pre-existing row) reads as a plain dash, never fabricated text', () => {
    expect(formatAuditValue(null)).toBe('—');
  });

  it('an empty string is also treated as missing', () => {
    expect(formatAuditValue('')).toBe('—');
  });

  it('a real value is passed through verbatim', () => {
    expect(formatAuditValue('Bank Transfer')).toBe('Bank Transfer');
  });
});
