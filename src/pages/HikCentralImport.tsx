// HikCentral Attendance MVP -- Phase 1 import, extended in Stage C Step 8
// with automatic attendance calculation and write-through, in Stage C
// Step 11 to the centralized-terminal model, in Phase 3 with fail-closed
// evidence validation, and now (Import redesign) reorganized into four
// tabs -- Import / Coverage / Alerts / History -- so each concern has its
// own compact view instead of one long scrolling page. The underlying
// Import flow itself (select a file, parse it locally, preview, then --
// same action, same click -- import raw events AND automatically
// calculate/apply attendance for the declared scope) is unchanged; see
// attendanceImportAutoApplyService.ts for the write-through RPC and
// supabase/migrations/20261018000000_hikcentral_centralized_terminal_model.sql
// for its safety guarantees (tenant/region scope, manual-correction
// precedence, approved-payroll protection, idempotent reprocessing,
// per-employee terminal-coverage gating of Absent).
import { useState, useCallback, useEffect, Fragment } from 'react';
import {
  Upload, FileSpreadsheet, AlertCircle, CheckCircle2, Fingerprint,
  Calendar, Bell, History as HistoryIcon, ChevronDown, ChevronRight,
} from '../utils/icons';
import { Card, Button, Badge, PageHeader, EmptyState, Tabs, Select, Table, THead, TBody, TR, TH, TD } from '../components/ui';
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
  fetchSiteAbsenceAlerts, acknowledgeSiteAlert, bulkAcknowledgeSiteAlerts,
  SiteAbsenceAlert, CoverageEvidenceWarning, BulkAcknowledgeResultRow,
  fetchImportBatchHistory, ImportBatchHistoryEntry,
} from '../utils/attendanceImportAutoApplyService';
import { fetchActiveHikCentralPersonMappings } from '../utils/hikcentralPersonMappingService';
import { groupConsecutiveDates, formatDateRange } from '../utils/dateRangeGrouping';

interface PersonCoverageCounts {
  mapped: number;
  unmapped: number;
}

type ImportTabId = 'import' | 'coverage' | 'alerts' | 'history';

const HISTORY_PAGE_SIZE = 20;
type AlertStatusFilter = 'open' | 'acknowledged' | 'resolved';

export default function HikCentralImportPage() {
  const [activeTab, setActiveTab] = useState<ImportTabId>('import');

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

  // Phase 3: a human-authored reason, typed only when the server reports
  // the declared period exceeds the observed fingerprint evidence --
  // never pre-filled, never carried over to a new file.
  const [overrideReason, setOverrideReason] = useState('');
  // Phase 3 safety review: a SEPARATE, explicit attestation checkbox --
  // deliberately distinct from the reason textarea above, since a typed
  // reason alone must never silently imply the export was independently
  // checked against HikCentral/the site. Reset with the reason.
  const [independentlyVerified, setIndependentlyVerified] = useState(false);

  // ---- Coverage tab ----
  const [coverageTimeline, setCoverageTimeline] = useState<CoverageTimelineEntry[]>([]);
  const [expandedCoverageKeys, setExpandedCoverageKeys] = useState<Record<string, boolean>>({});

  const reloadCoverageTimeline = useCallback(async () => {
    try {
      setCoverageTimeline(await fetchCoverageTimeline());
    } catch {
      setCoverageTimeline([]);
    }
  }, []);

  const toggleCoverageExpanded = useCallback((key: string) => {
    setExpandedCoverageKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // ---- Alerts tab ----
  const [alertStatusFilter, setAlertStatusFilter] = useState<AlertStatusFilter>('open');
  const [siteAlerts, setSiteAlerts] = useState<SiteAbsenceAlert[]>([]);
  const [selectedAlertIds, setSelectedAlertIds] = useState<Set<string>>(new Set());
  const [bulkNote, setBulkNote] = useState('');
  const [bulkAcking, setBulkAcking] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkAcknowledgeResultRow[] | null>(null);
  // Legacy single-alert note inputs, kept only as a fallback path when
  // acknowledging exactly one alert without leaving the bulk note blank
  // for everyone else's sake is inconvenient -- unused by default.
  const [ackNotes, setAckNotes] = useState<Record<string, string>>({});
  const [acknowledging, setAcknowledging] = useState<Record<string, boolean>>({});

  const reloadSiteAlerts = useCallback(async (filter: AlertStatusFilter) => {
    try {
      if (filter === 'open') {
        const open = await fetchSiteAbsenceAlerts('open');
        // Defensive display guard: an alert this view treats as "active"
        // must never be shown with zero (or sub-threshold) current
        // absentees -- the lifecycle trigger (see PR #59) is what actually
        // keeps this true, this is just never trusting that silently.
        setSiteAlerts(open.filter((a) => a.currentAbsentCount >= 5));
      } else {
        const closed = await fetchSiteAbsenceAlerts('closed');
        setSiteAlerts(closed.filter((a) => (filter === 'acknowledged' ? a.closedBy !== null : a.closedBy === null)));
      }
    } catch {
      setSiteAlerts([]);
    }
  }, []);

  useEffect(() => {
    setSelectedAlertIds(new Set());
    setBulkResult(null);
    reloadSiteAlerts(alertStatusFilter);
  }, [alertStatusFilter, reloadSiteAlerts]);

  const visibleAlertIds = siteAlerts.map((a) => a.id);
  const allVisibleAlertsSelected = visibleAlertIds.length > 0 && visibleAlertIds.every((id) => selectedAlertIds.has(id));

  const toggleSelectAllVisibleAlerts = useCallback(() => {
    setSelectedAlertIds((prev) => {
      const next = new Set(prev);
      if (allVisibleAlertsSelected) {
        visibleAlertIds.forEach((id) => next.delete(id));
      } else {
        visibleAlertIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }, [allVisibleAlertsSelected, visibleAlertIds]);

  const toggleAlertSelected = useCallback((alertId: string) => {
    setSelectedAlertIds((prev) => {
      const next = new Set(prev);
      if (next.has(alertId)) next.delete(alertId); else next.add(alertId);
      return next;
    });
  }, []);

  const handleAcknowledgeAlert = useCallback(async (alertId: string) => {
    const note = (ackNotes[alertId] || '').trim();
    if (!note) {
      showNotification('A note is required to acknowledge this alert.', 'error');
      return;
    }
    setAcknowledging((prev) => ({ ...prev, [alertId]: true }));
    try {
      await acknowledgeSiteAlert(alertId, note);
      await reloadSiteAlerts(alertStatusFilter);
      showNotification('Alert acknowledged.', 'success');
    } catch (err) {
      showNotification(err instanceof Error ? err.message : 'Could not acknowledge this alert.', 'error');
    } finally {
      setAcknowledging((prev) => ({ ...prev, [alertId]: false }));
    }
  }, [ackNotes, alertStatusFilter, reloadSiteAlerts]);

  // Acknowledges every currently SELECTED alert with one shared note.
  // Reports each alert's own outcome -- a partial failure (e.g. one id
  // from a since-changed list) is shown truthfully, never silently
  // dropped or folded into a blanket success/failure banner.
  const handleBulkAcknowledge = useCallback(async () => {
    const ids = Array.from(selectedAlertIds);
    const note = bulkNote.trim();
    if (ids.length === 0) {
      showNotification('Select at least one alert to acknowledge.', 'error');
      return;
    }
    if (!note) {
      showNotification('A note is required to acknowledge alerts.', 'error');
      return;
    }
    setBulkAcking(true);
    try {
      const results = await bulkAcknowledgeSiteAlerts(ids, note);
      setBulkResult(results);
      const acknowledgedCount = results.filter((r) => r.outcome === 'acknowledged').length;
      const failedCount = results.length - acknowledgedCount;
      if (failedCount === 0) {
        showNotification(`Acknowledged ${acknowledgedCount} alert(s).`, 'success');
      } else {
        showNotification(`Acknowledged ${acknowledgedCount} alert(s); ${failedCount} could not be acknowledged -- see details below.`, 'error');
      }
      setSelectedAlertIds(new Set());
      setBulkNote('');
      await reloadSiteAlerts(alertStatusFilter);
    } catch (err) {
      showNotification(err instanceof Error ? err.message : 'Could not acknowledge the selected alerts.', 'error');
    } finally {
      setBulkAcking(false);
    }
  }, [selectedAlertIds, bulkNote, alertStatusFilter, reloadSiteAlerts]);

  // ---- History tab ----
  const [historyPage, setHistoryPage] = useState(0);
  const [historyBatches, setHistoryBatches] = useState<ImportBatchHistoryEntry[]>([]);
  const [historyTotalCount, setHistoryTotalCount] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [expandedHistoryIds, setExpandedHistoryIds] = useState<Record<string, boolean>>({});

  const reloadHistory = useCallback(async (page: number) => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const result = await fetchImportBatchHistory(HISTORY_PAGE_SIZE, page * HISTORY_PAGE_SIZE);
      setHistoryBatches(result.batches);
      setHistoryTotalCount(result.totalCount);
    } catch (err) {
      // The RPC's own error message (including an authorization refusal)
      // is clear enough to show directly -- no separate client-side
      // permission flag duplicating what the server already enforces.
      setHistoryError(err instanceof Error ? err.message : 'Could not load import history.');
      setHistoryBatches([]);
      setHistoryTotalCount(0);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'history') reloadHistory(historyPage);
  }, [activeTab, historyPage, reloadHistory]);

  const toggleHistoryExpanded = useCallback((id: string) => {
    setExpandedHistoryIds((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  useEffect(() => {
    (async () => {
      const profile = await getCurrentProfile();
      setUserProfile(profile);
      setCanImport(await hasPermission(PERMISSIONS.ATTENDANCE_IMPORT_HIKCENTRAL));
      setCanManageSiteAlerts(await hasPermission(PERMISSIONS.ATTENDANCE_MANAGE_SITE_ALERTS));
      setPermissionsLoaded(true);
      await reloadCoverageTimeline();
    })();
  }, [reloadCoverageTimeline]);

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
    setIndependentlyVerified(false);
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
        await reloadSiteAlerts(alertStatusFilter);
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
  }, [parseResult, selectedFile, userProfile, canProcessScope, summary, periodFrom, periodTo, alertStatusFilter, reloadCoverageTimeline, reloadSiteAlerts]);

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
        await reloadSiteAlerts(alertStatusFilter);
      } else if (autoApply.outcome !== 'needs_override_reason') {
        showNotification(`Automatic attendance processing still failed: ${autoApply.error || 'unknown error'}`, 'error');
      }
    } finally {
      setRetrying(false);
    }
  }, [importResult, summary, periodFrom, periodTo, alertStatusFilter, reloadCoverageTimeline, reloadSiteAlerts]);

  // Phase 3: the operator has read the evidence-gap warning (below) and
  // explicitly typed a reason to confirm the declared coverage anyway.
  // Re-runs the SAME processing call, with that reason attached, for the
  // SAME already-imported batch -- this never re-imports raw events, and
  // is a distinct, visible, user-gated action, not a hidden retrigger.
  //
  // Phase 3 safety review: a typed reason ALONE is never sufficient --
  // independentlyVerified is a SEPARATE, required checkbox (never
  // inferred from the reason text existing) attesting the administrator
  // actually checked the export's completeness against HikCentral or the
  // relevant site. Both gates are enforced again here, client-side, even
  // though the server (the real authority) already enforces them too.
  const handleConfirmOverride = useCallback(async () => {
    if (!importResult?.batchId || !summary) return;
    const reason = overrideReason.trim();
    if (!reason) {
      showNotification('A reason is required to confirm coverage beyond the observed fingerprint evidence.', 'error');
      return;
    }
    if (!independentlyVerified) {
      showNotification('You must explicitly confirm that you independently checked the export\'s completeness against HikCentral or the relevant site before overriding this warning.', 'error');
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
        independentlyVerified: true,
      });
      setAutoApplyResult(autoApply);
      if (autoApply.success) {
        showNotification(`Applied ${autoApply.appliedCount} attendance record(s) across ${autoApply.employeeCount} employee(s).`, 'success');
        setOverrideReason('');
        setIndependentlyVerified(false);
        await reloadCoverageTimeline();
        await reloadSiteAlerts(alertStatusFilter);
      } else if (autoApply.outcome !== 'needs_override_reason') {
        showNotification(`Automatic attendance processing still failed: ${autoApply.error || 'unknown error'}`, 'error');
      }
    } finally {
      setRetrying(false);
    }
  }, [importResult, summary, periodFrom, periodTo, overrideReason, independentlyVerified, alertStatusFilter, reloadCoverageTimeline, reloadSiteAlerts]);

  if (!permissionsLoaded) {
    return <div className="p-8 text-center text-slate-400">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="HikCentral Attendance Import"
        subtitle="Upload a HikCentral fingerprint export, track coverage and site absence alerts, and review past imports."
      />

      <Tabs
        tabs={[
          { id: 'import', label: 'Import', icon: Upload },
          { id: 'coverage', label: 'Coverage', icon: Calendar },
          { id: 'alerts', label: 'Alerts', icon: Bell },
          { id: 'history', label: 'History', icon: HistoryIcon },
        ]}
        active={activeTab}
        onChange={(id) => setActiveTab(id as ImportTabId)}
      />

      {activeTab === 'import' && (
        <div className="space-y-6">
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
                          independentlyVerified={independentlyVerified}
                          onIndependentlyVerifiedChange={setIndependentlyVerified}
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
      )}

      {activeTab === 'coverage' && (
        <CoverageTabPanel
          coverageTimeline={coverageTimeline}
          expandedKeys={expandedCoverageKeys}
          onToggle={toggleCoverageExpanded}
        />
      )}

      {activeTab === 'alerts' && (
        <AlertsTabPanel
          statusFilter={alertStatusFilter}
          onStatusFilterChange={setAlertStatusFilter}
          alerts={siteAlerts}
          canManageSiteAlerts={canManageSiteAlerts}
          selectedAlertIds={selectedAlertIds}
          allVisibleSelected={allVisibleAlertsSelected}
          onToggleSelectAllVisible={toggleSelectAllVisibleAlerts}
          onToggleOne={toggleAlertSelected}
          bulkNote={bulkNote}
          onBulkNoteChange={setBulkNote}
          bulkAcking={bulkAcking}
          onBulkAcknowledge={handleBulkAcknowledge}
          bulkResult={bulkResult}
          ackNotes={ackNotes}
          onAckNoteChange={(id, value) => setAckNotes((prev) => ({ ...prev, [id]: value }))}
          acknowledging={acknowledging}
          onAcknowledgeOne={handleAcknowledgeAlert}
        />
      )}

      {activeTab === 'history' && (
        <HistoryTabPanel
          canImport={canImport}
          batches={historyBatches}
          totalCount={historyTotalCount}
          page={historyPage}
          onPageChange={setHistoryPage}
          loading={historyLoading}
          error={historyError}
          expandedIds={expandedHistoryIds}
          onToggleExpanded={toggleHistoryExpanded}
        />
      )}
    </div>
  );
}

// ---- Coverage tab ----

function CoverageTabPanel({
  coverageTimeline, expandedKeys, onToggle,
}: {
  coverageTimeline: CoverageTimelineEntry[];
  expandedKeys: Record<string, boolean>;
  onToggle: (key: string) => void;
}) {
  if (coverageTimeline.length === 0) {
    return (
      <EmptyState
        icon={Calendar}
        title="No coverage history yet"
        description="A terminal/workstation's coverage timeline appears here once at least one import has declared coverage for it."
      />
    );
  }
  return (
    <Table>
      <THead>
        <TR hover={false}>
          <TH>Scope</TH>
          <TH>First Covered</TH>
          <TH>Last Covered</TH>
          <TH>Next Expected</TH>
          <TH>Status</TH>
          <TH>{null}</TH>
        </TR>
      </THead>
      <TBody>
        {coverageTimeline.map((entry) => {
          const key = `${entry.scopeType}:${entry.scopeKey}`;
          const hasGaps = entry.missingDates.length > 0;
          const expanded = !!expandedKeys[key];
          return (
            <Fragment key={key}>
              <TR onClick={hasGaps ? () => onToggle(key) : undefined} className={hasGaps ? 'cursor-pointer' : ''}>
                <TD>
                  <div className="flex items-center gap-2">
                    <Badge color={entry.scopeType === 'workstation' ? 'blue' : 'gray'}>
                      {entry.scopeType === 'workstation' ? 'Workstation' : 'Access Point'}
                    </Badge>
                    <span className="font-medium text-slate-700">{entry.scopeKey}</span>
                  </div>
                </TD>
                <TD>{entry.firstCoveredDate}</TD>
                <TD>{entry.lastCoveredDate}</TD>
                <TD>{entry.nextExpectedDate}</TD>
                <TD>
                  {hasGaps
                    ? <Badge color="yellow">{entry.missingDates.length} gap day(s)</Badge>
                    : <Badge color="emerald">Complete</Badge>}
                </TD>
                <TD>{hasGaps && (expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />)}</TD>
              </TR>
              {hasGaps && expanded && (
                <TR hover={false}>
                  <TD colSpan={6}>
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {groupConsecutiveDates(entry.missingDates).map((range) => (
                        <Badge key={`${range.start}:${range.end}`} color="orange">{formatDateRange(range)}</Badge>
                      ))}
                    </div>
                    <p className="text-xs text-amber-700">
                      Attendance will not be marked Absent for {entry.scopeKey} on these dates until a later import declares coverage for them.
                    </p>
                  </TD>
                </TR>
              )}
            </Fragment>
          );
        })}
      </TBody>
    </Table>
  );
}

// ---- Alerts tab ----

function AlertsTabPanel({
  statusFilter, onStatusFilterChange, alerts, canManageSiteAlerts,
  selectedAlertIds, allVisibleSelected, onToggleSelectAllVisible, onToggleOne,
  bulkNote, onBulkNoteChange, bulkAcking, onBulkAcknowledge, bulkResult,
  ackNotes, onAckNoteChange, acknowledging, onAcknowledgeOne,
}: {
  statusFilter: AlertStatusFilter;
  onStatusFilterChange: (filter: AlertStatusFilter) => void;
  alerts: SiteAbsenceAlert[];
  canManageSiteAlerts: boolean;
  selectedAlertIds: Set<string>;
  allVisibleSelected: boolean;
  onToggleSelectAllVisible: () => void;
  onToggleOne: (id: string) => void;
  bulkNote: string;
  onBulkNoteChange: (value: string) => void;
  bulkAcking: boolean;
  onBulkAcknowledge: () => void;
  bulkResult: BulkAcknowledgeResultRow[] | null;
  ackNotes: Record<string, string>;
  onAckNoteChange: (id: string, value: string) => void;
  acknowledging: Record<string, boolean>;
  onAcknowledgeOne: (id: string) => void;
}) {
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <Select
          label="Status"
          value={statusFilter}
          onChange={(e) => onStatusFilterChange(e.target.value as AlertStatusFilter)}
          options={[
            { label: 'Open', value: 'open' },
            { label: 'Acknowledged', value: 'acknowledged' },
            { label: 'Resolved', value: 'resolved' },
          ]}
          className="max-w-xs"
        />
      </Card>

      {bulkResult && (
        <Card className="p-4 bg-slate-50 border-slate-200 border">
          <p className="text-xs font-medium text-slate-700 mb-2">Last bulk acknowledgement result</p>
          <div className="flex flex-wrap gap-1.5">
            {bulkResult.map((r) => (
              <Badge key={r.alertId} color={r.outcome === 'acknowledged' ? 'green' : r.outcome === 'already_closed' ? 'gray' : 'red'}>
                {r.site || r.alertId.slice(0, 8)}: {r.outcome.replace('_', ' ')}
              </Badge>
            ))}
          </div>
        </Card>
      )}

      {alerts.length === 0 ? (
        <EmptyState
          icon={Bell}
          title={statusFilter === 'open' ? 'No open site absence alerts' : statusFilter === 'acknowledged' ? 'No acknowledged alerts' : 'No automatically resolved alerts'}
          description="Alerts are created automatically when 5 or more employees are Absent at the same scheduled site on the same date."
        />
      ) : (
        <>
          {canManageSiteAlerts && (
            <Card className="p-4 space-y-3">
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <input
                  type="text"
                  placeholder="Note required to acknowledge the selected alert(s)"
                  value={bulkNote}
                  onChange={(e) => onBulkNoteChange(e.target.value)}
                  className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
                <Button onClick={onBulkAcknowledge} disabled={bulkAcking || selectedAlertIds.size === 0}>
                  {bulkAcking ? 'Acknowledging...' : `Acknowledge Selected (${selectedAlertIds.size})`}
                </Button>
              </div>
            </Card>
          )}

          <Table>
            <THead>
              <TR hover={false}>
                <TH>
                  {canManageSiteAlerts && (
                    <input type="checkbox" checked={allVisibleSelected} onChange={onToggleSelectAllVisible} aria-label="Select all visible alerts" />
                  )}
                </TH>
                <TH>Site</TH>
                <TH>Date</TH>
                <TH>Absent Count</TH>
                <TH>Status</TH>
                <TH>Employees</TH>
              </TR>
            </THead>
            <TBody>
              {alerts.map((alert) => (
                <TR key={alert.id}>
                  <TD>
                    {canManageSiteAlerts && (
                      <input
                        type="checkbox"
                        checked={selectedAlertIds.has(alert.id)}
                        onChange={() => onToggleOne(alert.id)}
                        disabled={alert.status === 'closed'}
                        aria-label={`Select alert for ${alert.site} on ${alert.alertDate}`}
                      />
                    )}
                  </TD>
                  <TD>{alert.site}</TD>
                  <TD>{alert.alertDate}</TD>
                  <TD>{alert.currentAbsentCount}</TD>
                  <TD>
                    {alert.status === 'open'
                      ? <Badge color="red">Open</Badge>
                      : alert.closedBy
                        ? <Badge color="blue">Acknowledged</Badge>
                        : <Badge color="emerald">Resolved automatically</Badge>}
                  </TD>
                  <TD>
                    <div className="flex flex-wrap gap-1 max-w-xs">
                      {alert.affectedEmployees.slice(0, 3).map((e) => <Badge key={e.employeeId} color="gray">{e.fullName}</Badge>)}
                      {alert.affectedEmployees.length > 3 && <Badge color="gray">+{alert.affectedEmployees.length - 3} more</Badge>}
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>

          {/* Single-alert acknowledge path, kept for the case of acknowledging exactly one alert with its own distinct note rather than the shared bulk note above. */}
          {canManageSiteAlerts && alerts.some((a) => a.status === 'open') && (
            <Card className="p-4">
              <p className="text-xs font-medium text-slate-600 mb-2">Acknowledge a single alert with its own note</p>
              <div className="space-y-2">
                {alerts.filter((a) => a.status === 'open').map((alert) => (
                  <div key={alert.id} className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 w-40 truncate">{alert.site} &mdash; {alert.alertDate}</span>
                    <input
                      type="text"
                      placeholder="Note required to acknowledge"
                      value={ackNotes[alert.id] || ''}
                      onChange={(e) => onAckNoteChange(alert.id, e.target.value)}
                      className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs"
                    />
                    <Button size="sm" onClick={() => onAcknowledgeOne(alert.id)} disabled={!!acknowledging[alert.id]}>
                      {acknowledging[alert.id] ? 'Acknowledging...' : 'Acknowledge'}
                    </Button>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ---- History tab ----

function HistoryTabPanel({
  canImport, batches, totalCount, page, onPageChange, loading, error, expandedIds, onToggleExpanded,
}: {
  canImport: boolean;
  batches: ImportBatchHistoryEntry[];
  totalCount: number;
  page: number;
  onPageChange: (page: number) => void;
  loading: boolean;
  error: string | null;
  expandedIds: Record<string, boolean>;
  onToggleExpanded: (id: string) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(totalCount / HISTORY_PAGE_SIZE));

  if (error) {
    return (
      <Card className="p-4 bg-red-50 border-red-200 border">
        <div className="flex items-start gap-3">
          <AlertCircle size={18} className="text-red-600 shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      </Card>
    );
  }

  if (loading) {
    return <Card className="p-6 text-center text-slate-500 text-sm">Loading import history...</Card>;
  }

  if (batches.length === 0) {
    return (
      <EmptyState
        icon={HistoryIcon}
        title="No import history yet"
        description={canImport ? 'Imported HikCentral exports will appear here.' : 'You do not have permission to import HikCentral exports.'}
      />
    );
  }

  return (
    <div className="space-y-3">
      <Table>
        <THead>
          <TR hover={false}>
            <TH>Imported</TH>
            <TH>Filename</TH>
            <TH>Status</TH>
            <TH>Rows</TH>
            <TH>Access Points / Event Range</TH>
            <TH>{null}</TH>
          </TR>
        </THead>
        <TBody>
          {batches.map((batch) => {
            const expanded = !!expandedIds[batch.id];
            return (
              <Fragment key={batch.id}>
                <TR onClick={batch.errorMessage ? () => onToggleExpanded(batch.id) : undefined} className={batch.errorMessage ? 'cursor-pointer' : ''}>
                  <TD>{new Date(batch.createdAt).toLocaleString()}</TD>
                  <TD>{batch.filename || '—'}</TD>
                  <TD>
                    <Badge color={batch.status === 'completed' ? 'emerald' : batch.status === 'failed' ? 'red' : 'gray'}>{batch.status}</Badge>
                  </TD>
                  <TD>{batch.totalRows} total / {batch.authorizationCount} ok / {batch.failedCount} failed</TD>
                  <TD>
                    {batch.accessPoints.length === 0 ? (
                      <span className="text-slate-400">No events recorded</span>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1">
                        {batch.accessPoints.map((ap) => <Badge key={ap} color="gray">{ap}</Badge>)}
                        {batch.earliestEventAt && batch.latestEventAt && (
                          <span className="text-xs text-slate-500 ml-1">
                            {new Date(batch.earliestEventAt).toLocaleDateString()} &ndash; {new Date(batch.latestEventAt).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    )}
                  </TD>
                  <TD>{batch.errorMessage && (expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />)}</TD>
                </TR>
                {batch.errorMessage && expanded && (
                  <TR hover={false}>
                    <TD colSpan={6}>
                      <p className="text-xs text-red-700">{batch.errorMessage}</p>
                    </TD>
                  </TR>
                )}
              </Fragment>
            );
          })}
        </TBody>
      </Table>
      <p className="text-xs text-slate-400">
        Access points and the event time range shown above are derived from this batch's own raw fingerprint events, for reference only. The declared coverage period and attendance-processing outcome are not stored for past batches -- they are shown only for an import just completed in this session, on the Import tab.
      </p>
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">Page {page + 1} of {totalPages} ({totalCount} total)</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => onPageChange(Math.max(0, page - 1))} disabled={page === 0}>Previous</Button>
          <Button variant="outline" size="sm" onClick={() => onPageChange(page + 1)} disabled={page + 1 >= totalPages}>Next</Button>
        </div>
      </div>
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
  warning, overrideReason, onOverrideReasonChange, independentlyVerified, onIndependentlyVerifiedChange, onConfirm, confirming,
}: {
  warning: CoverageEvidenceWarning | undefined;
  overrideReason: string;
  onOverrideReasonChange: (value: string) => void;
  independentlyVerified: boolean;
  onIndependentlyVerifiedChange: (value: boolean) => void;
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
      <label className="flex items-start gap-2 text-xs text-amber-900 bg-amber-100 border border-amber-300 rounded-lg p-3 mt-2 cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={independentlyVerified}
          onChange={(e) => onIndependentlyVerifiedChange(e.target.checked)}
        />
        <span>
          I confirm I have independently checked this export&apos;s completeness directly against HikCentral or the relevant terminal/site -- not merely typed a reason above -- and that the coverage declared here is genuinely complete.
        </span>
      </label>
      <div className="flex justify-end mt-2">
        <Button onClick={onConfirm} disabled={confirming || !overrideReason.trim() || !independentlyVerified}>
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
