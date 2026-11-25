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
import {
  fetchEmployeeTerminalAssignments, setEmployeeHikCentralTerminals,
  fetchMappedEmployeeTerminalStatus, setSiteHikCentralTerminals,
  fetchSiteHikCentralTerminalConfigs, normalizeSiteKey, setFingerprintAttendanceEnabled,
  setTerminalNetworkMembers, setSiteNetworkMembership, fetchTerminalNetworkConfigs, fetchSiteNetworkMemberships,
  MappedEmployeeTerminalStatus,
} from '../utils/attendanceImportAutoApplyService';

type TabId = 'exact' | 'needs_review' | 'mapped' | 'conflict';

function displayName(profile: HikCentralIdentityProfile): string {
  if (profile.observedNamePairs.length === 0) return '(no name)';
  const { firstName, lastName } = profile.observedNamePairs[0];
  return [firstName, lastName].filter(Boolean).join(' ') || '(no name)';
}

// Step 11F: one search predicate reused across all four tabs -- matches
// on the Safeguard employee's name/number (via matchedEmployee, which is
// already populated for 'exact' and 'mapped' categories, or via Needs
// Review's own candidate suggestions), the HikCentral name (every
// observed name variant, not just the first -- relevant for Conflicts),
// and the HikCentral Person No. Case-insensitive, partial match.
// `query` is expected pre-trimmed and lower-cased by the caller.
function identityMatchesSearch(identity: ClassifiedIdentity, query: string): boolean {
  if (!query) return true;
  if (identity.profile.hikcentralPersonNo.toLowerCase().includes(query)) return true;
  if (identity.profile.observedNamePairs.some(
    (n) => [n.firstName, n.lastName].filter(Boolean).join(' ').toLowerCase().includes(query)
  )) return true;
  if (identity.matchedEmployee && (
    identity.matchedEmployee.fullName.toLowerCase().includes(query)
    || identity.matchedEmployee.employeeNumber.toLowerCase().includes(query)
  )) return true;
  if (identity.suggestions.some(
    (s) => s.employee.fullName.toLowerCase().includes(query) || s.employee.employeeNumber.toLowerCase().includes(query)
  )) return true;
  return false;
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

  // Stage C Step 11: each mapped employee's own assigned HikCentral
  // terminal(s) -- independent of employees.workstation, since Safeguard
  // has many workstations but only a handful of central terminals.
  // Loaded alongside everything else; an employee absent from this map
  // has no assigned terminal and can never resolve Absent until one is
  // configured here.
  const [terminalAssignments, setTerminalAssignments] = useState<Map<string, string[]>>(new Map());
  const [terminalModalFor, setTerminalModalFor] = useState<ClassifiedIdentity | null>(null);
  const [terminalModalSelected, setTerminalModalSelected] = useState<Set<string>>(new Set());
  const [terminalModalCustom, setTerminalModalCustom] = useState('');
  const [savingTerminals, setSavingTerminals] = useState(false);

  // Automatic fingerprint terminal resolution: each mapped employee's
  // resolved eligibility -- own assignment, the shared site-level
  // fallback, not yet explicitly enabled, or a genuine gap. Drives the
  // honest status text in the Mapped tab (Part 5) -- never shows
  // "configured" when eligibility is actually unresolved.
  const [terminalStatusByEmployee, setTerminalStatusByEmployee] = useState<Map<string, MappedEmployeeTerminalStatus>>(new Map());
  const [enablingEmployeeIds, setEnablingEmployeeIds] = useState<Set<string>>(new Set());
  // A separate, minimal site-level configuration modal -- same shape
  // as the per-employee one, but keyed by site (employees.workstation)
  // instead of one identity. Configuring a site once covers every
  // employee at that site, including future hires, with no further
  // per-employee action.
  const [siteModalFor, setSiteModalFor] = useState<string | null>(null);
  const [siteModalSelected, setSiteModalSelected] = useState<Set<string>>(new Set());
  const [siteModalCustom, setSiteModalCustom] = useState('');
  const [savingSiteTerminals, setSavingSiteTerminals] = useState(false);
  const [siteConfigs, setSiteConfigs] = useState<Map<string, string[]>>(new Map());

  // Shared fingerprint terminal networks (Part 4 simplification): a
  // named, reusable terminal list many sites can join at once, kept in
  // a collapsed "Advanced" section -- normal users never need to see
  // this to use Person Mapping day to day.
  const [networkConfigs, setNetworkConfigs] = useState<Map<string, string[]>>(new Map());
  const [siteNetworkMemberships, setSiteNetworkMemberships] = useState<Map<string, string>>(new Map());
  const [networkModalFor, setNetworkModalFor] = useState<string | null>(null);
  const [networkModalIsNew, setNetworkModalIsNew] = useState(false);
  const [networkNameInput, setNetworkNameInput] = useState('');
  const [networkModalSelected, setNetworkModalSelected] = useState<Set<string>>(new Set());
  const [networkModalCustom, setNetworkModalCustom] = useState('');
  const [savingNetworkTerminals, setSavingNetworkTerminals] = useState(false);
  const [assignSitesInput, setAssignSitesInput] = useState('');
  const [assignNetworkInput, setAssignNetworkInput] = useState('');
  const [assigningSites, setAssigningSites] = useState(false);

  const [activeTab, setActiveTab] = useState<TabId>('exact');

  // Step 11F: a single search box shared by all four tabs -- its text is
  // never reset on tab switch (it simply isn't tied to activeTab at all).
  // searchInput updates the input instantly for responsiveness;
  // debouncedSearch (what filtering actually uses) lags by 150ms so that
  // re-filtering thousands of rows never runs on every keystroke.
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(searchInput.trim().toLowerCase()), 150);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const [selectedExact, setSelectedExact] = useState<Set<string>>(new Set());
  const [selectedStrongReview, setSelectedStrongReview] = useState<Set<string>>(new Set());
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
      const [rows, anonCount, active, allById, mappings, terminals, terminalStatus, siteConfigsResult, networkConfigsResult, siteNetworkMembershipsResult] = await Promise.all([
        fetchIdentifiedRawEvents(),
        fetchAnonymousEventCount(),
        fetchActiveNonDeletedEmployees(),
        fetchAllEmployeesById(),
        fetchActiveHikCentralPersonMappings(),
        fetchEmployeeTerminalAssignments().catch(() => new Map<string, string[]>()),
        fetchMappedEmployeeTerminalStatus().catch(() => new Map<string, MappedEmployeeTerminalStatus>()),
        fetchSiteHikCentralTerminalConfigs().catch(() => new Map<string, string[]>()),
        fetchTerminalNetworkConfigs().catch(() => new Map<string, string[]>()),
        fetchSiteNetworkMemberships().catch(() => new Map<string, string>()),
      ]);
      const profiles = profileHikCentralIdentities(rows);
      const classified = classifyHikCentralIdentities(profiles, active, mappings);
      setIdentities(classified);
      setAnonymousCount(anonCount);
      setActiveEmployees(active);
      setEmployeesById(allById);
      setTerminalAssignments(terminals);
      setTerminalStatusByEmployee(terminalStatus);
      setSiteConfigs(siteConfigsResult);
      setNetworkConfigs(networkConfigsResult);
      setSiteNetworkMemberships(siteNetworkMembershipsResult);

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

  // Part 4 simplification: one plain-language summary of fingerprint
  // readiness across every mapped employee -- "Total mapped" and
  // "Needs mapping" already exist as StatCards; this adds the
  // fingerprint-specific breakdown without requiring a normal user to
  // open the Advanced section or understand provenance at all.
  const fingerprintStatusSummary = useMemo(() => {
    let ready = 0;
    let needsActivation = 0;
    let needsSetup = 0;
    for (const identity of identities) {
      if (identity.category !== 'mapped') continue;
      const employeeId = identity.activeMapping?.employeeId;
      const provenance = employeeId ? terminalStatusByEmployee.get(employeeId)?.provenance : undefined;
      if (provenance === 'employee_assigned' || provenance === 'site_shared') ready += 1;
      else if (provenance === 'fingerprint_not_enabled') needsActivation += 1;
      else needsSetup += 1;
    }
    return { ready, needsActivation, needsSetup };
  }, [identities, terminalStatusByEmployee]);

  const exactMatches = useMemo(() => identities.filter((i) => i.category === 'exact'), [identities]);
  const needsReview = useMemo(() => identities.filter((i) => i.category === 'needs_review'), [identities]);
  const mapped = useMemo(() => identities.filter((i) => i.category === 'mapped'), [identities]);
  const conflicts = useMemo(() => identities.filter((i) => i.category === 'conflict'), [identities]);

  // Needs Review identities whose TOP suggestion clears the "Strong
  // suggestion" bar -- see suggestEmployeesForIdentity()'s classification
  // in hikcentralPersonMapping.ts for the multi-signal rules (name
  // similarity, token-order-independent alignment, minimum evidence, and a
  // separation/margin check against the next-best candidate). At most one
  // suggestion per identity can ever be "Strong", so the employee to
  // confirm for bulk purposes is always suggestions[0].
  const strongReviewIdentities = useMemo(
    () => needsReview.filter((i) => i.suggestions[0]?.label === 'Strong suggestion'),
    [needsReview]
  );

  // Step 11F: search only narrows which rows are RENDERED in the
  // currently active tab -- bulk-select/confirm actions below still
  // operate on the full, unfiltered exactMatches/needsReview/
  // strongReviewIdentities arrays exactly as before, so an existing
  // selection is never silently affected by typing a search query.
  const filteredExactMatches = useMemo(
    () => (debouncedSearch ? exactMatches.filter((i) => identityMatchesSearch(i, debouncedSearch)) : exactMatches),
    [exactMatches, debouncedSearch]
  );
  const filteredNeedsReview = useMemo(
    () => (debouncedSearch ? needsReview.filter((i) => identityMatchesSearch(i, debouncedSearch)) : needsReview),
    [needsReview, debouncedSearch]
  );
  const filteredMapped = useMemo(
    () => (debouncedSearch ? mapped.filter((i) => identityMatchesSearch(i, debouncedSearch)) : mapped),
    [mapped, debouncedSearch]
  );
  const filteredConflicts = useMemo(
    () => (debouncedSearch ? conflicts.filter((i) => identityMatchesSearch(i, debouncedSearch)) : conflicts),
    [conflicts, debouncedSearch]
  );

  useEffect(() => {
    // Drop any selection that no longer corresponds to a currently-listed
    // exact match (e.g. after a reload following a confirmation).
    setSelectedExact((prev) => {
      const validPersonNos = new Set(exactMatches.map((i) => i.profile.hikcentralPersonNo));
      const next = new Set(Array.from(prev).filter((p) => validPersonNos.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [exactMatches]);

  useEffect(() => {
    // Same pruning for strong-suggestion selections -- a confirmation,
    // reload, or a suggestion that no longer clears the Strong bar must
    // never leave a stale selection sitting in the bulk-confirm set.
    setSelectedStrongReview((prev) => {
      const validPersonNos = new Set(strongReviewIdentities.map((i) => i.profile.hikcentralPersonNo));
      const next = new Set(Array.from(prev).filter((p) => validPersonNos.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [strongReviewIdentities]);

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

  const toggleStrongReviewSelected = useCallback((personNo: string) => {
    setSelectedStrongReview((prev) => {
      const next = new Set(prev);
      if (next.has(personNo)) next.delete(personNo);
      else next.add(personNo);
      return next;
    });
  }, []);

  const toggleSelectAllStrongReview = useCallback(() => {
    setSelectedStrongReview((prev) =>
      prev.size === strongReviewIdentities.length
        ? new Set()
        : new Set(strongReviewIdentities.map((i) => i.profile.hikcentralPersonNo))
    );
  }, [strongReviewIdentities]);

  const handleConfirmSelectedStrongReview = useCallback(async () => {
    const toConfirm = strongReviewIdentities.filter((i) => selectedStrongReview.has(i.profile.hikcentralPersonNo));
    if (toConfirm.length === 0) return;
    setConfirming(true);
    try {
      const payload: MappingConfirmationInput[] = toConfirm.map((i) => ({
        hikcentralPersonNo: i.profile.hikcentralPersonNo,
        employeeId: i.suggestions[0].employee.id,
        matchMethod: 'suggested_name',
      }));
      const result = await confirmHikCentralPersonMappings(payload);
      if (result.success) {
        showNotification(
          `Confirmed ${result.confirmedCount} mapping(s).${result.alreadyMappedCount ? ` ${result.alreadyMappedCount} were already mapped.` : ''}`,
          'success'
        );
        setSelectedStrongReview(new Set());
        await loadData();
      } else {
        showNotification(result.error || 'Could not confirm mappings.', 'error');
      }
    } finally {
      setConfirming(false);
    }
  }, [strongReviewIdentities, selectedStrongReview, loadData]);

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

  // Stage C Step 11: opens the compact terminal-assignment modal for one
  // mapped identity, pre-populated with whatever is currently assigned
  // (even if it no longer appears among this identity's own observed
  // access points -- e.g. a terminal that has since gone quiet -- so an
  // existing assignment is never silently dropped just by opening this).
  const openTerminalModal = useCallback((identity: ClassifiedIdentity) => {
    const employeeId = identity.activeMapping?.employeeId;
    const current = employeeId ? terminalAssignments.get(employeeId) || [] : [];
    setTerminalModalFor(identity);
    setTerminalModalSelected(new Set(current));
    setTerminalModalCustom('');
  }, [terminalAssignments]);

  const terminalModalCandidates = useMemo(() => {
    if (!terminalModalFor) return [];
    const employeeId = terminalModalFor.activeMapping?.employeeId;
    const current = employeeId ? terminalAssignments.get(employeeId) || [] : [];
    return Array.from(new Set([...terminalModalFor.profile.accessPoints, ...current])).sort();
  }, [terminalModalFor, terminalAssignments]);

  const toggleTerminalCandidate = useCallback((ap: string) => {
    setTerminalModalSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ap)) next.delete(ap);
      else next.add(ap);
      return next;
    });
  }, []);

  const handleAddCustomTerminal = useCallback(() => {
    const ap = terminalModalCustom.trim();
    if (!ap) return;
    setTerminalModalSelected((prev) => new Set(prev).add(ap));
    setTerminalModalCustom('');
  }, [terminalModalCustom]);

  const handleSaveTerminals = useCallback(async () => {
    const employeeId = terminalModalFor?.activeMapping?.employeeId;
    if (!employeeId) return;
    setSavingTerminals(true);
    try {
      await setEmployeeHikCentralTerminals(employeeId, Array.from(terminalModalSelected));
      showNotification('Terminal assignment updated.', 'success');
      setTerminalModalFor(null);
      await loadData();
    } catch (err) {
      showNotification(err instanceof Error ? err.message : 'Could not update terminal assignment.', 'error');
    } finally {
      setSavingTerminals(false);
    }
  }, [terminalModalFor, terminalModalSelected, loadData]);

  // Automatic fingerprint terminal resolution: every distinct,
  // normalized workstation among currently mapped employees -- the
  // candidate list for "which site needs its shared terminal(s)
  // configured", alongside whether each already has a configuration
  // and how many currently-mapped employees it covers.
  const siteSummaries = useMemo(() => {
    const bySite = new Map<string, { rawSite: string; mappedEmployeeCount: number; observedAccessPoints: Set<string>; notEnabledEmployeeIds: string[] }>();
    for (const identity of identities) {
      if (identity.category !== 'mapped') continue;
      const employeeId = identity.activeMapping?.employeeId;
      const employee = employeeId ? employeesById.get(employeeId) : null;
      const rawSite = employee?.workstation?.trim();
      if (!rawSite || !employeeId) continue;
      const key = normalizeSiteKey(rawSite);
      const notEnabled = terminalStatusByEmployee.get(employeeId)?.provenance === 'fingerprint_not_enabled';
      const existing = bySite.get(key);
      if (existing) {
        existing.mappedEmployeeCount += 1;
        identity.profile.accessPoints.forEach((ap) => existing.observedAccessPoints.add(ap));
        if (notEnabled) existing.notEnabledEmployeeIds.push(employeeId);
      } else {
        bySite.set(key, { rawSite, mappedEmployeeCount: 1, observedAccessPoints: new Set(identity.profile.accessPoints), notEnabledEmployeeIds: notEnabled ? [employeeId] : [] });
      }
    }
    return Array.from(bySite.entries())
      .map(([key, v]) => ({
        key,
        rawSite: v.rawSite,
        mappedEmployeeCount: v.mappedEmployeeCount,
        observedAccessPoints: Array.from(v.observedAccessPoints).sort(),
        configuredAccessPoints: siteConfigs.get(key) || [],
        notEnabledEmployeeIds: v.notEnabledEmployeeIds,
      }))
      .sort((a, b) => a.rawSite.localeCompare(b.rawSite));
  }, [identities, employeesById, siteConfigs, terminalStatusByEmployee]);

  const openSiteModal = useCallback((siteKey: string) => {
    const current = siteConfigs.get(siteKey) || [];
    setSiteModalFor(siteKey);
    setSiteModalSelected(new Set(current));
    setSiteModalCustom('');
  }, [siteConfigs]);

  const siteModalCandidates = useMemo(() => {
    if (!siteModalFor) return [];
    const summary = siteSummaries.find((s) => s.key === siteModalFor);
    const current = siteConfigs.get(siteModalFor) || [];
    return Array.from(new Set([...(summary?.observedAccessPoints || []), ...current])).sort();
  }, [siteModalFor, siteSummaries, siteConfigs]);

  const toggleSiteCandidate = useCallback((ap: string) => {
    setSiteModalSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ap)) next.delete(ap);
      else next.add(ap);
      return next;
    });
  }, []);

  const handleAddCustomSiteTerminal = useCallback(() => {
    const ap = siteModalCustom.trim();
    if (!ap) return;
    setSiteModalSelected((prev) => new Set(prev).add(ap));
    setSiteModalCustom('');
  }, [siteModalCustom]);

  const handleSaveSiteTerminals = useCallback(async () => {
    if (!siteModalFor) return;
    setSavingSiteTerminals(true);
    try {
      await setSiteHikCentralTerminals(siteModalFor, Array.from(siteModalSelected));
      showNotification('Shared site terminal configuration updated.', 'success');
      setSiteModalFor(null);
      await loadData();
    } catch (err) {
      showNotification(err instanceof Error ? err.message : 'Could not update the site terminal configuration.', 'error');
    } finally {
      setSavingSiteTerminals(false);
    }
  }, [siteModalFor, siteModalSelected, loadData]);

  // Shared fingerprint terminal networks: for each registered network,
  // which sites joined it, how many currently-mapped employees that
  // covers, and how many of them still need the one-time explicit
  // enable action -- drives the collapsed "Advanced" section so a
  // whole network (e.g. Lilongwe's KANENGO/MASM/OCEAN/Office World) can
  // be reviewed and activated as a single unit, never per-workstation.
  const networkSummaries = useMemo(() => {
    const siteToNetwork = siteNetworkMemberships;
    const byNetwork = new Map<string, { sites: Set<string>; mappedEmployeeCount: number; notEnabledEmployeeIds: string[] }>();
    for (const identity of identities) {
      if (identity.category !== 'mapped') continue;
      const employeeId = identity.activeMapping?.employeeId;
      const employee = employeeId ? employeesById.get(employeeId) : null;
      const rawSite = employee?.workstation?.trim();
      if (!rawSite || !employeeId) continue;
      const key = normalizeSiteKey(rawSite);
      const network = siteToNetwork.get(key);
      if (!network) continue;
      const notEnabled = terminalStatusByEmployee.get(employeeId)?.provenance === 'fingerprint_not_enabled';
      const existing = byNetwork.get(network);
      if (existing) {
        existing.sites.add(key);
        existing.mappedEmployeeCount += 1;
        if (notEnabled) existing.notEnabledEmployeeIds.push(employeeId);
      } else {
        byNetwork.set(network, { sites: new Set([key]), mappedEmployeeCount: 1, notEnabledEmployeeIds: notEnabled ? [employeeId] : [] });
      }
    }
    // Every registered network appears even with zero sites/employees yet, so a freshly-configured network is still visible for the next rollout step.
    for (const network of networkConfigs.keys()) {
      if (!byNetwork.has(network)) byNetwork.set(network, { sites: new Set(), mappedEmployeeCount: 0, notEnabledEmployeeIds: [] });
    }
    return Array.from(byNetwork.entries())
      .map(([network, v]) => ({
        network,
        sites: Array.from(v.sites).sort(),
        mappedEmployeeCount: v.mappedEmployeeCount,
        notEnabledEmployeeIds: v.notEnabledEmployeeIds,
        configuredAccessPoints: networkConfigs.get(network) || [],
      }))
      .sort((a, b) => a.network.localeCompare(b.network));
  }, [identities, employeesById, siteNetworkMemberships, networkConfigs, terminalStatusByEmployee]);

  const openNetworkModal = useCallback((network: string | null) => {
    const key = network ? normalizeSiteKey(network) : null;
    const current = key ? networkConfigs.get(key) || [] : [];
    setNetworkModalFor(key ?? '__NEW_NETWORK__');
    setNetworkModalIsNew(!network);
    setNetworkNameInput('');
    setNetworkModalSelected(new Set(current));
    setNetworkModalCustom('');
  }, [networkConfigs]);

  const networkModalCandidates = useMemo(() => {
    if (!networkModalFor || networkModalIsNew) return [];
    const current = networkConfigs.get(networkModalFor) || [];
    return Array.from(new Set(current)).sort();
  }, [networkModalFor, networkModalIsNew, networkConfigs]);

  const toggleNetworkCandidate = useCallback((ap: string) => {
    setNetworkModalSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ap)) next.delete(ap);
      else next.add(ap);
      return next;
    });
  }, []);

  const handleAddCustomNetworkTerminal = useCallback(() => {
    const ap = networkModalCustom.trim();
    if (!ap) return;
    setNetworkModalSelected((prev) => new Set(prev).add(ap));
    setNetworkModalCustom('');
  }, [networkModalCustom]);

  const handleSaveNetworkTerminals = useCallback(async () => {
    const name = networkModalIsNew ? networkNameInput.trim() : networkModalFor;
    if (!name) return;
    setSavingNetworkTerminals(true);
    try {
      await setTerminalNetworkMembers(name, Array.from(networkModalSelected));
      showNotification('Shared terminal network updated.', 'success');
      setNetworkModalFor(null);
      await loadData();
    } catch (err) {
      showNotification(err instanceof Error ? err.message : 'Could not update the terminal network.', 'error');
    } finally {
      setSavingNetworkTerminals(false);
    }
  }, [networkModalFor, networkModalIsNew, networkNameInput, networkModalSelected, loadData]);

  // Assigns one or more sites (comma-separated workstation names) to a
  // network in a single administrator action -- the "future additional
  // terminals/sites can join through a single configuration, never
  // per-employee" requirement.
  const handleAssignSitesToNetwork = useCallback(async () => {
    const sites = assignSitesInput.split(',').map((s) => s.trim()).filter(Boolean);
    const network = assignNetworkInput.trim();
    if (sites.length === 0 || !network) return;
    setAssigningSites(true);
    try {
      const changedCount = await setSiteNetworkMembership(sites, network);
      showNotification(`${changedCount} site(s) assigned to ${normalizeSiteKey(network)}.`, 'success');
      setAssignSitesInput('');
      setAssignNetworkInput('');
      await loadData();
    } catch (err) {
      showNotification(err instanceof Error ? err.message : 'Could not assign sites to this network.', 'error');
    } finally {
      setAssigningSites(false);
    }
  }, [assignSitesInput, assignNetworkInput, loadData]);

  // Explicit, reviewable activation of the fingerprint_attendance_enabled
  // flag -- individually (one id) or in bulk (a whole site's currently
  // not-enabled mapped employees at once). Never automatic, never
  // inferred -- this is the one human action that turns the shared
  // site-level fallback on for a given employee.
  const handleEnableFingerprintAttendance = useCallback(async (employeeIds: string[]) => {
    if (employeeIds.length === 0) return;
    setEnablingEmployeeIds((prev) => {
      const next = new Set(prev);
      employeeIds.forEach((id) => next.add(id));
      return next;
    });
    try {
      const updatedCount = await setFingerprintAttendanceEnabled(employeeIds, true);
      showNotification(`Fingerprint attendance enabled for ${updatedCount} employee${updatedCount === 1 ? '' : 's'}.`, 'success');
      await loadData();
    } catch (err) {
      showNotification(err instanceof Error ? err.message : 'Could not enable fingerprint attendance.', 'error');
    } finally {
      setEnablingEmployeeIds((prev) => {
        const next = new Set(prev);
        employeeIds.forEach((id) => next.delete(id));
        return next;
      });
    }
  }, [loadData]);

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
        <StatCard title="Needs mapping" value={(exactMatches.length + needsReview.length).toLocaleString()} icon={Search} accent="gold" sub={`${exactMatches.length} ready, ${needsReview.length} need review`} />
        <StatCard title="Total mapped" value={mapped.length.toLocaleString()} icon={UserCheck} accent="blue" />
        <StatCard
          title="Fingerprint status"
          value={`${fingerprintStatusSummary.ready} ready`}
          icon={CheckCircle2}
          accent="green"
          sub={`${fingerprintStatusSummary.needsActivation} need activation, ${fingerprintStatusSummary.needsSetup} need setup`}
        />
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

      <Input
        icon={Search}
        placeholder="Search by employee name, employee number, HikCentral name, or Person No..."
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
      />

      {activeTab === 'exact' && (
        exactMatches.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="No exact matches pending" description="Every identity with a single, exact, active-employee name match has already been mapped or there are none right now." />
        ) : filteredExactMatches.length === 0 ? (
          <EmptyState icon={Search} title="No matching results" description={`No exact matches match "${searchInput.trim()}". Try a different name, employee number, or Person No.`} />
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
                {filteredExactMatches.map((i) => (
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
        ) : filteredNeedsReview.length === 0 ? (
          <EmptyState icon={Search} title="No matching results" description={`No identities needing review match "${searchInput.trim()}". Try a different name, employee number, or Person No.`} />
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              {strongReviewIdentities.length} strong suggestion{strongReviewIdentities.length === 1 ? '' : 's'} ready for bulk confirmation &middot;{' '}
              {needsReview.length - strongReviewIdentities.length} other identit{needsReview.length - strongReviewIdentities.length === 1 ? 'y needs' : 'ies need'} individual review.
            </p>
            {canMap && strongReviewIdentities.length > 0 && (
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                <label className="flex items-center gap-2 text-sm text-emerald-800">
                  <input
                    type="checkbox"
                    aria-label="Select all strong suggestions"
                    checked={selectedStrongReview.size === strongReviewIdentities.length && strongReviewIdentities.length > 0}
                    onChange={toggleSelectAllStrongReview}
                  />
                  Select all strong suggestions ({selectedStrongReview.size} of {strongReviewIdentities.length} selected)
                </label>
                <Button onClick={handleConfirmSelectedStrongReview} disabled={confirming || selectedStrongReview.size === 0}>
                  {confirming ? 'Confirming...' : `Confirm Selected Strong Suggestions (${selectedStrongReview.size})`}
                </Button>
              </div>
            )}
            {filteredNeedsReview.map((i) => {
              const topIsStrong = i.suggestions[0]?.label === 'Strong suggestion';
              const otherSuggestions = topIsStrong ? i.suggestions.slice(1) : i.suggestions;
              return (
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

                  {topIsStrong && (
                    <div className="mt-4 flex items-center gap-3 p-3 rounded-lg border border-emerald-300 bg-emerald-50">
                      {canMap && (
                        <input
                          type="checkbox"
                          aria-label={`Select strong suggestion for Person No ${i.profile.hikcentralPersonNo}`}
                          checked={selectedStrongReview.has(i.profile.hikcentralPersonNo)}
                          onChange={() => toggleStrongReviewSelected(i.profile.hikcentralPersonNo)}
                        />
                      )}
                      <div className="flex-1">
                        <span className="block text-sm font-medium text-slate-800">{i.suggestions[0].employee.fullName}</span>
                        <span className="block text-xs text-slate-500">{i.suggestions[0].employee.employeeNumber} &middot; {i.suggestions[0].employee.workstation || '—'}</span>
                      </div>
                      <Badge color="green">Strong suggestion</Badge>
                    </div>
                  )}

                  {otherSuggestions.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {otherSuggestions.map((s) => (
                        <button
                          key={s.employee.id}
                          type="button"
                          disabled={!canMap || confirming}
                          onClick={() => handlePickSuggestion(i.profile.hikcentralPersonNo, s.employee.id)}
                          className="text-left p-3 rounded-lg border border-slate-200 hover:border-[#081C3A]/40 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          <span className="block text-sm font-medium text-slate-800">{s.employee.fullName}</span>
                          <span className="block text-xs text-slate-500">{s.employee.employeeNumber} &middot; {s.employee.workstation || '—'}</span>
                          <Badge color="gold" className="mt-1">{s.label}</Badge>
                        </button>
                      ))}
                    </div>
                  )}

                  {i.suggestions.length === 0 && (
                    <p className="text-xs text-slate-400 mt-3">No strong suggestion found -- use Search Employee above.</p>
                  )}
                </Card>
              );
            })}
          </div>
        )
      )}

      {activeTab === 'mapped' && (
        <>
          {canMap && (
            <details className="mb-4 rounded-xl border border-slate-200 bg-white">
              <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 rounded-xl">
                Advanced: Terminal network configuration
              </summary>
              <div className="px-4 pb-4 space-y-4 border-t border-slate-100 pt-4">
                <p className="text-xs text-slate-500">
                  Most fingerprint employees need nothing here -- Person Mapping, plus a one-time site or network setup, is enough. Use this only to register a shared terminal network (e.g. several Lilongwe doors many workstations travel to), configure an individual site directly, or override one employee.
                </p>

                <div>
                    <h3 className="text-sm font-semibold text-slate-800 mb-1">Shared terminal networks</h3>
                    <p className="text-xs text-slate-500 mb-3">
                      A network is a named, reusable terminal list -- many sites join it at once, and adding a terminal later is one edit here, never one edit per site.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {networkSummaries.map((n) => (
                        <div key={n.network} className="rounded-lg border border-slate-200 overflow-hidden">
                          <button
                            type="button"
                            onClick={() => openNetworkModal(n.network)}
                            className="text-left px-3 py-2 hover:bg-slate-50 transition-colors block w-full"
                          >
                            <span className="block text-sm font-medium text-slate-800">{n.network}</span>
                            <span className="block text-[11px] text-slate-500">{n.sites.length} site{n.sites.length === 1 ? '' : 's'} &middot; {n.mappedEmployeeCount} mapped employee{n.mappedEmployeeCount === 1 ? '' : 's'}</span>
                            {n.configuredAccessPoints.length > 0 ? (
                              <span className="block text-[11px] text-emerald-600 mt-0.5">{n.configuredAccessPoints.join(', ')}</span>
                            ) : (
                              <span className="block text-[11px] text-slate-400 mt-0.5">No terminals registered yet</span>
                            )}
                          </button>
                          {n.configuredAccessPoints.length > 0 && n.notEnabledEmployeeIds.length > 0 && (
                            <button
                              type="button"
                              onClick={() => handleEnableFingerprintAttendance(n.notEnabledEmployeeIds)}
                              disabled={n.notEnabledEmployeeIds.some((id) => enablingEmployeeIds.has(id))}
                              className="w-full text-left px-3 py-1.5 text-[11px] font-medium text-[#081C3A] bg-slate-50 hover:bg-slate-100 border-t border-slate-200 disabled:opacity-50"
                            >
                              Enable fingerprint for {n.notEnabledEmployeeIds.length} not-yet-enabled employee{n.notEnabledEmployeeIds.length === 1 ? '' : 's'} here
                            </button>
                          )}
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => openNetworkModal(null)}
                        className="text-left px-3 py-2 rounded-lg border border-dashed border-slate-300 hover:border-[#081C3A]/40 transition-colors text-sm text-slate-500"
                      >
                        + Register a new network
                      </button>
                    </div>
                    <div className="mt-3 flex flex-col sm:flex-row gap-2 items-start sm:items-end">
                      <div className="flex-1 w-full">
                        <label className="block text-[11px] text-slate-500 mb-1">Site(s) to assign (comma-separated workstation names)</label>
                        <Input placeholder="e.g. AREA 12, KANENGO AHL, OCEAN" value={assignSitesInput} onChange={(e) => setAssignSitesInput(e.target.value)} />
                      </div>
                      <div className="w-full sm:w-48">
                        <label className="block text-[11px] text-slate-500 mb-1">Network</label>
                        <Input placeholder="e.g. LILONGWE NETWORK" value={assignNetworkInput} onChange={(e) => setAssignNetworkInput(e.target.value)} />
                      </div>
                      <Button size="sm" onClick={handleAssignSitesToNetwork} disabled={assigningSites || !assignSitesInput.trim() || !assignNetworkInput.trim()}>
                        {assigningSites ? 'Assigning...' : 'Assign'}
                      </Button>
                    </div>
                  </div>

                {siteSummaries.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-slate-800 mb-1">Individual site terminal coverage</h3>
                    <p className="text-xs text-slate-500 mb-3">
                      Configure one site's own terminal(s) directly -- only needed when a site is not part of a shared network.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {siteSummaries.map((s) => (
                        <div key={s.key} className="rounded-lg border border-slate-200 overflow-hidden">
                          <button
                            type="button"
                            onClick={() => openSiteModal(s.key)}
                            className="text-left px-3 py-2 hover:bg-slate-50 transition-colors block w-full"
                          >
                            <span className="block text-sm font-medium text-slate-800">{s.rawSite}</span>
                            <span className="block text-[11px] text-slate-500">{s.mappedEmployeeCount} mapped employee{s.mappedEmployeeCount === 1 ? '' : 's'}</span>
                            {s.configuredAccessPoints.length > 0 ? (
                              <span className="block text-[11px] text-emerald-600 mt-0.5">{s.configuredAccessPoints.join(', ')}</span>
                            ) : s.observedAccessPoints.length > 1 ? (
                              <span className="block text-[11px] text-amber-600 mt-0.5">Ambiguous -- {s.observedAccessPoints.length} terminals observed, needs review</span>
                            ) : (
                              <span className="block text-[11px] text-slate-400 mt-0.5">Not configured</span>
                            )}
                          </button>
                          {s.configuredAccessPoints.length > 0 && s.notEnabledEmployeeIds.length > 0 && (
                            <button
                              type="button"
                              onClick={() => handleEnableFingerprintAttendance(s.notEnabledEmployeeIds)}
                              disabled={s.notEnabledEmployeeIds.some((id) => enablingEmployeeIds.has(id))}
                              className="w-full text-left px-3 py-1.5 text-[11px] font-medium text-[#081C3A] bg-slate-50 hover:bg-slate-100 border-t border-slate-200 disabled:opacity-50"
                            >
                              Enable fingerprint for {s.notEnabledEmployeeIds.length} not-yet-enabled employee{s.notEnabledEmployeeIds.length === 1 ? '' : 's'} here
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </details>
          )}
          {mapped.length === 0 ? (
          <EmptyState icon={UserCheck} title="No confirmed mappings yet" description="Mappings you confirm from the Exact Matches or Needs Review tabs will appear here." />
        ) : filteredMapped.length === 0 ? (
          <EmptyState icon={Search} title="No matching results" description={`No mapped employees match "${searchInput.trim()}". Try a different name, employee number, or Person No.`} />
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
                <TH>HikCentral Terminal(s)</TH>
                {canMap && <TH>Action</TH>}
              </TR>
            </THead>
            <TBody>
              {filteredMapped.map((i) => {
                const driftWarning = mappedIdentityHasNameDrift(i.profile);
                const employeeId = i.activeMapping!.employeeId;
                const assignedTerminals = terminalAssignments.get(employeeId) || [];
                const terminalStatus = terminalStatusByEmployee.get(employeeId);
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
                    <TD>
                      {terminalStatus?.provenance === 'fingerprint_not_enabled' ? (
                        <div className="space-y-1 max-w-xs">
                          <Badge color="purple">Fingerprint not enabled</Badge>
                          <p className="text-xs text-slate-500">This employee's site has a shared terminal configuration, but automatic fingerprint attendance has not been explicitly enabled for them yet.</p>
                          {canMap && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleEnableFingerprintAttendance([employeeId])}
                              disabled={enablingEmployeeIds.has(employeeId)}
                            >
                              {enablingEmployeeIds.has(employeeId) ? 'Enabling...' : 'Enable fingerprint attendance'}
                            </Button>
                          )}
                        </div>
                      ) : terminalStatus?.provenance === 'employee_assigned' || terminalStatus?.provenance === 'site_shared' ? (
                        <div className="space-y-1 max-w-xs">
                          <p className="text-xs text-emerald-700">Fingerprint identity confirmed. Safeguard automatically recognizes eligible HikCentral terminals.</p>
                          <div className="flex flex-wrap gap-1">
                            {(terminalStatus.accessPoints.length > 0 ? terminalStatus.accessPoints : assignedTerminals).map((ap) => (
                              <Badge key={ap} color={terminalStatus.provenance === 'employee_assigned' ? 'blue' : 'teal'}>{ap}</Badge>
                            ))}
                          </div>
                          <p className="text-[11px] text-slate-400">{terminalStatus.provenance === 'employee_assigned' ? 'Individually assigned -- always takes precedence over the shared site setting below' : 'Shared site configuration'}</p>
                        </div>
                      ) : (
                        <div className="space-y-1 max-w-xs">
                          <Badge color="orange">Waiting on terminal coverage</Badge>
                          <p className="text-xs text-slate-500">Fingerprint identity mapped. Waiting for confirmed terminal coverage.</p>
                        </div>
                      )}
                    </TD>
                    {canMap && (
                      <TD className="space-x-2 whitespace-nowrap">
                        <Button variant="ghost" size="sm" onClick={() => openTerminalModal(i)} title="Override this employee's eligible terminal(s) individually -- only needed when the shared site configuration does not apply to them.">
                          Individual override
                        </Button>
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
          )}
        </>
      )}

      {activeTab === 'conflict' && (
        conflicts.length === 0 ? (
          <EmptyState icon={AlertTriangle} title="No conflicts" description="No Person No. currently has more than one conflicting name in the raw data." />
        ) : filteredConflicts.length === 0 ? (
          <EmptyState icon={Search} title="No matching results" description={`No conflicts match "${searchInput.trim()}". Try a different name, employee number, or Person No.`} />
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
              {filteredConflicts.map((i) => (
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

      <Modal
        open={!!terminalModalFor}
        onClose={() => setTerminalModalFor(null)}
        title={`Assign HikCentral terminal(s) for ${terminalModalFor ? displayName(terminalModalFor.profile) : ''}`}
        size="md"
      >
        <div className="space-y-4">
          <p className="text-xs text-slate-500">
            The expected HikCentral terminal(s) this employee actually uses -- independent of their HR workstation. An employee with no terminal assigned here can never be marked Absent; one who uses more than one central terminal can be assigned all of them. An individual assignment here always takes priority over the shared site fingerprint-attendance setting: it keeps this employee eligible even while that setting is off for them.
          </p>
          <div className="space-y-1.5">
            {terminalModalCandidates.length === 0 && (
              <p className="text-xs text-slate-400">No access point observed for this identity yet -- add one below.</p>
            )}
            {terminalModalCandidates.map((ap) => (
              <label key={ap} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={terminalModalSelected.has(ap)}
                  onChange={() => toggleTerminalCandidate(ap)}
                />
                {ap}
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Input
              placeholder="Add another access point by name..."
              value={terminalModalCustom}
              onChange={(e) => setTerminalModalCustom(e.target.value)}
            />
            <Button variant="outline" size="sm" onClick={handleAddCustomTerminal} disabled={!terminalModalCustom.trim()}>
              Add
            </Button>
          </div>
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
            <Button variant="outline" onClick={() => setTerminalModalFor(null)} disabled={savingTerminals}>
              Cancel
            </Button>
            <Button onClick={handleSaveTerminals} disabled={savingTerminals}>
              {savingTerminals ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!siteModalFor}
        onClose={() => setSiteModalFor(null)}
        title={`Shared HikCentral terminal(s) for ${siteModalFor ? siteSummaries.find((s) => s.key === siteModalFor)?.rawSite || siteModalFor : ''}`}
        size="md"
      >
        <div className="space-y-4">
          <p className="text-xs text-slate-500">
            Every mapped employee at this site who has no individual terminal override AND has been explicitly enabled for automatic fingerprint attendance becomes eligible at the terminal(s) selected here. Employees with an individual override are never affected by this setting, in either direction -- their own assignment always takes priority. A newly-mapped employee is enabled by default; a pre-existing employee needs a one-time "Enable fingerprint attendance" action first (shown below, once this site has terminals configured).
          </p>
          <div className="space-y-1.5">
            {siteModalCandidates.length === 0 && (
              <p className="text-xs text-slate-400">No access point observed for this site yet -- add one below.</p>
            )}
            {siteModalCandidates.map((ap) => (
              <label key={ap} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={siteModalSelected.has(ap)}
                  onChange={() => toggleSiteCandidate(ap)}
                />
                {ap}
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Input
              placeholder="Add another access point by name..."
              value={siteModalCustom}
              onChange={(e) => setSiteModalCustom(e.target.value)}
            />
            <Button variant="outline" size="sm" onClick={handleAddCustomSiteTerminal} disabled={!siteModalCustom.trim()}>
              Add
            </Button>
          </div>
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
            <Button variant="outline" onClick={() => setSiteModalFor(null)} disabled={savingSiteTerminals}>
              Cancel
            </Button>
            <Button onClick={handleSaveSiteTerminals} disabled={savingSiteTerminals}>
              {savingSiteTerminals ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!networkModalFor}
        onClose={() => setNetworkModalFor(null)}
        title={networkModalIsNew ? 'Register a new shared terminal network' : `Terminals for ${networkModalFor}`}
        size="md"
      >
        <div className="space-y-4">
          <p className="text-xs text-slate-500">
            Every terminal registered here is automatically eligible for any mapped, enabled employee at any site joined to this network -- regardless of their workstation name. Adding a terminal later is one edit here, never one edit per site.
          </p>
          {networkModalIsNew && (
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Network name</label>
              <Input placeholder="e.g. LILONGWE NETWORK" value={networkNameInput} onChange={(e) => setNetworkNameInput(e.target.value)} />
            </div>
          )}
          <div className="space-y-1.5">
            {networkModalCandidates.length === 0 && (
              <p className="text-xs text-slate-400">No terminals registered yet -- add one below.</p>
            )}
            {networkModalCandidates.map((ap) => (
              <label key={ap} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={networkModalSelected.has(ap)}
                  onChange={() => toggleNetworkCandidate(ap)}
                />
                {ap}
              </label>
            ))}
            {Array.from(networkModalSelected).filter((ap) => !networkModalCandidates.includes(ap)).map((ap) => (
              <label key={ap} className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked onChange={() => toggleNetworkCandidate(ap)} />
                {ap}
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Input
              placeholder="Add a terminal's exact HikCentral access point name..."
              value={networkModalCustom}
              onChange={(e) => setNetworkModalCustom(e.target.value)}
            />
            <Button variant="outline" size="sm" onClick={handleAddCustomNetworkTerminal} disabled={!networkModalCustom.trim()}>
              Add
            </Button>
          </div>
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
            <Button variant="outline" onClick={() => setNetworkModalFor(null)} disabled={savingNetworkTerminals}>
              Cancel
            </Button>
            <Button onClick={handleSaveNetworkTerminals} disabled={savingNetworkTerminals || (networkModalIsNew && !networkNameInput.trim())}>
              {savingNetworkTerminals ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
