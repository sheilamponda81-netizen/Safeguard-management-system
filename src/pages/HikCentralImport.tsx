// HikCentral Attendance MVP -- Phase 1: Excel preview/raw-event import.
//
// Scope deliberately narrow (per the approved Phase 1 plan): select a
// file, parse it locally, show a validation/preview summary, and -- if
// the caller has permission -- confirm a raw-event import. This page
// NEVER writes to `attendance`, never implies attendance has changed,
// and has no person-mapping UI (the schema/RPC already support Phase 2
// mapping without redesign; a mapping screen is explicitly out of scope
// here to avoid materially growing this PR).
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

  useEffect(() => {
    (async () => {
      const profile = await getCurrentProfile();
      setUserProfile(profile);
      setCanImport(await hasPermission(PERMISSIONS.ATTENDANCE_IMPORT_HIKCENTRAL));
      setPermissionsLoaded(true);
    })();
  }, []);

  const resetForNewFile = useCallback(() => {
    setParseResult(null);
    setSummary(null);
    setFileError(null);
    setImportResult(null);
  }, []);

  const handleFileSelect = useCallback(async (file: File) => {
    resetForNewFile();
    setSelectedFile(file);
    setParsing(true);
    try {
      const result = await parseHikCentralExcelFile(file);
      setParseResult(result);
      setSummary(summarizeHikCentralParseResult(result));
    } catch (err) {
      setFileError(err instanceof HikCentralFileError ? err.message : 'Could not read this file. Please confirm it is a valid .xlsx HikCentral export.');
    } finally {
      setParsing(false);
    }
  }, [resetForNewFile]);

  const handleImport = useCallback(async () => {
    if (!parseResult || !selectedFile || !userProfile) return;
    setImporting(true);
    try {
      const fileFingerprint = await computeFileFingerprint(selectedFile);
      const result = await importHikCentralRawEvents(selectedFile.name, fileFingerprint, parseResult, userProfile.tenant_id);
      setImportResult(result);
      if (result.success) {
        showNotification(`Imported ${result.insertedCount} new raw event(s). ${result.duplicatesIgnored} exact duplicate(s) ignored.`, 'success');
      } else {
        showNotification(result.error || 'Could not import HikCentral events.', 'error');
      }
    } finally {
      setImporting(false);
    }
  }, [parseResult, selectedFile, userProfile]);

  if (!permissionsLoaded) {
    return <div className="p-8 text-center text-slate-400">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="HikCentral Attendance Import"
        subtitle="Upload a HikCentral fingerprint export to preview and import raw authentication events. This does not change official attendance."
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
            <Card className="p-6 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-800">Ready to import raw events</p>
                <p className="text-xs text-slate-500 mt-1">
                  {summary.authorizationCount} successful event(s) will be stored as raw events. Failed events are counted above but not individually stored. No attendance records are created by this step.
                </p>
              </div>
              <Button onClick={handleImport} disabled={importing || summary.authorizationCount === 0}>
                {importing ? 'Importing...' : 'Import Raw Events'}
              </Button>
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
                      <p className="text-xs text-emerald-600">No attendance records were created or changed.</p>
                    </>
                  ) : (
                    <p className="text-sm text-red-700">{importResult.error}</p>
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
