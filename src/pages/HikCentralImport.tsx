// HikCentral Attendance MVP -- Phase 1 import, extended in Stage C Step 8
// with automatic attendance calculation and write-through, and in Stage C
// Step 11 to the centralized-terminal model.
//
// Select a file, parse it locally, show a validation/preview summary,
// then -- if the caller has permission -- import the raw events AND
// (same action, same click) automatically calculate and apply
// Present/Late/Absent to the official Monthly Register for the declared
// processing scope (period + the file's own detected access points).
// There is no separate confirmation screen for this normal import flow;
// see attendanceImportAutoApplyService.ts for the write-through RPC this
// calls and supabase/migrations/20261018000000_hikcentral_centralized_terminal_model.sql
// for its safety guarantees (tenant/region scope, manual-correction
// precedence, approved-payroll protection, idempotent reprocessing,
// per-employee terminal-coverage gating of Absent).
//
// Stage C Step 11: Safeguard has many employee workstations but only a
// handful of centrally located HikCentral terminals -- guards from many
// workstations travel to ONE central terminal to clock in/out. Requiring
// an administrator to select employee workstations for a normal import
// was therefore backwards: this page no longer shows a workstation
// checklist at all. It instead shows the access points the file itself
// declares were used, and requires an explicit confirmation that this
// declared period is this export's complete coverage for those access
// points. Which employees can actually become Absent is now governed
// entirely by each employee's own assigned-terminal(s) (configured on the
// Person Mapping page, employee_hikcentral_terminals) intersected with
// these declared access points -- never by employees.workstation, which
// remains reserved for HR/payroll and site-level absence alerts.
import { useState, useCallback, useEffect } from 'react';
import { Upload, FileSpreadsheet, AlertCircle, CheckCircle2, Fingerprint } from '../utils/icons';
import { Card, Button, Badge, PageHeader, EmptyState } from '../components/ui';
import { getCurrentProfile, UserProfile } from '../utils/currentProfile';
import { hasPermission, PERMISSIONS } from '../utils/permissions';
import { showNotification } from '../utils/clickHandlers';
import { parseHikCentralExcelFile } from '../utils/hikcentralFileReader';
import {
  HikCentralParseResult, HikCentralFileError, HikCentralImportSummary,
  summarizeHikCentralParseResult,
} from '../utils/hikcentralExcelParser';
import { importHikCentralRawEvents, computeFileFingerprint, HikCentralImportResult } from '../utils/hikcentralImportService';
import {
  processHikCentralImportBatch, isoToBlantyreDateStr,
  ProcessImportBatchResult, fetchCoverageTimeline, CoverageTimelineEntry,
  fetchSiteAbsenceAlerts, acknowledgeSiteAlert, SiteAbsenceAlert, CoverageEvidenceWarning,
} from '../utils/attendanceImportAutoApplyService';
import { fetchActiveHikCentralPersonMappings } from '../utils/hikcentralPersonMappingService';

interface PersonCoverageCounts {
  mapped: number;
  unmapped: number;
}

export default function HikCentralImportPage() {
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [canImport, setCanImport] = useState(false);
  const [canManageSiteAlerts, setCanManageSiteAlerts] = useState(false);
  const [permissionsLoaded, setPermissionsLoaded] = useState(false);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseResult, setParseResult] = useState<HikCentralParseResult | null>(null);
  const [summary, setSummary] = useState<HikCentralImportSummary | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  // Stage C Step 11: mapped/unmapped PERSON counts for this file -- how
  // many of the distinct Person Nos. found in THIS export already have an
  // active HikCentral person mapping (and are therefore eligible for
  // automatic processing at all), vs. how many do not yet (and will be
  // skipped until mapped on the Person Mapping page). Purely informational;
  // computed client-side from already-fetched data, no new RPC.
  const [personCounts, setPersonCounts] = useState<PersonCoverageCounts | null>(null);

  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<HikCentralImportResult | null>(null);
  const [autoApplyResult, setAutoApplyResult] = useState<ProcessImportBatchResult | null>(null);

  // Declared processing scope -- what period this export covers. Asked
  // for ONCE, on this same upload screen, as part of the one "Import Raw
  // Events" action: this feeds both the durable fingerprint coverage
  // confirmation and the automatic P/L/A (including a genuinely-confirmed
  // Absent) write-through that runs immediately after a successful import
  // -- see attendanceImportAutoApplyService.ts. This is not a second
  // manual confirmation step; it is metadata about the file the
  // administrator is already uploading. The access points this scope
  // applies to are never separately chosen here -- they are exactly what
  // the file itself declares (summary.accessPoints), shown below for
  // confirmation only.
  const [periodFrom, setPeriodFrom] = useState('');
  const [periodTo, setPeriodTo] = useState('');
  // Stage C Step 10: an explicit, separate affirmation -- distinct from
  // merely having picked a period above -- that the operator is declaring
  // this as the export's actual complete coverage, not just echoing the
  // file's own first/last recorded timestamps. Required to enable import;
  // reset for every new file so it can never silently carry over. Stage C
  // Step 11: its label now names the detected access points, since those
  // (not a chosen workstation list) are what "complete coverage" means.
  const [confirmCoverageAccurate, setConfirmCoverageAccurate] = useState(false);

  // Stage C Step 10: batch continuity -- per-workstation/access-point
  // coverage timeline, so an operator can see what's already covered and
  // what's missing before (and after) uploading. Degrades silently (empty
  // list) in an environment where this migration isn't applied yet, same
  // convention as processHikCentralImportBatch's own missing_rpc outcome.
  // Phase 3: a human-authored reason, typed only when the server reports
  // the declared period exceeds the observed fingerprint evidence --
  // never pre-filled, never carried over to a new file.
  const [overrideReason, setOverrideReason] = useState('');
  const [coverageTimeline, setCoverageTimeline] = useState<CoverageTimelineEntry[]>([]);
  const [siteAlerts, setSiteAlerts] = useState<SiteAbsenceAlert[]>([]);
  const [ackNotes, setAckNotes] = useState<Record<string, string>>({});
  const [acknowledging, setAcknowledging] = useState<Record<string, boolean>>({});

  const reloadCoverageTimeline = useCallback(async () => {
    try {
      setCoverageTimeline(await fetchCoverageTimeline());
    } catch {
      setCoverageTimeline([]);
    }
  }, []);

  const reloadSiteAlerts = useCallback(async () => {
    try {
      setSiteAlerts(await fetchSiteAbsenceAlerts('open'));
    } catch {
      setSiteAlerts([]);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const profile = await getCurrentProfile();
      setUserProfile(profile);
      setCanImport(await hasPermission(PERMISSIONS.ATTENDANCE_IMPORT_HIKCENTRAL));
      setCanManageSiteAlerts(await hasPermission(PERMISSIONS.ATTENDANCE_MANAGE_SITE_ALERTS));
      setPermissionsLoaded(true);
      await reloadCoverageTimeline();
      await reloadSiteAlerts();
    })();
  }, [reloadCoverageTimeline, reloadSiteAlerts]);

  const handleAcknowledgeAlert = useCallback(async (alertId: string) => {
    const note = (ackNotes[alertId] || '').trim();
    if (!note) {
      showNotification('A note is required to acknowledge this alert.', 'error');
      return;
    }
    setAcknowledging((prev) => ({ ...prev, [alertId]: true }));
    try {
      await acknowledgeSiteAlert(alertId, note);
      await reloadSiteAlerts();
      showNotification('Alert acknowledged.', 'success');
    } catch (err) {
      showNotification(err instanceof Error ? err.message : 'Could not acknowledge this alert.', 'error');
    } finally {
      setAcknowledging((prev) => ({ ...prev, [alertId]: false }));
    }
  }, [ackNotes, reloadSiteAlerts]);

  const resetForNewFile = useCallback(() => {
    setParseResult(null);
    setSummary(null);
    setFileError(null);
    setImportResult(null);
    setAutoApplyResult(null);
    setPersonCounts(null);
    setPeriodFrom('');
    setPeriodTo('');
    setConfirmCoverageAccurate(false);
    setOverrideReason('');
  }, []);

  const handleFileSelect = useCallback(async (file: File) => {
    resetForNewFile();
    setSelectedFile(file);
    setParsing(true);
    try {
      const result = await parseHikCentralExcelFile(file);
      setParseResult(result);
      const fileSummary = summarizeHikCentralParseResult(result);
      setSummary(fileSummary);
      // Convenience default only -- the file's own observed event range is
      // never treated as proof of coverage by itself (see
      // isoToBlantyreDateStr's own doc comment); the administrator must
      // still explicitly confirm or adjust these before importing.
      if (fileSummary.dateRange) {
        setPeriodFrom(isoToBlantyreDateStr(fileSummary.dateRange.earliest));
        setPeriodTo(isoToBlantyreDateStr(fileSummary.dateRange.latest));
      }
      // Stage C Step 11: mapped/unmapped person counts for this file,
      // computed client-side from the already-fetched active mappings --
      // no new RPC needed for this display.
      try {
        const distinctPersonNos = new Set<string>();
        result.rows.forEach((r) => {
          if (r.hikcentralPersonNo) distinctPersonNos.add(r.hikcentralPersonNo);
        });
        const activeMappings = await fetchActiveHikCentralPersonMappings();
        const mappedPersonNos = new Set(activeMappings.map((m) => m.hikcentralPersonNo));
        let mapped = 0;
        distinctPersonNos.forEach((p) => { if (mappedPersonNos.has(p)) mapped += 1; });
        setPersonCounts({ mapped, unmapped: distinctPersonNos.size - mapped });
      } catch {
        setPersonCounts(null);
      }
    } catch (err) {
      setFileError(err instanceof HikCentralFileError ? err.message : 'Could not read this file. Please confirm it is a valid .xlsx HikCentral export.');
    } finally {
      setParsing(false);
    }
  }, [resetForNewFile]);

  const canProcessScope = !!summary && summary.accessPoints.length > 0 && !!periodFrom && !!periodTo && periodFrom <= periodTo && confirmCoverageAccurate;

  const handleImport = useCallback(async () => {
    if (!parseResult || !selectedFile || !userProfile || !canProcessScope || !summary) return;
    setImporting(true);
    try {
      const fileFingerprint = await computeFileFingerprint(selectedFile);
      const result = await importHikCentralRawEvents(selectedFile.name, fileFingerprint, parseResult);
      setImportResult(result);
      if (!result.success || !result.batchId) {
        showNotification(result.error || 'Could not import HikCentral events.', 'error');
        return;
      }

      // Immediately, same action, same click -- no second button: resolve
      // roster + calculate + write eligible P/L/A (and now a genuinely-
      // confirmed Absent) for the declared scope. The raw import having
      // already succeeded is a separate, already-committed fact; if THIS
      // step fails, that is surfaced distinctly below, never folded into a
      // blanket "success" banner.
      //
      // Stage C Step 11: accessPoints -- the file's own detected access
      // points -- is now the primary, required declaration. There is no
      // workstation selection to pass; which employees can become Absent
      // is gated by each employee's own assigned terminal(s), not by any
      // list chosen here.
      const autoApply = await processHikCentralImportBatch({
        importBatchId: result.batchId,
        periodFromDate: periodFrom,
        periodToDate: periodTo,
        dateFrom: periodFrom,
        dateTo: periodTo,
        accessPoints: summary.accessPoints,
      });
      setAutoApplyResult(autoApply);

      if (autoApply.success) {
        showNotification(
          `Imported ${result.insertedCount} new raw event(s). Applied ${autoApply.appliedCount} attendance record(s) across ${autoApply.employeeCount} employee(s).`,
          'success'
        );
        // Stage C Step 10: this import may have closed a gap or newly
        // crossed the 5-absence threshold somewhere -- refresh both
        // read-only panels so the operator sees current state, not what
        // was true before this upload.
        await reloadCoverageTimeline();
        await reloadSiteAlerts();
      } else if (autoApply.outcome === 'needs_override_reason') {
        // Phase 3: a normal, expected stop (not a failure) -- its own
        // dedicated warning card below prompts for a reason or a
        // narrower period, instead of a generic error notification.
      } else {
        showNotification(`Raw events were imported, but automatic attendance processing failed: ${autoApply.error || 'unknown error'}`, 'error');
      }
    } finally {
      setImporting(false);
    }
  }, [parseResult, selectedFile, userProfile, canProcessScope, summary, periodFrom, periodTo, reloadCoverageTimeline, reloadSiteAlerts]);

  const [retrying, setRetrying] = useState(false);

  // Retries ONLY the automatic processing step (not a re-import of raw
  // events -- those are already durably stored) for the same batch and
  // declared scope. Safe to call again at any time, including after more
  // fingerprint events have since arrived for the same period: every
  // underlying write is idempotent (attendance_write_one's own no-op
  // guard), and re-declaring the identical coverage reuses the existing
  // confirmation rather than duplicating it.
  const handleRetryAutoApply = useCallback(async () => {
    if (!importResult?.batchId || !summary) return;
    setRetrying(true);
    try {
      const autoApply = await processHikCentralImportBatch({
        importBatchId: importResult.batchId,
        periodFromDate: periodFrom,
        periodToDate: periodTo,
        dateFrom: periodFrom,
        dateTo: periodTo,
        accessPoints: summary.accessPoints,
      });
      setAutoApplyResult(autoApply);
      if (autoApply.success) {
        showNotification(`Applied ${autoApply.appliedCount} attendance record(s) across ${autoApply.employeeCount} employee(s).`, 'success');
        await reloadCoverageTimeline();
        await reloadSiteAlerts();
      } else if (autoApply.outcome !== 'needs_override_reason') {
        showNotification(`Automatic attendance processing still failed: ${autoApply.error || 'unknown error'}`, 'error');
      }
    } finally {
      setRetrying(false);
    }
  }, [importResult, summary, periodFrom, periodTo, reloadCoverageTimeline, reloadSiteAlerts]);

  // Phase 3: the operator has read the evidence-gap warning (below) and
  // explicitly typed a reason to confirm the declared coverage anyway.
  // Re-runs the SAME processing call, with that reason attached, for the
  // SAME already-imported batch -- this never re-imports raw events, and
  // is a distinct, visible, user-gated action, not a hidden retrigger.
  const handleConfirmOverride = useCallback(async () => {
    if (!importResult?.batchId || !summary) return;
    const reason = overrideReason.trim();
    if (!reason) {
      showNotification('A reason is required to confirm coverage beyond the observed fingerprint evidence.', 'error');
      return;
    }
    setRetrying(true);
    try {
      const autoApply = await processHikCentralImportBatch({
        importBatchId: importResult.batchId,
        periodFromDate: periodFrom,
        periodToDate: periodTo,
        dateFrom: periodFrom,
        dateTo: periodTo,
        accessPoints: summary.accessPoints,
        overrideReason: reason,
      });
      setAutoApplyResult(autoApply);
      if (autoApply.success) {
        showNotification(`Applied ${autoApply.appliedCount} attendance record(s) across ${autoApply.employeeCount} employee(s).`, 'success');
        setOverrideReason('');
        await reloadCoverageTimeline();
        await reloadSiteAlerts();
      } else if (autoApply.outcome !== 'needs_override_reason') {
        showNotification(`Automatic attendance processing still failed: ${autoApply.error || 'unknown error'}`, 'error');
      }
    } finally {
      setRetrying(false);
    }
  }, [importResult, summary, periodFrom, periodTo, overrideReason, reloadCoverageTimeline, reloadSiteAlerts]);

  if (!permissionsLoaded) {
    return <div className="p-8 text-center text-slate-400">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="HikCentral Attendance Import"
        subtitle="Upload a HikCentral fingerprint export to preview, import, and automatically apply attendance for the declared period and detected access points."
      />

      {!canImport && (
        <Card className="p-4 bg-amber-50 border-amber-200 border">
          <div className="flex items-start gap-3">
            <AlertCircle size={18} className="text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-amber-800">View Only</p>
              <p className="text-sm text-amber-700">You can preview a file's contents, but you do not have permission to import raw events.</p>
            </div>
          </div>
        </Card>
      )}

      {coverageTimeline.length > 0 && (
        <Card className="p-6">
          <h3 className="font-semibold text-slate-800 mb-3">Coverage Timeline</h3>
          <div className="space-y-3">
            {coverageTimeline.map((entry) => (
              <div key={`${entry.scopeType}:${entry.scopeKey}`} className="border border-slate-100 rounded-lg p-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <Badge color={entry.scopeType === 'workstation' ? 'blue' : 'gray'}>
                      {entry.scopeType === 'workstation' ? 'Workstation' : 'Access Point'}
                    </Badge>
                    <span className="text-sm font-medium text-slate-700">{entry.scopeKey}</span>
                  </div>
                  <div className="text-xs text-slate-500">
                    Last confirmed: <span className="font-medium text-slate-700">{entry.lastCoveredDate}</span>
                    {' '}&middot; Next expected: <span className="font-medium text-slate-700">{entry.nextExpectedDate}</span>
                  </div>
                </div>
                {entry.missingDates.length > 0 && (
                  <div className="mt-2 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-md p-2">
                    <AlertCircle size={14} className="text-amber-600 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-800">
                      Missing export coverage for {entry.scopeKey} on: {entry.missingDates.join(', ')}. Attendance will not be marked Absent for these dates until a later import declares coverage for them.
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {siteAlerts.length > 0 && (
        <Card className="p-6">
          <h3 className="font-semibold text-slate-800 mb-3 flex items-center gap-2">
            <AlertCircle size={18} className="text-red-600" /> Site Absence Alerts
          </h3>
          <div className="space-y-3">
            {siteAlerts.map((alert) => (
              <div key={alert.id} className="border border-red-200 bg-red-50 rounded-lg p-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <p className="text-sm font-medium text-red-800">
                    {alert.site} &mdash; {alert.alertDate}: {alert.currentAbsentCount} absent
                  </p>
                  <Badge color="red">Open</Badge>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {alert.affectedEmployees.map((e) => (
                    <Badge key={e.employeeId} color="gray">{e.fullName}</Badge>
                  ))}
                </div>
                {canManageSiteAlerts && (
                  <div className="mt-3 flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="Note required to acknowledge"
                      value={ackNotes[alert.id] || ''}
                      onChange={(e) => setAckNotes((prev) => ({ ...prev, [alert.id]: e.target.value }))}
                      className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs"
                    />
                    <Button onClick={() => handleAcknowledgeAlert(alert.id)} disabled={!!acknowledging[alert.id]}>
                      {acknowledging[alert.id] ? 'Acknowledging...' : 'Acknowledge'}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-6">
        <label htmlFor="hikcentral-file-input" className="flex flex-col items-center justify-center gap-3 border-2 border-dashed border-slate-200 rounded-xl p-8 cursor-pointer hover:border-[#081C3A]/40 transition-colors">
          <Upload size={28} className="text-slate-400" />
          <div className="text-center">
            <p className="text-sm font-medium text-slate-700">Select a HikCentral export (.xlsx)</p>
            <p className="text-xs text-slate-500 mt-1">Parsed locally in your browser before anything is imported.</p>
          </div>
          <input
            id="hikcentral-file-input"
            name="hikcentral-file-input"
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFileSelect(file);
              e.target.value = '';
            }}
          />
        </label>
        {selectedFile && (
          <p className="text-xs text-slate-500 mt-3 flex items-center gap-2">
            <FileSpreadsheet size={14} /> {selectedFile.name}
          </p>
        )}
      </Card>

      {parsing && (
        <Card className="p-6 text-center text-slate-500 text-sm">Parsing file...</Card>
      )}

      {fileError && (
        <Card className="p-4 bg-red-50 border-red-200 border">
          <div className="flex items-start gap-3">
            <AlertCircle size={18} className="text-red-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-red-800">This file could not be imported</p>
              <p className="text-sm text-red-700 mt-1">{fileError}</p>
            </div>
          </div>
        </Card>
      )}

      {summary && parseResult && (
        <>
          <Card className="p-6">
            <h3 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
              <Fingerprint size={18} className="text-[#D4A017]" /> Preview Summary
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <SummaryStat label="Total Rows" value={summary.totalRows} />
              <SummaryStat label="Authorization" value={summary.authorizationCount} accent="green" />
              <SummaryStat label="Failed" value={summary.failedCount} accent="red" />
              <SummaryStat label="With Person No." value={summary.withPersonNoCount} />
              <SummaryStat label="Without Person No." value={summary.withoutPersonNoCount} accent="amber" />
              <SummaryStat label="Unique Person Nos" value={summary.uniquePersonNoCount} />
              <SummaryStat label="Row Errors" value={summary.rowErrorCount} accent={summary.rowErrorCount > 0 ? 'red' : undefined} />
              <SummaryStat label="Detected Access Points" value={summary.accessPoints.length} />
            </div>
            {personCounts && (
              <div className="grid grid-cols-2 gap-4 mt-4">
                <SummaryStat label="Mapped Persons" value={personCounts.mapped} accent="green" />
                <SummaryStat label="Unmapped Persons" value={personCounts.unmapped} accent={personCounts.unmapped > 0 ? 'amber' : undefined} />
              </div>
            )}
            {personCounts && personCounts.unmapped > 0 && (
              <p className="text-xs text-amber-600 mt-2">
                {personCounts.unmapped} person(s) in this file have no active mapping yet and will be skipped by automatic processing until mapped on the Person Mapping page.
              </p>
            )}
            {summary.dateRange && (
              <p className="text-xs text-slate-500 mt-4">
                Date range: {new Date(summary.dateRange.earliest).toLocaleString()} &ndash; {new Date(summary.dateRange.latest).toLocaleString()}
              </p>
            )}
            <p className="text-xs text-slate-400 mt-4">
              This is a preview only. No attendance has been changed, and no data has been saved yet.
            </p>
          </Card>

          {parseResult.rowErrors.length > 0 && (
            <Card className="p-6 bg-red-50 border-red-200 border">
              <p className="text-sm font-medium text-red-800 mb-2">{parseResult.rowErrors.length} row(s) could not be parsed and will be skipped</p>
              <div className="max-h-40 overflow-y-auto text-xs text-red-700 space-y-1">
                {parseResult.rowErrors.slice(0, 50).map((e, i) => (
                  <p key={i}>Row {e.rowNumber}: {e.message}</p>
                ))}
                {parseResult.rowErrors.length > 50 && <p>...and {parseResult.rowErrors.length - 50} more</p>}
              </div>
            </Card>
          )}

          {canImport && !importResult && (
            <Card className="p-6 space-y-5">
              <div>
                <p className="text-sm font-medium text-slate-800">Attendance processing scope</p>
                <p className="text-xs text-slate-500 mt-1">
                  Safeguard reads which access points this export used directly from the file -- there is nothing to select. What period does this export cover for those access points? This is used immediately after import to automatically calculate and apply Present/Late/Absent to the official Monthly Register for the matching employees -- no separate confirmation step.
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-600 mb-2">Detected access point(s) in this file</p>
                {summary.accessPoints.length === 0 ? (
                  <p className="text-xs text-red-600">No access point was found in this file -- import cannot be processed for attendance until the export includes one.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {summary.accessPoints.map((ap) => <Badge key={ap} color="gray">{ap}</Badge>)}
                  </div>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label className="text-xs text-slate-600 space-y-1">
                  <span className="block font-medium">Period start</span>
                  <input
                    type="date"
                    value={periodFrom}
                    onChange={(e) => setPeriodFrom(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  />
                </label>
                <label className="text-xs text-slate-600 space-y-1">
                  <span className="block font-medium">Period end</span>
                  <input
                    type="date"
                    value={periodTo}
                    onChange={(e) => setPeriodTo(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  />
                </label>
              </div>
              {periodFrom && periodTo && periodFrom > periodTo && (
                <p className="text-xs text-red-600">Period start must be on or before period end.</p>
              )}
              <label className="flex items-start gap-2 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={confirmCoverageAccurate}
                  onChange={(e) => setConfirmCoverageAccurate(e.target.checked)}
                />
                <span>
                  I confirm the period selected above is this export&apos;s actual, complete coverage for the detected access point(s) above -- not merely the first/last fingerprint timestamps found in the file.
                </span>
              </label>
              <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                <p className="text-xs text-slate-500">
                  {summary.authorizationCount} successful event(s) will be stored as raw events, then attendance will be calculated and applied automatically for the selected scope.
                </p>
                <Button onClick={handleImport} disabled={importing || summary.authorizationCount === 0 || !canProcessScope}>
                  {importing ? 'Importing...' : 'Import Raw Events'}
                </Button>
              </div>
            </Card>
          )}

          {importResult && (
            <Card className={`p-6 border ${importResult.success ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
              <div className="flex items-start gap-3">
                {importResult.success
                  ? <CheckCircle2 size={20} className="text-emerald-600 shrink-0 mt-0.5" />
                  : <AlertCircle size={20} className="text-red-600 shrink-0 mt-0.5" />}
                <div className="space-y-1">
                  <p className={`text-sm font-medium ${importResult.success ? 'text-emerald-800' : 'text-red-800'}`}>
                    {importResult.success ? 'Raw events imported' : 'Import failed'}
                  </p>
                  {importResult.success ? (
                    <>
                      <p className="text-sm text-emerald-700">New raw events inserted: {importResult.insertedCount}</p>
                      <p className="text-sm text-emerald-700">Exact duplicates ignored: {importResult.duplicatesIgnored}</p>
                      <p className="text-sm text-emerald-700">Unidentified successful events (no Person No.): {summary.withoutPersonNoCount}</p>
                      <p className="text-sm text-emerald-700">Failed authentication events (counted, not stored individually): {summary.failedCount}</p>
                      <p className="text-xs text-emerald-600 mt-2">Batch ID: {importResult.batchId}</p>
                    </>
                  ) : (
                    <p className="text-sm text-red-700">{importResult.error}</p>
                  )}
                </div>
              </div>
            </Card>
          )}

          {importResult?.success && autoApplyResult && (
            <Card className={`p-6 border ${autoApplyResult.success ? 'bg-emerald-50 border-emerald-200' : autoApplyResult.outcome === 'needs_override_reason' ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'}`}>
              <div className="flex items-start gap-3">
                {autoApplyResult.success
                  ? <CheckCircle2 size={20} className="text-emerald-600 shrink-0 mt-0.5" />
                  : <AlertCircle size={20} className={`shrink-0 mt-0.5 ${autoApplyResult.outcome === 'needs_override_reason' ? 'text-amber-600' : 'text-red-600'}`} />}
                <div className="space-y-1 w-full">
                  <p className={`text-sm font-medium ${autoApplyResult.success ? 'text-emerald-800' : autoApplyResult.outcome === 'needs_override_reason' ? 'text-amber-800' : 'text-red-800'}`}>
                    {autoApplyResult.success ? 'Attendance calculated and applied automatically' : autoApplyResult.outcome === 'needs_override_reason' ? 'Confirmation needed: declared coverage exceeds observed evidence' : 'Automatic attendance processing failed'}
                  </p>
                  {autoApplyResult.success ? (
                    <>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2">
                        <SummaryStat label="Employees" value={autoApplyResult.employeeCount ?? 0} />
                        <SummaryStat label="Applied" value={autoApplyResult.appliedCount ?? 0} accent="green" />
                        <SummaryStat label="Unchanged" value={autoApplyResult.unchangedCount ?? 0} />
                        <SummaryStat label="Skipped" value={autoApplyResult.skippedCount ?? 0} accent="amber" />
                      </div>
                      <p className="text-xs text-emerald-600 mt-2">
                        Skipped covers Off/Unassigned/Pending days, manually-corrected or approved-payroll-protected records, and anything already up to date -- these are never overwritten automatically.
                      </p>
                      {autoApplyResult.needsTerminalConfiguration && autoApplyResult.needsTerminalConfiguration.length > 0 && (
                        <div className="mt-3 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-md p-3">
                          <AlertCircle size={14} className="text-amber-600 shrink-0 mt-0.5" />
                          <div>
                            <p className="text-xs font-medium text-amber-800">
                              {autoApplyResult.needsTerminalConfiguration.length} employee(s) need a HikCentral terminal assignment
                            </p>
                            <p className="text-xs text-amber-700 mt-1">
                              These employees are mapped and in scope, but have no assigned HikCentral terminal yet, so they can never be marked Absent until one is configured on the Person Mapping page: {autoApplyResult.needsTerminalConfiguration.map((e) => e.fullName).join(', ')}.
                            </p>
                          </div>
                        </div>
                      )}
                    </>
                  ) : autoApplyResult.outcome === 'needs_override_reason' ? (
                    <CoverageEvidenceWarningPanel
                      warning={autoApplyResult.coverageEvidenceWarning}
                      overrideReason={overrideReason}
                      onOverrideReasonChange={setOverrideReason}
                      onConfirm={handleConfirmOverride}
                      confirming={retrying}
                    />
                  ) : (
                    <>
                      <p className="text-sm text-red-700">
                        Raw events were imported successfully, but attendance was NOT calculated or applied: {autoApplyResult.error}
                      </p>
                      <Button onClick={handleRetryAutoApply} disabled={retrying} className="mt-2">
                        {retrying ? 'Retrying...' : 'Retry Attendance Processing'}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </Card>
          )}
        </>
      )}

      {!summary && !parsing && !fileError && (
        <EmptyState
          icon={FileSpreadsheet}
          title="No file selected yet"
          description='Select a HikCentral "Person Authentication Record" .xlsx export above to preview its contents.'
        />
      )}
    </div>
  );
}

// Phase 3: shown in place of a generic failure when the server reports
// needs_override_reason -- nothing has been written yet (no confirmation
// row, no attendance calculation); raw fingerprint data already imported
// is untouched either way. The operator chooses to narrow the declared
// period above to match the evidence, or to type an explicit reason and
// confirm the coverage anyway.
function CoverageEvidenceWarningPanel({
  warning, overrideReason, onOverrideReasonChange, onConfirm, confirming,
}: {
  warning: CoverageEvidenceWarning | undefined;
  overrideReason: string;
  onOverrideReasonChange: (value: string) => void;
  onConfirm: () => void;
  confirming: boolean;
}) {
  return (
    <>
      <p className="text-sm text-amber-700">
        {warning?.latestObservedEventAtIso
          ? `The latest fingerprint scan actually recorded for ${(warning.accessPoints || []).join(', ')} in this period was ${new Date(warning.latestObservedEventAtIso).toLocaleString()}, but the declared coverage period extends to ${warning ? new Date(warning.declaredCoversThroughIso).toLocaleString() : ''}.`
          : `No fingerprint scans were found at all for ${(warning?.accessPoints || []).join(', ')} in this declared period.`}
        {' '}This has not been recorded as coverage and no attendance has been calculated -- the imported raw fingerprint data is unaffected. Narrow the declared period above to match the evidence, or provide an explicit reason below to confirm this coverage anyway.
      </p>
      <label className="block text-xs text-slate-600 space-y-1 mt-2">
        <span className="block font-medium">Reason for confirming coverage beyond the observed evidence</span>
        <textarea
          value={overrideReason}
          onChange={(e) => onOverrideReasonChange(e.target.value)}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
          rows={2}
          placeholder="e.g. device clock known to lag; export confirmed complete by vendor support ticket #1234"
        />
      </label>
      <div className="flex justify-end mt-2">
        <Button onClick={onConfirm} disabled={confirming || !overrideReason.trim()}>
          {confirming ? 'Confirming...' : 'Confirm coverage anyway'}
        </Button>
      </div>
    </>
  );
}

function SummaryStat({ label, value, accent }: { label: string; value: number; accent?: 'green' | 'red' | 'amber' }) {
  const colorClass = accent === 'green' ? 'text-emerald-700' : accent === 'red' ? 'text-red-600' : accent === 'amber' ? 'text-amber-600' : 'text-slate-800';
  return (
    <div className="p-3 rounded-lg border border-slate-100">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-xl font-bold mt-1 ${colorClass}`}>{value.toLocaleString()}</p>
    </div>
  );
}
