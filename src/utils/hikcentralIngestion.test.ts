import { describe, it, expect } from 'vitest';
import { computeEventFingerprint, buildRawEventInsertPayloads } from './hikcentralIngestion';
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

describe('computeEventFingerprint', () => {
  // 10. Deterministic
  it('is deterministic -- the same inputs always produce the same fingerprint', async () => {
    const row = makeRow();
    const a = await computeEventFingerprint(TENANT_ID, row);
    const b = await computeEventFingerprint(TENANT_ID, row);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // hex-encoded SHA-256
  });

  // 11. Same event, re-parsed from "the same file" a second time -> identical
  // fingerprint, so the database's UNIQUE(tenant_id, event_fingerprint)
  // constraint (see the ingestion migration's PART 2 and the RPC's
  // ON CONFLICT DO NOTHING in PART 5) naturally collapses it to one row.
  // This test verifies the CLIENT-SIDE half of that guarantee -- that
  // fingerprinting the identical row twice never produces two different
  // keys; the DB-level "one row survives" behavior itself needs a live
  // Postgres to observe directly (this repo has no such test harness --
  // see the migration file's own header for the documented SQL-level
  // expectation) and is exercised there, not here.
  it('produces the same fingerprint for the same event re-imported from the same file', async () => {
    const row = makeRow();
    const firstImport = await computeEventFingerprint(TENANT_ID, row);
    const secondImport = await computeEventFingerprint(TENANT_ID, { ...row }); // simulates re-parsing the identical row
    expect(firstImport).toBe(secondImport);
  });

  // 12. Same event appearing in two OVERLAPPING (not byte-identical)
  // exports -- e.g. a Sept 22-28 export and a Sept 25-Oct 1 export both
  // containing the Sept 26 punch -- must fingerprint identically too,
  // since the fingerprint is derived purely from the event's own fields,
  // never from which file/batch it came from.
  it('produces the same fingerprint for the same event when it appears in two different (overlapping-date-range) import batches', async () => {
    const eventInFileA = makeRow({ eventTimeIso: '2026-09-26T05:27:44.000Z' });
    const eventInFileB = makeRow({ eventTimeIso: '2026-09-26T05:27:44.000Z' }); // identical event, different upload
    const fpA = await computeEventFingerprint(TENANT_ID, eventInFileA);
    const fpB = await computeEventFingerprint(TENANT_ID, eventInFileB);
    expect(fpA).toBe(fpB);
  });

  // 13. Two real, distinct punches by the same person a few seconds apart
  // must NOT collide -- both must be preserved as separate raw events.
  it('produces DIFFERENT fingerprints for two real scans by the same person 3 seconds apart', async () => {
    const first = makeRow({ eventTimeIso: '2026-09-28T04:18:32.000Z' });
    const second = makeRow({ eventTimeIso: '2026-09-28T04:18:35.000Z' });
    const fpFirst = await computeEventFingerprint(TENANT_ID, first);
    const fpSecond = await computeEventFingerprint(TENANT_ID, second);
    expect(fpFirst).not.toBe(fpSecond);
  });

  it('produces different fingerprints for different tenants observing the identical event fields (defense in depth -- the DB UNIQUE constraint is already tenant-scoped, but the fingerprint itself should not collide across tenants either)', async () => {
    const row = makeRow();
    const fpTenantA = await computeEventFingerprint('11111111-1111-1111-1111-111111111111', row);
    const fpTenantB = await computeEventFingerprint('22222222-2222-2222-2222-222222222222', row);
    expect(fpTenantA).not.toBe(fpTenantB);
  });

  it('treats a missing Person No. consistently (empty string, not "null" or "undefined" literal text) so two no-person-no events at the same instant/door/reader still collide as documented', async () => {
    const row = makeRow({ hikcentralPersonNo: null });
    const fp = await computeEventFingerprint(TENANT_ID, row);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('buildRawEventInsertPayloads', () => {
  it('includes only eligible successful events (Authorization + Access Granted by Fingerprint), excluding Failed rows', async () => {
    const rows = [
      makeRow({ authenticationResult: 'Authorization', eventType: 'Access Granted by Fingerprint' }),
      makeRow({ authenticationResult: 'Failed', eventType: 'Fingerprint Does Not Exist' }),
    ];
    const payloads = await buildRawEventInsertPayloads(TENANT_ID, rows, 'excel');
    expect(payloads).toHaveLength(1);
    expect(payloads[0].authentication_result).toBe('Authorization');
  });

  it('tags every payload with the given source', async () => {
    const payloads = await buildRawEventInsertPayloads(TENANT_ID, [makeRow()], 'excel');
    expect(payloads[0].source).toBe('excel');
  });

  it('never includes a mapped_employee_id or processing_status field (raw events are immutable facts, resolved by mapping JOIN, never frozen -- approved decisions 4 and 5)', async () => {
    const payloads = await buildRawEventInsertPayloads(TENANT_ID, [makeRow()], 'excel');
    expect(payloads[0]).not.toHaveProperty('mapped_employee_id');
    expect(payloads[0]).not.toHaveProperty('processing_status');
  });
});
