import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Stage C Step 8: this repo has no component-test harness (see this
// directory's other *.test.ts files' own header precedent, e.g.
// Roster.recurringSchedule.test.ts) -- these tests pin, at the SOURCE
// level, that a HikCentral import automatically triggers attendance
// calculation and write-through in the SAME action as the existing
// "Import Raw Events" button, with no second button/confirmation step
// for the normal import flow.
const source = fs.readFileSync(path.resolve(__dirname, './HikCentralImport.tsx'), 'utf-8');

describe('HikCentralImport: importing automatically calculates and applies attendance, no second button', () => {
  it('imports processHikCentralImportBatch from the new auto-apply service', () => {
    expect(source).toMatch(/import \{\s*\n?\s*fetchDistinctWorkstations, processHikCentralImportBatch, isoToBlantyreDateStr,/);
  });

  it('handleImport calls processHikCentralImportBatch immediately after a successful raw-event import, inside the same handler', () => {
    const handlerMatch = source.match(/const handleImport = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/);
    expect(handlerMatch, 'expected to find handleImport in HikCentralImport.tsx').toBeTruthy();
    const body = handlerMatch![0];
    expect(body).toMatch(/importHikCentralRawEvents\(/);
    expect(body).toMatch(/processHikCentralImportBatch\(\{/);
    // The auto-apply call must be reachable from the SAME function as the
    // raw import -- there is no separate onClick/button wiring it up.
    expect(body.indexOf('importHikCentralRawEvents(')).toBeLessThan(body.indexOf('processHikCentralImportBatch({'));
  });

  it('does not call processHikCentralImportBatch from any handler other than handleImport/handleRetryAutoApply (no hidden second trigger)', () => {
    const callSites = (source.match(/processHikCentralImportBatch\(\{/g) || []).length;
    // Exactly two: the automatic call inside handleImport, and the explicit retry-only call inside handleRetryAutoApply.
    expect(callSites).toBe(2);
  });

  it('there is only ONE primary action button driving the whole import -- the Import Raw Events button -- never a separate "Apply" confirmation button for the normal flow', () => {
    expect(source).not.toMatch(/>\s*Apply\b/);
    expect(source).toMatch(/Import Raw Events/);
  });

  it('the Import button is gated on a declared processing scope (period + at least one workstation) as well as the existing summary checks', () => {
    const btnMatch = source.match(/<Button onClick=\{handleImport\} disabled=\{[^}]*\}>/);
    expect(btnMatch, 'expected to find the Import Raw Events button').toBeTruthy();
    expect(btnMatch![0]).toMatch(/!canProcessScope/);
  });

  it('canProcessScope requires at least one selected workstation and a valid (start <= end) period', () => {
    const def = source.match(/const canProcessScope =[^;]*;/)?.[0] ?? '';
    expect(def).toMatch(/selectedWorkstations\.length > 0/);
    expect(def).toMatch(/periodFrom <= periodTo/);
  });

  it('shows a distinct failure state when raw import succeeds but automatic processing fails -- never folded into one blanket success banner', () => {
    expect(source).toMatch(/Automatic attendance processing failed/);
    expect(source).toMatch(/Raw events were imported successfully, but attendance was NOT calculated or applied/);
  });

  it('offers a retry path for automatic processing alone (reprocessing), without re-importing raw events', () => {
    expect(source).toMatch(/const handleRetryAutoApply = useCallback/);
    expect(source).toMatch(/Retry Attendance Processing/);
  });

  it('the success summary surfaces applied/unchanged/skipped counts (the import summary this task requires)', () => {
    const summaryBlock = source.slice(source.indexOf('Attendance calculated and applied automatically'));
    expect(summaryBlock.slice(0, 800)).toMatch(/label="Applied"/);
    expect(summaryBlock.slice(0, 800)).toMatch(/label="Unchanged"/);
    expect(summaryBlock.slice(0, 800)).toMatch(/label="Skipped"/);
  });
});
