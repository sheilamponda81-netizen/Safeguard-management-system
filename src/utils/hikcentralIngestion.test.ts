import { describe, it, expect } from 'vitest';
import { computeReferenceEventFingerprint, buildRawEventInsertPayloads } from './hikcentralIngestion';
import { ParsedHikCentralRow } from './hikcentralExcelParser';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

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

  it('includes source_row_ordinal (the row\'s stable file position), which the server still requires for an anonymous row to be admitted (but, as of 2026-10-07, no longer uses as a fingerprint input -- see hikcentralIngestion.ts\'s header comment)', () => {
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
    const a = await computeReferenceEventFingerprint(TENANT_ID, row);
    const b = await computeReferenceEventFingerprint(TENANT_ID, row);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // hex-encoded SHA-256
  });

  describe('identified events (Person No. present) -- true cross-file dedup', () => {
    it('produces the same fingerprint for the same identified event re-imported from the same file', async () => {
      const row = makeRow();
      const first = await computeReferenceEventFingerprint(TENANT_ID, row);
      const second = await computeReferenceEventFingerprint(TENANT_ID, { ...row });
      expect(first).toBe(second);
    });

    it('produces the same fingerprint for the same identified event appearing in two DIFFERENT (overlapping-date-range) files -- file identity never affected the identified branch', async () => {
      const row = makeRow({ eventTimeIso: '2026-09-26T05:27:44.000Z' });
      const fpFileA = await computeReferenceEventFingerprint(TENANT_ID, row);
      const fpFileB = await computeReferenceEventFingerprint(TENANT_ID, { ...row });
      expect(fpFileA).toBe(fpFileB);
    });

    it('produces DIFFERENT fingerprints for two real scans by the same identified person 3 seconds apart', async () => {
      const first = makeRow({ eventTimeIso: '2026-09-28T04:18:32.000Z' });
      const second = makeRow({ eventTimeIso: '2026-09-28T04:18:35.000Z' });
      const fpFirst = await computeReferenceEventFingerprint(TENANT_ID, first);
      const fpSecond = await computeReferenceEventFingerprint(TENANT_ID, second);
      expect(fpFirst).not.toBe(fpSecond);
    });

    it('produces different fingerprints for different tenants observing the identical event fields', async () => {
      const row = makeRow();
      const fpTenantA = await computeReferenceEventFingerprint('11111111-1111-1111-1111-111111111111', row);
      const fpTenantB = await computeReferenceEventFingerprint('22222222-2222-2222-2222-222222222222', row);
      expect(fpTenantA).not.toBe(fpTenantB);
    });
  });

  // Regression (2026-10-07): the anonymous branch previously scoped its
  // fingerprint to the import file's own content hash + the row's
  // position within it (file_fingerprint + source_row_ordinal). Real
  // multi-terminal HikCentral testing confirmed this was a genuine bug,
  // not a theoretical one: a combined export covering an already-imported
  // date range re-exports the SAME physical anonymous events at
  // different file/row positions, which the old scheme treated as new.
  // Fixed: the anonymous branch is now scoped to the event's own
  // intrinsic fields (event_time/access_point/card_reader/
  // authentication_result/event_type), exactly like the identified
  // branch minus person_no.
  //
  // COLLISION ANALYSIS (performed against the real STAGING data before
  // choosing this design): queried all 223 real HEAD OFFICE raw events
  // (175 identified + 48 anonymous) for any two rows sharing an identical
  // (event_time, access_point, card_reader, authentication_result,
  // event_type) tuple -- zero collisions found, including among the 48
  // anonymous rows specifically, and no anonymous row carries a
  // first/last name to use as an alternative discriminator (also
  // confirmed empirically: 0 of 48 anonymous rows have either). This
  // matches the expected physical behavior of a single sequential
  // fingerprint/card reader device, which cannot process two distinct
  // authentication events at the same reader within the same
  // wall-clock second. The tuple is therefore accepted as collision-safe
  // for this access-control domain; it is an explicit, documented design
  // decision, not an invented discriminator.
  describe('anonymous events (no Person No.) -- intrinsic-field-scoped, never invented identity, now stable across files', () => {
    it('produces the SAME fingerprint for the same anonymous event moved to a different row in another export -- row position (and, by construction, file identity: the function no longer takes either as input) is no longer part of the identity. This is the fix: the same physical event re-exported in a different, overlapping combined workbook now correctly dedupes instead of being inserted again', async () => {
      const atRow10 = makeRow({ hikcentralPersonNo: null, rowNumber: 10 });
      const atRow500 = makeRow({ hikcentralPersonNo: null, rowNumber: 500 });
      const fp10 = await computeReferenceEventFingerprint(TENANT_ID, atRow10);
      const fp500 = await computeReferenceEventFingerprint(TENANT_ID, atRow500);
      expect(fp10).toBe(fp500);
    });

    it('produces the same fingerprint for the same anonymous row re-imported from the SAME file -- same-file re-upload idempotency preserved', async () => {
      const row = makeRow({ hikcentralPersonNo: null, rowNumber: 10 });
      const firstImport = await computeReferenceEventFingerprint(TENANT_ID, row);
      const secondImport = await computeReferenceEventFingerprint(TENANT_ID, { ...row });
      expect(firstImport).toBe(secondImport);
    });

    it('two genuinely distinct anonymous events (different event_time) remain distinct', async () => {
      const eventA = makeRow({ hikcentralPersonNo: null, eventTimeIso: '2026-10-01T03:18:29.000Z' });
      const eventB = makeRow({ hikcentralPersonNo: null, eventTimeIso: '2026-10-01T03:18:30.000Z' });
      const fpA = await computeReferenceEventFingerprint(TENANT_ID, eventA);
      const fpB = await computeReferenceEventFingerprint(TENANT_ID, eventB);
      expect(fpA).not.toBe(fpB);
    });

    it('two genuinely distinct anonymous events (different access_point, same second) remain distinct', async () => {
      const eventA = makeRow({ hikcentralPersonNo: null, accessPoint: 'HEADOFFICE- NAPERI_Door_1' });
      const eventB = makeRow({ hikcentralPersonNo: null, accessPoint: 'MTL - CHICHIRI_Door_1' });
      const fpA = await computeReferenceEventFingerprint(TENANT_ID, eventA);
      const fpB = await computeReferenceEventFingerprint(TENANT_ID, eventB);
      expect(fpA).not.toBe(fpB);
    });

    it('two genuinely distinct anonymous events (different card_reader, same door/second) remain distinct', async () => {
      const eventA = makeRow({ hikcentralPersonNo: null, cardReader: 'Cardreader 01' });
      const eventB = makeRow({ hikcentralPersonNo: null, cardReader: 'Cardreader 02' });
      const fpA = await computeReferenceEventFingerprint(TENANT_ID, eventA);
      const fpB = await computeReferenceEventFingerprint(TENANT_ID, eventB);
      expect(fpA).not.toBe(fpB);
    });

    it('never produces the same fingerprint as an identified event with the same visible fields (ID/ANON tag prevents cross-branch collisions)', async () => {
      const identified = makeRow({ hikcentralPersonNo: '00000174', rowNumber: 10 });
      const anonymous = makeRow({ hikcentralPersonNo: null, rowNumber: 10 });
      const fpIdentified = await computeReferenceEventFingerprint(TENANT_ID, identified);
      const fpAnonymous = await computeReferenceEventFingerprint(TENANT_ID, anonymous);
      expect(fpIdentified).not.toBe(fpAnonymous);
    });
  });
});
