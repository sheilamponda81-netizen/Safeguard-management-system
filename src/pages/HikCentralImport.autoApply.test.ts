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
    expect(source).toMatch(/import \{\s*\n?\s*processHikCentralImportBatch, isoToBlantyreDateStr,/);
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

  it('Stage C Step 8B/11: all processHikCentralImportBatch call sites pass the file\'s own detected access points as the required scope, not employees.workstation', () => {
    const calls = source.match(/processHikCentralImportBatch\(\{[\s\S]*?\}\);/g) || [];
    // Three: handleImport's automatic call, handleRetryAutoApply's
    // explicit retry-only call, and Phase 3's handleConfirmOverride call.
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call).toMatch(/accessPoints: summary\.accessPoints/);
    }
  });

  it('does not call processHikCentralImportBatch from any handler other than handleImport/handleRetryAutoApply/handleConfirmOverride (no hidden extra trigger)', () => {
    const callSites = (source.match(/processHikCentralImportBatch\(\{/g) || []).length;
    // Exactly three: the automatic call inside handleImport, the
    // explicit retry-only call inside handleRetryAutoApply, and Phase 3's
    // explicit, user-gated override-confirmation call inside
    // handleConfirmOverride (typing a reason and clicking a dedicated
    // button -- never triggered implicitly).
    expect(callSites).toBe(3);
  });

  it('there is only ONE primary action button driving the whole import -- the Import Raw Events button -- never a separate "Apply" confirmation button for the normal flow', () => {
    expect(source).not.toMatch(/>\s*Apply\b/);
    expect(source).toMatch(/Import Raw Events/);
  });

  it('the Import button is gated on a declared processing scope (detected access points + period) as well as the existing summary checks', () => {
    const btnMatch = source.match(/<Button onClick=\{handleImport\} disabled=\{[^}]*\}>/);
    expect(btnMatch, 'expected to find the Import Raw Events button').toBeTruthy();
    expect(btnMatch![0]).toMatch(/!canProcessScope/);
  });

  it('Stage C Step 11: canProcessScope requires at least one DETECTED access point (not a chosen workstation) and a valid (start <= end) period', () => {
    const def = source.match(/const canProcessScope =[^;]*;/)?.[0] ?? '';
    expect(def).toMatch(/summary\.accessPoints\.length > 0/);
    expect(def).toMatch(/periodFrom <= periodTo/);
    expect(def).not.toMatch(/selectedWorkstations/);
  });

  it('Stage C Step 11: there is no workstation checkbox selection anywhere in this page', () => {
    expect(source).not.toMatch(/selectedWorkstations/);
    expect(source).not.toMatch(/toggleWorkstation/);
    expect(source).not.toMatch(/workstationOptions/);
    expect(source).not.toMatch(/fetchDistinctWorkstations/);
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

describe('Stage C Step 10: batch continuity, explicit coverage confirmation, and site absence alerts', () => {
  it('imports the new Step 10 service functions', () => {
    expect(source).toMatch(/fetchCoverageTimeline, CoverageTimelineEntry,/);
    expect(source).toMatch(/fetchSiteAbsenceAlerts, acknowledgeSiteAlert, SiteAbsenceAlert,/);
  });

  it('requires an explicit, separate confirmCoverageAccurate affirmation (not merely a chosen period) to enable import', () => {
    const def = source.match(/const canProcessScope =[^;]*;/)?.[0] ?? '';
    expect(def).toMatch(/confirmCoverageAccurate/);
    // The checkbox's own label must explicitly distinguish a declared
    // coverage period from the file's own first/last timestamps.
    expect(source).toMatch(/not merely the first\/last fingerprint timestamps found in the file/);
  });

  it('resets confirmCoverageAccurate for every new file, same as the other scope fields', () => {
    const resetFn = source.match(/const resetForNewFile = useCallback\(\(\) => \{[\s\S]*?\}, \[\]\);/)?.[0] ?? '';
    expect(resetFn).toMatch(/setConfirmCoverageAccurate\(false\)/);
  });

  it('loads the coverage timeline and open site alerts on mount, and re-loads both after a successful import/retry', () => {
    expect(source).toMatch(/const reloadCoverageTimeline = useCallback/);
    expect(source).toMatch(/const reloadSiteAlerts = useCallback/);
    const mountEffect = source.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[reloadCoverageTimeline, reloadSiteAlerts\]\);/)?.[0] ?? '';
    expect(mountEffect).toMatch(/await reloadCoverageTimeline\(\);/);
    expect(mountEffect).toMatch(/await reloadSiteAlerts\(\);/);

    const importHandler = source.match(/const handleImport = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/)?.[0] ?? '';
    expect(importHandler).toMatch(/await reloadCoverageTimeline\(\);/);
    expect(importHandler).toMatch(/await reloadSiteAlerts\(\);/);
  });

  it('renders a missing-coverage warning per scope entry, listing the missing dates, only when gaps exist', () => {
    const timelineBlock = source.slice(source.indexOf('coverageTimeline.length > 0'), source.indexOf('siteAlerts.length > 0'));
    expect(timelineBlock).toMatch(/entry\.missingDates\.length > 0/);
    expect(timelineBlock).toMatch(/Missing export coverage for \{entry\.scopeKey\} on: \{entry\.missingDates\.join\(', '\)\}/);
    expect(timelineBlock).toMatch(/Attendance will not be marked Absent for these dates/);
    expect(timelineBlock).toMatch(/Last confirmed:/);
    expect(timelineBlock).toMatch(/Next expected:/);
  });

  it('renders open site absence alerts with site, date, live count, and affected employees', () => {
    const alertsBlock = source.slice(source.indexOf('siteAlerts.length > 0'), source.indexOf('<Card className="p-6">\n        <label htmlFor="hikcentral-file-input"'));
    expect(alertsBlock).toMatch(/\{alert\.site\} &mdash; \{alert\.alertDate\}: \{alert\.currentAbsentCount\} absent/);
    expect(alertsBlock).toMatch(/alert\.affectedEmployees\.map/);
  });

  it('gates the acknowledge control on attendance.manage_site_alerts, loaded as its own permission', () => {
    expect(source).toMatch(/setCanManageSiteAlerts\(await hasPermission\(PERMISSIONS\.ATTENDANCE_MANAGE_SITE_ALERTS\)\)/);
    const alertsBlock = source.slice(source.indexOf('siteAlerts.length > 0'), source.indexOf('<Card className="p-6">\n        <label htmlFor="hikcentral-file-input"'));
    expect(alertsBlock).toMatch(/\{canManageSiteAlerts && \(/);
  });

  it('requires a note before acknowledging, and never silently no-ops', () => {
    const ackHandler = source.match(/const handleAcknowledgeAlert = useCallback\(async \(alertId: string\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/)?.[0] ?? '';
    expect(ackHandler).toMatch(/A note is required to acknowledge this alert\./);
    expect(ackHandler).toMatch(/await acknowledgeSiteAlert\(alertId, note\);/);
  });
});

describe('Stage C Step 10A: a zero-net-new-event reimport still runs automatic attendance processing', () => {
  it('handleImport only bails out on result.success/result.batchId -- never on insertedCount/duplicatesIgnored', () => {
    const importHandler = source.match(/const handleImport = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/)?.[0] ?? '';
    const guardStart = importHandler.indexOf('if (!result.success || !result.batchId)');
    expect(guardStart, 'expected the only early-return guard after a successful raw import').toBeGreaterThanOrEqual(0);
    const applyCallStart = importHandler.indexOf('processHikCentralImportBatch({');
    expect(applyCallStart).toBeGreaterThan(guardStart);
    const betweenGuardAndApplyCall = importHandler.slice(guardStart, applyCallStart);
    // The guard (and everything between it and the auto-apply call) must
    // never reference insertedCount/duplicatesIgnored -- a pure-duplicate
    // reimport (insertedCount: 0) is still a successful import with a
    // real batchId, so it must fall through to processHikCentralImportBatch
    // exactly like any other successful import, never treated as
    // "nothing to do".
    expect(betweenGuardAndApplyCall).not.toMatch(/insertedCount/);
    expect(betweenGuardAndApplyCall).not.toMatch(/duplicatesIgnored/);
  });

  it('the success banner reports insertedCount honestly (e.g. 0) without ever skipping the auto-apply summary', () => {
    const importHandler = source.match(/const handleImport = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/)?.[0] ?? '';
    expect(importHandler).toMatch(/Imported \$\{result\.insertedCount\} new raw event\(s\)\. Applied \$\{autoApply\.appliedCount\}/);
  });
});

describe('Stage C Step 11: centralized HikCentral terminal model -- simplified import UI', () => {
  it('shows a concise detected-access-points display instead of a workstation checklist', () => {
    expect(source).toMatch(/Detected access point\(s\) in this file/);
    expect(source).toMatch(/summary\.accessPoints\.map\(\(ap\) => <Badge key=\{ap\}/);
  });

  it('computes and displays mapped/unmapped person counts for the file, from existing active mappings only (no new RPC)', () => {
    expect(source).toMatch(/import \{ fetchActiveHikCentralPersonMappings \} from '\.\.\/utils\/hikcentralPersonMappingService';/);
    expect(source).toMatch(/label="Mapped Persons"/);
    expect(source).toMatch(/label="Unmapped Persons"/);
    const handler = source.match(/const handleFileSelect = useCallback\(async \(file: File\) => \{[\s\S]*?\n {2}\}, \[resetForNewFile\]\);/)?.[0] ?? '';
    expect(handler).toMatch(/fetchActiveHikCentralPersonMappings\(\)/);
  });

  it('resets personCounts for every new file, same as the other scope fields', () => {
    const resetFn = source.match(/const resetForNewFile = useCallback\(\(\) => \{[\s\S]*?\}, \[\]\);/)?.[0] ?? '';
    expect(resetFn).toMatch(/setPersonCounts\(null\)/);
  });

  it('surfaces employees needing a terminal assignment instead of silently never marking them Absent', () => {
    expect(source).toMatch(/needsTerminalConfiguration/);
    expect(source).toMatch(/need a HikCentral terminal assignment/);
  });

  it('the coverage-confirmation checkbox label now refers to detected access points, not a chosen workstation list', () => {
    expect(source).toMatch(/complete coverage for the detected access point\(s\) above/);
  });
});

describe('Phase 3: fingerprint coverage evidence validation -- override-reason flow', () => {
  it('imports the CoverageEvidenceWarning type alongside the other auto-apply service imports', () => {
    expect(source).toMatch(/SiteAbsenceAlert, CoverageEvidenceWarning,/);
  });

  it('handleImport and handleRetryAutoApply treat needs_override_reason as a distinct, non-error outcome (no generic failure notification for it)', () => {
    const importHandler = source.match(/const handleImport = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/)?.[0] ?? '';
    const retryHandler = source.match(/const handleRetryAutoApply = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/)?.[0] ?? '';
    expect(importHandler).toMatch(/autoApply\.outcome === 'needs_override_reason'/);
    expect(retryHandler).toMatch(/autoApply\.outcome !== 'needs_override_reason'/);
  });

  it('handleConfirmOverride requires a non-empty trimmed reason before calling the RPC, and passes it as overrideReason', () => {
    const handler = source.match(/const handleConfirmOverride = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/)?.[0] ?? '';
    expect(handler, 'expected to find handleConfirmOverride').toBeTruthy();
    expect(handler).toMatch(/const reason = overrideReason\.trim\(\);/);
    expect(handler).toMatch(/if \(!reason\)/);
    expect(handler).toMatch(/overrideReason: reason/);
    expect(handler).toMatch(/processHikCentralImportBatch\(\{/);
  });

  it('handleConfirmOverride never re-imports raw events -- it only calls processHikCentralImportBatch, never importHikCentralRawEvents', () => {
    const handler = source.match(/const handleConfirmOverride = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/)?.[0] ?? '';
    expect(handler).not.toMatch(/importHikCentralRawEvents/);
  });

  it('resets overrideReason for every new file, same as the other scope fields', () => {
    const resetFn = source.match(/const resetForNewFile = useCallback\(\(\) => \{[\s\S]*?\}, \[\]\);/)?.[0] ?? '';
    expect(resetFn).toMatch(/setOverrideReason\(''\)/);
  });

  it('renders the CoverageEvidenceWarningPanel only for the needs_override_reason outcome, distinct from the generic failure branch', () => {
    expect(source).toMatch(/autoApplyResult\.outcome === 'needs_override_reason' \? \(\s*<CoverageEvidenceWarningPanel/);
  });

  it('the warning panel never claims proof of a gap it cannot support -- it reports what was observed, not a status, and never writes anything implicitly', () => {
    const panelMatch = source.match(/function CoverageEvidenceWarningPanel\([\s\S]*?\nfunction SummaryStat/);
    expect(panelMatch, 'expected to find CoverageEvidenceWarningPanel').toBeTruthy();
    const panel = panelMatch![0];
    expect(panel).toMatch(/This has not been recorded as coverage and no attendance has been calculated/);
    expect(panel).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
  });
});

describe('Phase 3 safety review: an override reason alone must never imply independent verification', () => {
  it('declares a SEPARATE independentlyVerified state, distinct from overrideReason, reset together', () => {
    expect(source).toMatch(/const \[independentlyVerified, setIndependentlyVerified\] = useState\(false\);/);
    const resetFn = source.match(/const resetForNewFile = useCallback\(\(\) => \{[\s\S]*?\}, \[\]\);/)?.[0] ?? '';
    expect(resetFn).toMatch(/setIndependentlyVerified\(false\)/);
  });

  it('handleConfirmOverride refuses to proceed without independentlyVerified=true, even when a reason is present -- checked as its OWN distinct guard, not folded into the reason check', () => {
    const handler = source.match(/const handleConfirmOverride = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/)?.[0] ?? '';
    const reasonGuardIndex = handler.indexOf('if (!reason)');
    const verifiedGuardIndex = handler.indexOf('if (!independentlyVerified)');
    const rpcCallIndex = handler.indexOf('processHikCentralImportBatch({');
    expect(reasonGuardIndex).toBeGreaterThanOrEqual(0);
    expect(verifiedGuardIndex).toBeGreaterThan(reasonGuardIndex);
    expect(rpcCallIndex).toBeGreaterThan(verifiedGuardIndex);
  });

  it('handleConfirmOverride passes independentlyVerified: true literally to the RPC call -- never derives it from the reason text', () => {
    const handler = source.match(/const handleConfirmOverride = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/)?.[0] ?? '';
    expect(handler).toMatch(/independentlyVerified: true,/);
  });

  it('the Confirm button stays disabled unless BOTH the reason is non-empty AND the attestation checkbox is checked', () => {
    expect(source).toMatch(/disabled=\{confirming \|\| !overrideReason\.trim\(\) \|\| !independentlyVerified\}/);
  });

  it('the attestation is a dedicated checkbox input, not reused from the reason textarea or the unrelated confirmCoverageAccurate checkbox', () => {
    const panelMatch = source.match(/function CoverageEvidenceWarningPanel\([\s\S]*?\nfunction SummaryStat/);
    const panel = panelMatch?.[0] ?? '';
    expect(panel).toMatch(/type="checkbox"[\s\S]*?checked=\{independentlyVerified\}/);
    expect(panel).toMatch(/independently checked this export&apos;s completeness directly against HikCentral or the relevant terminal\/site/);
  });
});
