import { describe, it, expect } from 'vitest';
import { classifyRawEventsForEvidence, deriveEvidenceCompleteness, EVIDENCE_COMPLETENESS_LABELS } from './attendanceEvidence';
import { getShiftWindows } from './attendanceCalculationEngine';

function ev(timestampIso: string, accessPoint: string | null = 'Gate 1') {
  return { timestampIso, accessPoint };
}

describe('deriveEvidenceCompleteness', () => {
  it('both_found when both a check-in and a checkout were matched', () => {
    expect(deriveEvidenceCompleteness('2026-10-05T04:05:00.000Z', '2026-10-05T14:30:00.000Z')).toBe('both_found');
  });
  it('check_in_only when only a check-in was matched', () => {
    expect(deriveEvidenceCompleteness('2026-10-05T04:05:00.000Z', null)).toBe('check_in_only');
  });
  it('check_out_only when only a checkout was matched', () => {
    expect(deriveEvidenceCompleteness(null, '2026-10-05T14:30:00.000Z')).toBe('check_out_only');
  });
  it('none_found when neither was matched', () => {
    expect(deriveEvidenceCompleteness(null, null)).toBe('none_found');
  });
  it('every EvidenceCompleteness value has a label', () => {
    for (const key of ['both_found', 'check_in_only', 'check_out_only', 'none_found'] as const) {
      expect(EVIDENCE_COMPLETENESS_LABELS[key]).toBeTruthy();
    }
  });
});

describe('classifyRawEventsForEvidence', () => {
  const windows = getShiftWindows('day', '2026-10-05');
  // Day shift 2026-10-05: check-in window 04:00-08:00 Blantyre (02:00-06:00Z),
  // checkout window 16:00-20:00 Blantyre (14:00-18:00Z).

  it('labels the engine-matched check-in and checkout, in chronological order regardless of input order', () => {
    const events = [ev('2026-10-05T14:30:00.000Z'), ev('2026-10-05T04:05:00.000Z')]; // checkout first, check-in second
    const result = classifyRawEventsForEvidence(events, windows, '2026-10-05T04:05:00.000Z', '2026-10-05T14:30:00.000Z');
    expect(result.map((r) => r.role)).toEqual(['matched_check_in', 'matched_check_out']);
    expect(result[0].timestampIso).toBe('2026-10-05T04:05:00.000Z');
    expect(result[1].timestampIso).toBe('2026-10-05T14:30:00.000Z');
  });

  it('a later duplicate scan inside the check-in window, not chosen by the engine, is excluded with a specific "another scan was used" reason', () => {
    const events = [ev('2026-10-05T04:05:00.000Z'), ev('2026-10-05T05:30:00.000Z')];
    const result = classifyRawEventsForEvidence(events, windows, '2026-10-05T04:05:00.000Z', null);
    const excluded = result.find((r) => r.timestampIso === '2026-10-05T05:30:00.000Z');
    expect(excluded?.role).toBe('excluded');
    expect(excluded?.excludedReason).toMatch(/different \(earlier\) scan.*check-in/);
  });

  it('a later duplicate scan inside the checkout window is excluded with the symmetric checkout reason', () => {
    const events = [ev('2026-10-05T14:30:00.000Z'), ev('2026-10-05T15:45:00.000Z')];
    const result = classifyRawEventsForEvidence(events, windows, null, '2026-10-05T14:30:00.000Z');
    const excluded = result.find((r) => r.timestampIso === '2026-10-05T15:45:00.000Z');
    expect(excluded?.excludedReason).toMatch(/different \(earlier\) scan.*checkout/);
  });

  it('a scan before the check-in window opens is excluded as too early', () => {
    const events = [ev('2026-10-05T01:00:00.000Z')]; // 03:00 Blantyre, before 04:00
    const result = classifyRawEventsForEvidence(events, windows, null, null);
    expect(result[0].role).toBe('excluded');
    expect(result[0].excludedReason).toMatch(/Before the check-in window opens/);
  });

  it('a scan between the check-in and checkout windows is excluded as between windows', () => {
    const events = [ev('2026-10-05T10:00:00.000Z')]; // midday, between 06:00Z and 14:00Z
    const result = classifyRawEventsForEvidence(events, windows, null, null);
    expect(result[0].excludedReason).toMatch(/Between the check-in and checkout windows/);
  });

  it('a scan after the checkout window closes is excluded as too late', () => {
    const events = [ev('2026-10-05T20:00:00.000Z')]; // 22:00 Blantyre, after 20:00
    const result = classifyRawEventsForEvidence(events, windows, null, null);
    expect(result[0].excludedReason).toMatch(/After the checkout window closes/);
  });

  it('preserves accessPoint on every classified event, matched or excluded', () => {
    const events = [ev('2026-10-05T04:05:00.000Z', 'Head Office Gate'), ev('2026-10-05T20:00:00.000Z', 'Chichiri Gate')];
    const result = classifyRawEventsForEvidence(events, windows, '2026-10-05T04:05:00.000Z', null);
    expect(result.find((r) => r.role === 'matched_check_in')?.accessPoint).toBe('Head Office Gate');
    expect(result.find((r) => r.role === 'excluded')?.accessPoint).toBe('Chichiri Gate');
  });

  it('an empty event list produces an empty classification, never throwing', () => {
    expect(classifyRawEventsForEvidence([], windows, null, null)).toEqual([]);
  });
});
