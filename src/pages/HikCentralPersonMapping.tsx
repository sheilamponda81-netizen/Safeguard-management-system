// HikCentral Attendance MVP -- Phase 2: Person Mapping workflow.
//
// Classifies every identified HikCentral Person No. into Exact Match /
// Needs Review / Mapped / Conflict (see ../utils/hikcentralPersonMapping.ts
// for the pure logic) and lets an authorized human confirm mappings --
// nothing here ever writes a mapping without an explicit confirmation
// action. This page never creates attendance, never touches payroll/
// payments/deductions/employees, and anonymous events are shown only as
// an informational count -- they can never enter this workflow.
import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Fingerprint, UserCheck, AlertTriangle, Search, CheckCircle2, AlertCircle, Users as UsersIcon, RefreshCw,
} from '../utils/icons';
import { Card, Button, Badge, PageHeader, EmptyState, Table, THead, TBody, TR, TH, TD, Modal, Tabs, Input, StatCard } from '../components/ui';
import { hasPermission, PERMISSIONS } from '../utils/permissions';
import { showNotification } from '../utils/clickHandlers';
import {
  profileHikCentralIdentities, classifyHikCentralIdentities, mappedIdentityHasNameDrift,
  ClassifiedIdentity, EmployeeLite, HikCentralIdentityProfile,
} from '../utils/hikcentralPersonMapping';
import {
  fetchIdentifiedRawEvents, fetchAnonymousEventCount, fetchActiveNonDeletedEmployees,
  fetchAllEmployeesById, fetchActiveHikCentralPersonMappings, fetchProfileFullNamesById,
  confirmHikCentralPersonMappings, MappingConfirmationInput,
} from '../utils/hikcentralPersonMappingService';

type TabId = 'exact' | 'needs_review' | 'mapped' | 'conflict';

function displayName(profile: HikCentralIdentityProfile): string {
  if (profile.observedNamePairs.length === 0) return '(no name)';
  const { firstName, lastName } = profile.observedNamePairs[0];
  return [firstName, lastName].filter(Boolean).join(' ') || '(no name)';
}

export default function HikCentralPersonMappingPage() {
  const [canMap, setCanMap] = useState(false);
  const [permissionsLoaded, setPermissionsLoaded] = useState(false);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [identities, setIdentities] = useState<ClassifiedIdentity[]>([]);
  const [anonymousCount, setAnonymousCount] = useState(0);
  const [activeEmployees, setActiveEmployees] = useState<EmployeeLite[]>([]);
  const [employeesById, setEmployeesById] = useState<Map<string, EmployeeLite>>(new Map());
  const [confirmerNamesById, setConfirmerNamesById] = useState<Map<string, string>>(new Map());

  const [activeTab, setActiveTab] = useState<TabId>('exact');
  const [selectedExact, setSelectedExact] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);

  // Shared employee-picker modal, used both for a "needs review" manual
  // search and for a "mapped" correction/remap -- `pickerIsRemap`
  // controls the confirmation copy/match_method only.
  const [pickerFor, setPickerFor] = useState<HikCentralIdentityProfile | null>(null);
  const [pickerIsRemap, setPickerIsRemap] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [rows, anonCount, active, allById, mappings] = await Promise.all([
        fetchIdentifiedRawEvents(),
        fetchAnonymousEventCount(),
        fetchActiveNonDeletedEmployees(),
        fetchAllEmployeesById(),
        fetchActiveHikCentralPersonMappings(),
      ]);
      const profiles = profileHikCentralIdentities(rows);
      const classified = classifyHikCentralIdentities(profiles, active, mappings);
      setIdentities(classified);
      setAnonymousCount(anonCount);
      setActiveEmployees(active);
      setEmployeesById(allById);

      const confirmerIds = mappings.map((m) => m.confirmedBy).filter((id): id is string => !!id);
      setConfirmerNamesById(await fetchProfileFullNamesById(confirmerIds));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load HikCentral Person Mapping data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      setCanMap(await hasPermission(PERMISSIONS.ATTENDANCE_MAP_HIKCENTRAL_PERSONS));
      setPermissionsLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (permissionsLoaded) loadData();
  }, [permissionsLoaded, loadData]);

  const exactMatches = useMemo(() => identities.filter((i) => i.category === 'exact'), [identities]);
  const needsReview = useMemo(() => identities.filter((i) => i.category === 'needs_review'), [identities]);
  const mapped = useMemo(() => identities.filter((i) => i.category === 'mapped'), [identities]);
  const conflicts = useMemo(() => identities.filter((i) => i.category === 'conflict'), [identities]);

  useEffect(() => {
    // Drop any selection that no longer corresponds to a currently-listed
    // exact match (e.g. after a reload following a confirmation).
    setSelectedExact((prev) => {
      const validPersonNos = new Set(exactMatches.map((i) => i.profile.hikcentralPersonNo));
      const next = new Set(Array.from(prev).filter((p) => validPersonNos.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [exactMatches]);

  const toggleSelected = useCallback((personNo: string) => {
    setSelectedExact((prev) => {
      const next = new Set(prev);
      if (next.has(personNo)) next.delete(personNo);
      else next.add(personNo);
      return next;
    });
  }, []);

  const toggleSelectAllExact = useCallback(() => {
    setSelectedExact((prev) =>
      prev.size === exactMatches.length ? new Set() : new Set(exactMatches.map((i) => i.profile.hikcentralPersonNo))
    );
  }, [exactMatches]);

  const handleConfirmSelected = useCallback(async () => {
    const toConfirm = exactMatches.filter((i) => selectedExact.has(i.profile.hikcentralPersonNo));
    if (toConfirm.length === 0) return;
    setConfirming(true);
    try {
      const payload: MappingConfirmationInput[] = toConfirm.map((i) => ({
        hikcentralPersonNo: i.profile.hikcentralPersonNo,
        employeeId: i.matchedEmployee!.id,
        matchMethod: 'suggested_name',
      }));
      const result = await confirmHikCentralPersonMappings(payload);
      if (result.success) {
        showNotification(
          `Confirmed ${result.confirmedCount} mapping(s).${result.alreadyMappedCount ? ` ${result.alreadyMappedCount} were already mapped.` : ''}`,
          'success'
        );
        setSelectedExact(new Set());
        await loadData();
      } else {
        showNotification(result.error || 'Could not confirm mappings.', 'error');
      }
    } finally {
      setConfirming(false);
    }
  }, [exactMatches, selectedExact, loadData]);

  const confirmOne = useCallback(
    async (personNo: string, employeeId: string, matchMethod: 'manual' | 'suggested_name', successMessage: string) => {
      setConfirming(true);
      try {
        const result = await confirmHikCentralPersonMappings([{ hikcentralPersonNo: personNo, employeeId, matchMethod }]);
        if (result.success) {
          showNotification(successMessage, 'success');
          setPickerFor(null);
          setPickerQuery('');
          await loadData();
        } else {
          showNotification(result.error || 'Could not confirm mapping.', 'error');
        }
      } finally {
        setConfirming(false);
      }
    },
    [loadData]
  );

  const handlePickEmployee = useCallback(
    (employeeId: string, matchMethod: 'manual' | 'suggested_name') => {
      if (!pickerFor) return;
      void confirmOne(pickerFor.hikcentralPersonNo, employeeId, matchMethod, pickerIsRemap ? 'Mapping updated.' : 'Mapping confirmed.');
    },
    [pickerFor, pickerIsRemap, confirmOne]
  );

  const handlePickSuggestion = useCallback(
    (personNo: string, employeeId: string) => {
      void confirmOne(personNo, employeeId, 'suggested_name', 'Mapping confirmed.');
    },
    [confirmOne]
  );

  const pickerResults = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    const pool = q === '' ? activeEmployees : activeEmployees.filter(
      (e) => e.fullName.toLowerCase().includes(q) || e.employeeNumber.toLowerCase().includes(q)
    );
    return pool.slice(0, 25);
  }, [pickerQuery, activeEmployees]);

  if (!permissionsLoaded || loading) {
    return <div className="p-8 text-center text-slate-400">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="HikCentral Person Mapping"
        subtitle="Review and confirm which Safeguard employee each HikCentral fingerprint identity belongs to. This does not create attendance, payroll, or deductions."
        actions={<Button variant="outline" onClick={loadData}><RefreshCw size={14} /> Refresh</Button>}
      />

      {!canMap && (
        <Card className="p-4 bg-amber-50 border-amber-200 border">
          <div className="flex items-start gap-3">
            <AlertCircle size={18} className="text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-amber-800">View Only</p>
              <p className="text-sm text-amber-700">You can review identities, but you do not have permission to confirm mappings.</p>
            </div>
          </div>
        </Card>
      )}

      {loadError && (
        <Card className="p-4 bg-red-50 border-red-200 border">
          <p className="text-sm text-red-700">{loadError}</p>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard title="HikCentral identities" value={identities.length.toLocaleString()} icon={Fingerprint} accent="navy" />
        <StatCard title="Exact matches ready" value={exactMatches.length.toLocaleString()} icon={CheckCircle2} accent="green" />
        <StatCard title="Need review" value={needsReview.length.toLocaleString()} icon={Search} accent="gold" />
        <StatCard title="Mapped" value={mapped.length.toLocaleString()} icon={UserCheck} accent="blue" />
      </div>

      <Card className="p-4 bg-slate-50 border-slate-200 border">
        <p className="text-sm text-slate-600 flex items-center gap-2">
          <UsersIcon size={16} className="text-slate-400" />
          {anonymousCount.toLocaleString()} anonymous successful event(s) have no Person No. and cannot be mapped to an employee -- shown here for context only.
        </p>
      </Card>

      {conflicts.length > 0 && (
        <Card className="p-4 bg-red-50 border-red-200 border">
          <p className="text-sm font-medium text-red-800 flex items-center gap-2">
            <AlertTriangle size={16} /> {conflicts.length} Person No.{conflicts.length === 1 ? '' : 's'} blocked by conflicting names -- see the Conflicts tab.
          </p>
        </Card>
      )}

      <Tabs
        tabs={[
          { id: 'exact', label: `Exact Matches (${exactMatches.length})`, icon: CheckCircle2 },
          { id: 'needs_review', label: `Needs Review (${needsReview.length})`, icon: Search },
          { id: 'mapped', label: `Mapped (${mapped.length})`, icon: UserCheck },
          { id: 'conflict', label: `Conflicts (${conflicts.length})`, icon: AlertTriangle },
        ]}
        active={activeTab}
        onChange={(id) => setActiveTab(id as TabId)}
      />

      {activeTab === 'exact' && (
        exactMatches.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="No exact matches pending" description="Every identity with a single, exact, active-employee name match has already been mapped or there are none right now." />
        ) : (
          <div className="space-y-3">
            {canMap && (
              <div className="flex items-center justify-between">
                <p className="text-sm text-slate-600">{selectedExact.size} of {exactMatches.length} selected</p>
                <Button onClick={handleConfirmSelected} disabled={confirming || selectedExact.size === 0}>
                  {confirming ? 'Confirming...' : `Confirm Selected Matches (${selectedExact.size})`}
                </Button>
              </div>
            )}
            <Table>
              <THead>
                <TR hover={false}>
                  {canMap && (
                    <TH>
                      <input
                        type="checkbox"
                        aria-label="Select all exact matches"
                        checked={selectedExact.size === exactMatches.length && exactMatches.length > 0}
                        onChange={toggleSelectAllExact}
                      />
                    </TH>
                  )}
                  <TH>HikCentral Name</TH>
                  <TH>Person No.</TH>
                  <TH>Access Point</TH>
                  <TH>Events</TH>
                  <TH>Proposed Employee</TH>
                  <TH>Employee #</TH>
                  <TH>Workstation</TH>
                </TR>
              </THead>
              <TBody>
                {exactMatches.map((i) => (
                  <TR key={i.profile.hikcentralPersonNo}>
                    {canMap && (
                      <TD>
                        <input
                          type="checkbox"
                          aria-label={`Select Person No ${i.profile.hikcentralPersonNo}`}
                          checked={selectedExact.has(i.profile.hikcentralPersonNo)}
                          onChange={() => toggleSelected(i.profile.hikcentralPersonNo)}
                        />
                      </TD>
                    )}
                    <TD>{displayName(i.profile)}</TD>
                    <TD className="font-mono">{i.profile.hikcentralPersonNo}</TD>
                    <TD><Badge color="gray">{i.profile.accessPoints.join(', ') || '—'}</Badge></TD>
                    <TD>{i.profile.eventCount}</TD>
                    <TD className="font-medium text-slate-800">{i.matchedEmployee?.fullName}</TD>
                    <TD>{i.matchedEmployee?.employeeNumber}</TD>
                    <TD>{i.matchedEmployee?.workstation || '—'}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )
      )}

      {activeTab === 'needs_review' && (
        needsReview.length === 0 ? (
          <EmptyState icon={Search} title="Nothing needs review" description="Every remaining identity is either already mapped, an exact match, or blocked as a conflict." />
        ) : (
          <div className="space-y-3">
            {needsReview.map((i) => (
              <Card key={i.profile.hikcentralPersonNo} className="p-5">
                <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                  <div>
                    <p className="font-semibold text-slate-800">{displayName(i.profile)}</p>
                    <p className="text-xs text-slate-500 font-mono mt-0.5">Person No. {i.profile.hikcentralPersonNo}</p>
                    <p className="text-xs text-slate-500 mt-1">
                      {i.profile.eventCount} event(s) &middot; <Badge color="gray" className="ml-1">{i.profile.accessPoints.join(', ') || '—'}</Badge>
                    </p>
                  </div>
                  {canMap && (
                    <Button variant="outline" size="sm" onClick={() => { setPickerFor(i.profile); setPickerIsRemap(false); setPickerQuery(''); }}>
                      <Search size={14} /> Search Employee
                    </Button>
                  )}
                </div>
                {i.suggestions.length > 0 ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {i.suggestions.map((s) => (
                      <button
                        key={s.employee.id}
                        type="button"
                        disabled={!canMap || confirming}
                        onClick={() => handlePickSuggestion(i.profile.hikcentralPersonNo, s.employee.id)}
                        className="text-left p-3 rounded-lg border border-slate-200 hover:border-[#081C3A]/40 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        <span className="block text-sm font-medium text-slate-800">{s.employee.fullName}</span>
                        <span className="block text-xs text-slate-500">{s.employee.employeeNumber} &middot; {s.employee.workstation || '—'}</span>
                        <Badge color={s.label === 'Exact name' ? 'green' : 'gold'} className="mt-1">{s.label}</Badge>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-400 mt-3">No strong suggestion found -- use Search Employee above.</p>
                )}
              </Card>
            ))}
          </div>
        )
      )}

      {activeTab === 'mapped' && (
        mapped.length === 0 ? (
          <EmptyState icon={UserCheck} title="No confirmed mappings yet" description="Mappings you confirm from the Exact Matches or Needs Review tabs will appear here." />
        ) : (
          <Table>
            <THead>
              <TR hover={false}>
                <TH>Person No.</TH>
                <TH>HikCentral Name</TH>
                <TH>Mapped Employee</TH>
                <TH>Employee #</TH>
                <TH>Match Method</TH>
                <TH>Confirmed</TH>
                <TH>Confirmed By</TH>
                {canMap && <TH>Action</TH>}
              </TR>
            </THead>
            <TBody>
              {mapped.map((i) => {
                const driftWarning = mappedIdentityHasNameDrift(i.profile);
                return (
                  <TR key={i.profile.hikcentralPersonNo}>
                    <TD className="font-mono">{i.profile.hikcentralPersonNo}</TD>
                    <TD>
                      {displayName(i.profile)}
                      {driftWarning && (
                        <Badge color="red" className="ml-2">
                          <AlertTriangle size={11} className="inline mr-1" /> Name conflict since mapped
                        </Badge>
                      )}
                    </TD>
                    <TD className="font-medium text-slate-800">{employeesById.get(i.activeMapping!.employeeId)?.fullName || '(employee no longer visible)'}</TD>
                    <TD>{employeesById.get(i.activeMapping!.employeeId)?.employeeNumber || '—'}</TD>
                    <TD><Badge color="gray">{i.activeMapping!.matchMethod}</Badge></TD>
                    <TD>{i.activeMapping!.confirmedAt ? new Date(i.activeMapping!.confirmedAt as string).toLocaleDateString() : '—'}</TD>
                    <TD>{(i.activeMapping!.confirmedBy && confirmerNamesById.get(i.activeMapping!.confirmedBy)) || '—'}</TD>
                    {canMap && (
                      <TD>
                        <Button variant="outline" size="sm" onClick={() => { setPickerFor(i.profile); setPickerIsRemap(true); setPickerQuery(''); }}>
                          Change
                        </Button>
                      </TD>
                    )}
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )
      )}

      {activeTab === 'conflict' && (
        conflicts.length === 0 ? (
          <EmptyState icon={AlertTriangle} title="No conflicts" description="No Person No. currently has more than one conflicting name in the raw data." />
        ) : (
          <Table>
            <THead>
              <TR hover={false}>
                <TH>Person No.</TH>
                <TH>Conflicting Names</TH>
                <TH>Access Point</TH>
                <TH>Events</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {conflicts.map((i) => (
                <TR key={i.profile.hikcentralPersonNo}>
                  <TD className="font-mono">{i.profile.hikcentralPersonNo}</TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      {i.profile.observedNamePairs.map((n, idx) => (
                        <Badge key={idx} color="red">{[n.firstName, n.lastName].filter(Boolean).join(' ')}</Badge>
                      ))}
                    </div>
                  </TD>
                  <TD><Badge color="gray">{i.profile.accessPoints.join(', ') || '—'}</Badge></TD>
                  <TD>{i.profile.eventCount}</TD>
                  <TD className="text-xs text-red-600">Blocked until resolved</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )
      )}

      <Modal
        open={!!pickerFor}
        onClose={() => { setPickerFor(null); setPickerQuery(''); }}
        title={pickerIsRemap ? `Change mapping for Person No. ${pickerFor?.hikcentralPersonNo}` : `Select employee for Person No. ${pickerFor?.hikcentralPersonNo}`}
        size="md"
      >
        <div className="space-y-4">
          {pickerIsRemap && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
              This will supersede the current active mapping. The previous mapping is preserved as history, not deleted.
            </p>
          )}
          <Input
            icon={Search}
            placeholder="Search by name or employee number..."
            value={pickerQuery}
            onChange={(e) => setPickerQuery(e.target.value)}
          />
          <div className="max-h-80 overflow-y-auto divide-y divide-slate-100">
            {pickerResults.length === 0 && (
              <p className="text-sm text-slate-400 text-center py-6">No matching employees.</p>
            )}
            {pickerResults.map((e) => (
              <button
                key={e.id}
                type="button"
                disabled={confirming}
                onClick={() => handlePickEmployee(e.id, 'manual')}
                className="w-full text-left py-3 px-2 hover:bg-slate-50 rounded-lg transition-colors disabled:opacity-60"
              >
                <span className="block text-sm font-medium text-slate-800">{e.fullName}</span>
                <span className="block text-xs text-slate-500">{e.employeeNumber} &middot; {e.workstation || '—'}</span>
              </button>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  );
}
