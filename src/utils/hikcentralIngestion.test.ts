import { describe, it, expect } from 'vitest';
import { computeReferenceEventFingerprint, buildRawEventInsertPayloads } from './hikcentralIngestion';
import { ParsedHikCentralRow } from './hikcentralExcelParser';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const FILE_A_FINGERPRINT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FILE_B_FINGERPRINT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function makeRow(overrides: Partial<ParsedHikCentralRow> = {}): ParsedHikCentralRow {
  return {
    rowNumber: 9,
    hikcentralPersonNo: '00000174',
    firstName: 'TEST',
    lastName: 'PERSON',
    eventTimeIso: '2026-09-28T05:27:44.000Z',
    accessPoint: 'MTL - CHICHIRI_Door_1',
    cardReader: 'Cardreader 01',
    authenticationResult: 'Authorization',
    eventType: 'Access Granted by Fingerprint',
    attendanceType: 'Undefined',
    rawPayload: {},
    ...overrides,
  };
}

// SECURITY NOTE: event_fingerprint is computed by the DATABASE
// (import_hikcentral_raw_events, see the migration's PART 5 header) --
// this file's computeReferenceEventFingerprint is a REFERENCE
// implementation only, for documentation/tests. The real protection
// against a forged client fingerprint is structural: the RPC never
// reads an `event_fingerprint` field from the payload at all, and
// buildRawEventInsertPayloads never includes one -- see the "does not
// send a forgeable fingerprint" test below and the migration source-text
// tests in hikcentralAttendanceMigration.test.ts.
describe('buildRawEventInsertPayloads', () => {
  it('does not include an event_fingerprint field -- there is nothing here for a caller to forge, since the server computes it', () => {
    const payloads = buildRawEventInsertPayloads([makeRow()], 'excel');
    expect(payloads[0]).not.toHaveProperty('event_fingerprint');
  });

  it('includes source_row_ordinal (the row\'s stable file position), which the server uses for anonymous-event dedup scoping', () => {
    const payloads = buildRawEventInsertPayloads([makeRow({ rowNumber: 42 })], 'excel');
    expect(payloads[0].source_row_ordinal).toBe(42);
  });

  it('includes only eligible successful events (Authorization + Access Granted by Fingerprint), excluding Failed rows', () => {
    const rows = [
      makeRow({ authenticationResult: 'Authorization', eventType: 'Access Granted by Fingerprint' }),
      makeRow({ authenticationResult: 'Failed', eventType: 'Fingerprint Does Not Exist' }),
    ];
    const payloads = buildRawEventInsertPayloads(rows, 'excel');
    expect(payloads).toHaveLength(1);
    expect(payloads[0].authentication_result).toBe('Authorization');
  });

  // Regression (2026-10-06): a genuine HikCentral export uses the literal
  // "Authorized", not "Authorization" -- see hikcentralExcelParser.test.ts
  // for the full real-file investigation. Since this function reuses the
  // same isEligibleSuccessfulEvent the parser's summary uses, it must
  // include an "Authorized" row too, with the value passed through
  // verbatim (never rewritten to "Authorization").
  it('includes an eligible successful event using the genuine "Authorized" literal, passed through verbatim', () => {
    const rows = [
      makeRow({ authenticationResult: 'Authorized', eventType: 'Access Granted by Fingerprint' }),
      makeRow({ authenticationResult: 'Failed', eventType: 'Fingerprint Does Not Exist' }),
    ];
    const payloads = buildRawEventInsertPayloads(rows, 'excel');
    expect(payloads).toHaveLength(1);
    expect(payloads[0].authentication_result).toBe('Authorized');
  });

  it('tags every payload with the given source', () => {
    const payloads = buildRawEventInsertPayloads([makeRow()], 'excel');
    expect(payloads[0].source).toBe('excel');
  });

  it('never includes a mapped_employee_id or processing_status field (raw events are immutable facts, resolved by mapping JOIN, never frozen -- approved decisions 4 and 5)', () => {
    const payloads = buildRawEventInsertPayloads([makeRow()], 'excel');
    expect(payloads[0]).not.toHaveProperty('mapped_employee_id');
    expect(payloads[0]).not.toHaveProperty('processing_status');
  });
});

describe('computeReferenceEventFingerprint (reference implementation, mirrors the SQL the server actually runs)', () => {
  it('is deterministic -- the same inputs always produce the same fingerprint', async () => {
    const row = makeRow();
    const a = await computeReferenceEventFingerprint(TENANT_ID, row, FILE_A_FINGERPRINT);
    const b = await computeReferenceEventFingerprint(TENANT_ID, row, FILE_A_FINGERPRINT);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // hex-encoded SHA-256
  });

  describe('identified events (Person No. present) -- true cross-file dedup', () => {
    it('produces the same fingerprint for the same identified event re-imported from the same file', async () => {
      const row = makeRow();
      const first = await computeReferenceEventFingerprint(TENANT_ID, row, FILE_A_FINGERPRINT);
      const second = await computeReferenceEventFingerprint(TENANT_ID, { ...row }, FILE_A_FINGERPRINT);
      expect(first).toBe(second);
    });

    it('produces the same fingerprint for the same identified event appearing in two DIFFERENT (overlapping-date-range) files -- file identity does not affect the identified branch', async () => {
      const row = makeRow({ eventTimeIso: '2026-09-26T05:27:44.000Z' });
      const fpFileA = await computeReferenceEventFingerprint(TENANT_ID, row, FILE_A_FINGERPRINT);
      const fpFileB = await computeReferenceEventFingerprint(TENANT_ID, row, FILE_B_FINGERPRINT);
      expect(fpFileA).toBe(fpFileB);
    });

    it('produces DIFFERENT fingerprints for two real scans by the same identified person 3 seconds apart', async () => {
      const first = makeRow({ eventTimeIso: '2026-09-28T04:18:32.000Z' });
      const second = makeRow({ eventTimeIso: '2026-09-28T04:18:35.000Z' });
      const fpFirst = await computeReferenceEventFingerprint(TENANT_ID, first, FILE_A_FINGERPRINT);
      const fpSecond = await computeReferenceEventFingerprint(TENANT_ID, second, FILE_A_FINGERPRINT);
      expect(fpFirst).not.toBe(fpSecond);
    });

    it('produces different fingerprints for different tenants observing the identical event fields', async () => {
      const row = makeRow();
      const fpTenantA = await computeReferenceEventFingerprint('11111111-1111-1111-1111-111111111111', row, FILE_A_FINGERPRINT);
      const fpTenantB = await computeReferenceEventFingerprint('22222222-2222-2222-2222-222222222222', row, FILE_A_FINGERPRINT);
      expect(fpTenantA).not.toBe(fpTenantB);
    });
  });

  describe('anonymous events (no Person No.) -- file-scoped, never invented identity', () => {
    it('does NOT collapse two DIFFERENT anonymous people who share identical visible fields (same second/door/reader/result/type) in the same file -- they have different row positions', async () => {
      const personX = makeRow({ hikcentralPersonNo: null, rowNumber: 10 });
      const personY = makeRow({ hikcentralPersonNo: null, rowNumber: 11 }); // a different real person, same visible fields
      const fpX = await computeReferenceEventFingerprint(TENANT_ID, personX, FILE_A_FINGERPRINT);
      const fpY = await computeReferenceEventFingerprint(TENANT_ID, personY, FILE_A_FINGERPRINT);
      expect(fpX).not.toBe(fpY);
    });

    it('produces the same fingerprint for the same anonymous row re-imported from the SAME file (same file_fingerprint + same row position) -- same-file re-upload idempotency', async () => {
      const row = makeRow({ hikcentralPersonNo: null, rowNumber: 10 });
      const firstImport = await computeReferenceEventFingerprint(TENANT_ID, row, FILE_A_FINGERPRINT);
      const secondImport = await computeReferenceEventFingerprint(TENANT_ID, { ...row }, FILE_A_FINGERPRINT);
      expect(firstImport).toBe(secondImport);
    });

    it('produces a DIFFERENT fingerprint for the same anonymous row position when it comes from a DIFFERENT file -- documents the acknowledged limit: cross-file anonymous dedup is not attempted', async () => {
      const row = makeRow({ hikcentralPersonNo: null, rowNumber: 10 });
      const fpFileA = await computeReferenceEventFingerprint(TENANT_ID, row, FILE_A_FINGERPRINT);
      const fpFileB = await computeReferenceEventFingerprint(TENANT_ID, row, FILE_B_FINGERPRINT);
      expect(fpFileA).not.toBe(fpFileB);
    });

    it('never produces the same fingerprint as an identified event with the same visible fields (ID/ANON tag prevents cross-branch collisions)', async () => {
      const identified = makeRow({ hikcentralPersonNo: '00000174', rowNumber: 10 });
      const anonymous = makeRow({ hikcentralPersonNo: null, rowNumber: 10 });
      const fpIdentified = await computeReferenceEventFingerprint(TENANT_ID, identified, FILE_A_FINGERPRINT);
      const fpAnonymous = await computeReferenceEventFingerprint(TENANT_ID, anonymous, FILE_A_FINGERPRINT);
      expect(fpIdentified).not.toBe(fpAnonymous);
    });
  });
});
