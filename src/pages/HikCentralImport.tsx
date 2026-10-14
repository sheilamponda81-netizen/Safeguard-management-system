// HikCentral Attendance MVP -- Phase 1 import, extended in Stage C Step 8
// with automatic attendance calculation and write-through.
//
// Select a file, parse it locally, show a validation/preview summary,
// then -- if the caller has permission -- import the raw events AND
// (same action, same click) automatically calculate and apply
// Present/Late/Absent to the official Monthly Register for the declared
// processing scope (period + workstations). There is no separate
// confirmation screen for this normal import flow; see
// attendanceImportAutoApplyService.ts for the write-through RPC this
// calls and supabase/migrations/20261016000000_attendance_import_auto_apply.sql
// for its safety guarantees (tenant/region scope, manual-correction
// precedence, approved-payroll protection, idempotent reprocessing).
// This page has no person-mapping UI (the schema/RPC already support
// Phase 2 mapping without redesign; a mapping screen is a separate,
// existing page).
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
  fetchDistinctWorkstations, processHikCentralImportBatch, isoToBlantyreDateStr,
  ProcessImportBatchResult,
} from '../utils/attendanceImportAutoApplyService';

export default function HikCentralImportPage() {
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [canImport, setCanImport] = useState(false);
  const [permissionsLoaded, setPermissionsLoaded] = useState(false);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseResult, setParseResult] = useState<HikCentralParseResult | null>(null);
  const [summary, setSummary] = useState<HikCentralImportSummary | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<HikCentralImportResult | null>(null);
  const [autoApplyResult, setAutoApplyResult] = useState<ProcessImportBatchResult | null>(null);

  // Declared processing scope -- what period and which workstations this
  // export covers. Asked for ONCE, on this same upload screen, as part of
  // the one "Import Raw Events" action: these feed both the durable
  // fingerprint coverage confirmation and the automatic P/L/A (now
  // including a genuinely-confirmed Absent) write-through that runs
  // immediately after a successful import -- see
  // attendanceImportAutoApplyService.ts. This is not a second manual
  // confirmation step; it is metadata about the file the administrator is
  // already uploading.
  const [workstationOptions, setWorkstationOptions] = useState<string[]>([]);
  const [selectedWorkstations, setSelectedWorkstations] = useState<string[]>([]);
  const [periodFrom, setPeriodFrom] = useState('');
  const [periodTo, setPeriodTo] = useState('');

  useEffect(() => {
    (async () => {
      const profile = await getCurrentProfile();
      setUserProfile(profile);
      setCanImport(await hasPermission(PERMISSIONS.ATTENDANCE_IMPORT_HIKCENTRAL));
      setPermissionsLoaded(true);
      try {
        setWorkstationOptions(await fetchDistinctWorkstations());
      } catch {
        setWorkstationOptions([]);
      }
    })();
  }, []);

  const resetForNewFile = useCallback(() => {
    setParseResult(null);
    setSummary(null);
    setFileError(null);
    setImportResult(null);
    setAutoApplyResult(null);
    setSelectedWorkstations([]);
    setPeriodFrom('');
    setPeriodTo('');
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
    } catch (err) {
      setFileError(err instanceof HikCentralFileError ? err.message : 'Could not read this file. Please confirm it is a valid .xlsx HikCentral export.');
    } finally {
      setParsing(false);
    }
  }, [resetForNewFile]);

  const canProcessScope = selectedWorkstations.length > 0 && !!periodFrom && !!periodTo && periodFrom <= periodTo;

  const toggleWorkstation = useCallback((ws: string) => {
    setSelectedWorkstations((prev) => (prev.includes(ws) ? prev.filter((w) => w !== ws) : [...prev, ws]));
  }, []);

  const handleImport = useCallback(async () => {
    if (!parseResult || !selectedFile || !userProfile || !canProcessScope) return;
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
      const autoApply = await processHikCentralImportBatch({
        importBatchId: result.batchId,
        workstations: selectedWorkstations,
        periodFromDate: periodFrom,
        periodToDate: periodTo,
        dateFrom: periodFrom,
        dateTo: periodTo,
      });
      setAutoApplyResult(autoApply);

      if (autoApply.success) {
        showNotification(
          `Imported ${result.insertedCount} new raw event(s). Applied ${autoApply.appliedCount} attendance record(s) across ${autoApply.employeeCount} employee(s).`,
          'success'
        );
      } else {
        showNotification(`Raw events were imported, but automatic attendance processing failed: ${autoApply.error || 'unknown error'}`, 'error');
      }
    } finally {
      setImporting(false);
    }
  }, [parseResult, selectedFile, userProfile, canProcessScope, selectedWorkstations, periodFrom, periodTo]);

  const [retrying, setRetrying] = useState(false);

  // Retries ONLY the automatic processing step (not a re-import of raw
  // events -- those are already durably stored) for the same batch and
  // declared scope. Safe to call again at any time, including after more
  // fingerprint events have since arrived for the same period: every
  // underlying write is idempotent (attendance_write_one's own no-op
  // guard), and re-declaring the identical coverage reuses the existing
  // confirmation rather than duplicating it.
  const handleRetryAutoApply = useCallback(async () => {
    if (!importResult?.batchId) return;
    setRetrying(true);
    try {
      const autoApply = await processHikCentralImportBatch({
        importBatchId: importResult.batchId,
        workstations: selectedWorkstations,
        periodFromDate: periodFrom,
        periodToDate: periodTo,
        dateFrom: periodFrom,
        dateTo: periodTo,
      });
      setAutoApplyResult(autoApply);
      if (autoApply.success) {
        showNotification(`Applied ${autoApply.appliedCount} attendance record(s) across ${autoApply.employeeCount} employee(s).`, 'success');
      } else {
        showNotification(`Automatic attendance processing still failed: ${autoApply.error || 'unknown error'}`, 'error');
      }
    } finally {
      setRetrying(false);
    }
  }, [importResult, selectedWorkstations, periodFrom, periodTo]);

  if (!permissionsLoaded) {
    return <div className="p-8 text-center text-slate-400">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="HikCentral Attendance Import"
        subtitle="Upload a HikCentral fingerprint export to preview, import, and automatically apply attendance for the declared period and workstations."
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
              <SummaryStat label="Access Points" value={summary.accessPoints.length} />
            </div>
            {summary.dateRange && (
              <p className="text-xs text-slate-500 mt-4">
                Date range: {new Date(summary.dateRange.earliest).toLocaleString()} &ndash; {new Date(summary.dateRange.latest).toLocaleString()}
              </p>
            )}
            {summary.accessPoints.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {summary.accessPoints.map((ap) => <Badge key={ap} color="gray">{ap}</Badge>)}
              </div>
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
                  What period does this export cover, and which workstation(s) is it from? Both are used immediately after import to automatically calculate and apply Present/Late/Absent to the official Monthly Register for the matching employees -- no separate confirmation step.
                </p>
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
              <div>
                <p className="text-xs font-medium text-slate-600 mb-2">Workstation(s) this export covers</p>
                {workstationOptions.length === 0 ? (
                  <p className="text-xs text-slate-400">No employee workstations found.</p>
                ) : (
                  <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto">
                    {workstationOptions.map((ws) => (
                      <label key={ws} className="flex items-center gap-1.5 text-xs bg-slate-50 border border-slate-200 rounded-full px-3 py-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedWorkstations.includes(ws)}
                          onChange={() => toggleWorkstation(ws)}
                        />
                        {ws}
                      </label>
                    ))}
                  </div>
                )}
                {selectedWorkstations.length === 0 && (
                  <p className="text-xs text-amber-600 mt-2">Select at least one workstation to enable import.</p>
                )}
              </div>
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
            <Card className={`p-6 border ${autoApplyResult.success ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
              <div className="flex items-start gap-3">
                {autoApplyResult.success
                  ? <CheckCircle2 size={20} className="text-emerald-600 shrink-0 mt-0.5" />
                  : <AlertCircle size={20} className="text-red-600 shrink-0 mt-0.5" />}
                <div className="space-y-1 w-full">
                  <p className={`text-sm font-medium ${autoApplyResult.success ? 'text-emerald-800' : 'text-red-800'}`}>
                    {autoApplyResult.success ? 'Attendance calculated and applied automatically' : 'Automatic attendance processing failed'}
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
                    </>
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

function SummaryStat({ label, value, accent }: { label: string; value: number; accent?: 'green' | 'red' | 'amber' }) {
  const colorClass = accent === 'green' ? 'text-emerald-700' : accent === 'red' ? 'text-red-600' : accent === 'amber' ? 'text-amber-600' : 'text-slate-800';
  return (
    <div className="p-3 rounded-lg border border-slate-100">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-xl font-bold mt-1 ${colorClass}`}>{value.toLocaleString()}</p>
    </div>
  );
}
