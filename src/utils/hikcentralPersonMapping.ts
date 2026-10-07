// HikCentral Attendance MVP -- Phase 2: Person Mapping workflow.
//
// Pure, DB-free classification/matching logic. Everything here operates
// on already-fetched plain data (identified raw-event rows, active
// employees, active mapping rows) and returns plain data -- no Supabase
// calls. See hikcentralPersonMappingService.ts for the data-access layer
// and the RPC that actually writes a confirmed mapping.
//
// CORE INVARIANT (from the read-only discovery audit that preceded this
// workflow): hikcentral_person_no is an EXACT RAW STRING identity, never
// normalized for identity purposes. "00000018" and "18" are two
// different people in the real STAGING dataset -- confirmed by name.
// Nothing in this file ever strips leading zeros, casts a Person No. to
// a number, or compares two Person Nos numerically. Name normalization
// (normalizeNameForComparison below) is used ONLY to compare two NAME
// strings to each other -- never applied to a Person No.

export interface IdentifiedRawEventRow {
  hikcentralPersonNo: string; // never null/empty -- callers must filter anonymous rows out first
  firstName: string | null;
  lastName: string | null;
  accessPoint: string | null;
  eventTimeIso: string;
}

export interface EmployeeLite {
  id: string;
  employeeNumber: string;
  fullName: string;
  workstation: string | null;
  status: string | null;
  isDeleted: boolean | null;
}

export interface ActiveMappingRow {
  id: string;
  hikcentralPersonNo: string;
  employeeId: string;
  matchMethod: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  createdAt: string;
}

export interface HikCentralIdentityProfile {
  hikcentralPersonNo: string;
  eventCount: number;
  accessPoints: string[]; // distinct, sorted
  earliest: string;
  latest: string;
  /** Distinct non-blank normalized (for comparison) full names observed for this exact Person No. More than one means a CONFLICT. */
  distinctNormalizedNames: string[];
  /** One representative raw (un-normalized) first/last name pair per distinct normalized name, in first-seen order -- for display. */
  observedNamePairs: { firstName: string | null; lastName: string | null }[];
}

/** trim + collapse internal whitespace + uppercase. NAME comparison only -- never apply to a Person No. */
export function normalizeNameForComparison(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function normalizedFullName(firstName: string | null, lastName: string | null): string {
  return `${normalizeNameForComparison(firstName)} ${normalizeNameForComparison(lastName)}`.trim().replace(/\s+/g, ' ');
}

/**
 * Groups identified raw-event rows by EXACT raw hikcentral_person_no
 * (a plain string Map key -- no normalization, no numeric coercion).
 */
export function profileHikCentralIdentities(rows: IdentifiedRawEventRow[]): HikCentralIdentityProfile[] {
  const byPersonNo = new Map<string, IdentifiedRawEventRow[]>();
  for (const row of rows) {
    if (!row.hikcentralPersonNo) continue; // defensive -- callers should already exclude anonymous rows
    const existing = byPersonNo.get(row.hikcentralPersonNo);
    if (existing) existing.push(row);
    else byPersonNo.set(row.hikcentralPersonNo, [row]);
  }

  const profiles: HikCentralIdentityProfile[] = [];
  for (const [personNo, group] of byPersonNo) {
    const accessPoints = Array.from(new Set(group.map((r) => r.accessPoint).filter((a): a is string => !!a))).sort();
    const times = group.map((r) => r.eventTimeIso).sort();
    const seenNormalized = new Map<string, { firstName: string | null; lastName: string | null }>();
    for (const r of group) {
      const norm = normalizedFullName(r.firstName, r.lastName);
      if (norm !== '' && !seenNormalized.has(norm)) {
        seenNormalized.set(norm, { firstName: r.firstName, lastName: r.lastName });
      }
    }
    profiles.push({
      hikcentralPersonNo: personNo,
      eventCount: group.length,
      accessPoints,
      earliest: times[0],
      latest: times[times.length - 1],
      distinctNormalizedNames: Array.from(seenNormalized.keys()),
      observedNamePairs: Array.from(seenNormalized.values()),
    });
  }
  return profiles.sort((a, b) => a.hikcentralPersonNo.localeCompare(b.hikcentralPersonNo));
}

export function hasConflictingNames(profile: HikCentralIdentityProfile): boolean {
  return profile.distinctNormalizedNames.length > 1;
}

function isActiveNonDeletedEmployee(e: EmployeeLite): boolean {
  return e.status === 'Active' && e.isDeleted !== true;
}

// ---- Suggestion scoring (needs-review candidates) ----

export type SuggestionLabel = 'Exact name' | 'Possible match';

export interface EmployeeSuggestion {
  employee: EmployeeLite;
  label: SuggestionLabel;
}

/** Classic Levenshtein edit distance. Deterministic, no external dependency. */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prevRow = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const currRow = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow.push(Math.min(currRow[j - 1] + 1, prevRow[j] + 1, prevRow[j - 1] + cost));
    }
    prevRow = currRow;
  }
  return prevRow[b.length];
}

// A candidate is "useful" only within this ratio (edit distance / longer
// string length) -- picked so real spelling-variant pairs observed in the
// genuine STAGING dataset (e.g. a single transposed/substituted/dropped
// letter) are surfaced, while two names that merely happen to be short or
// share a common first name are not. Deliberately NOT surfaced as a
// percentage -- see this module's header: no invented "AI confidence".
const USEFUL_SUGGESTION_MAX_RATIO = 0.3;
const MAX_SUGGESTIONS = 3;

/**
 * Ranks active, non-deleted employees by normalized full-name similarity
 * to the given HikCentral identity profile's name. Returns at most 3
 * candidates, each clearly labeled as a SUGGESTION (never a confirmed
 * match) -- callers must still require explicit human selection/search
 * before any mapping is written.
 */
export function suggestEmployeesForIdentity(
  profile: HikCentralIdentityProfile,
  employees: EmployeeLite[]
): EmployeeSuggestion[] {
  if (profile.distinctNormalizedNames.length !== 1) return []; // no name, or conflicting names -- nothing to suggest from
  const targetName = profile.distinctNormalizedNames[0];
  const candidates = employees.filter(isActiveNonDeletedEmployee);

  const scored = candidates.map((employee) => {
    const empName = normalizeNameForComparison(employee.fullName);
    const distance = levenshteinDistance(targetName, empName);
    const ratio = distance / Math.max(targetName.length, empName.length, 1);
    return { employee, ratio, isExact: empName === targetName };
  });

  const useful = scored.filter((s) => s.isExact || s.ratio <= USEFUL_SUGGESTION_MAX_RATIO);
  useful.sort((a, b) => a.ratio - b.ratio);

  return useful.slice(0, MAX_SUGGESTIONS).map((s) => ({
    employee: s.employee,
    label: s.isExact ? 'Exact name' : 'Possible match',
  }));
}

// ---- Classification ----

export type MappingCategory = 'exact' | 'needs_review' | 'mapped' | 'conflict';

export interface ClassifiedIdentity {
  profile: HikCentralIdentityProfile;
  category: MappingCategory;
  /** Populated for 'exact' (exactly one candidate) and 'mapped' (the currently active mapping's employee). */
  matchedEmployee: EmployeeLite | null;
  /** Populated only for 'mapped'. */
  activeMapping: ActiveMappingRow | null;
  /** Populated only for 'needs_review'. */
  suggestions: EmployeeSuggestion[];
}

/**
 * Classifies every identified HikCentral identity into exactly one of
 * four categories. An identity already carrying an active mapping is
 * ALWAYS 'mapped', regardless of what name evidence would otherwise
 * suggest (an existing confirmed mapping is not re-litigated here) --
 * but see reviewMappedIdentityForNameDrift below for the separate check
 * that DOES re-examine a mapped identity's raw-event names over time.
 */
export function classifyHikCentralIdentities(
  profiles: HikCentralIdentityProfile[],
  employees: EmployeeLite[],
  activeMappings: ActiveMappingRow[]
): ClassifiedIdentity[] {
  const activeMappingByPersonNo = new Map(activeMappings.map((m) => [m.hikcentralPersonNo, m]));
  const employeesById = new Map(employees.map((e) => [e.id, e]));

  return profiles.map((profile) => {
    const existingMapping = activeMappingByPersonNo.get(profile.hikcentralPersonNo);
    if (existingMapping) {
      return {
        profile,
        category: 'mapped' as const,
        matchedEmployee: employeesById.get(existingMapping.employeeId) ?? null,
        activeMapping: existingMapping,
        suggestions: [],
      };
    }

    if (hasConflictingNames(profile)) {
      return { profile, category: 'conflict' as const, matchedEmployee: null, activeMapping: null, suggestions: [] };
    }

    if (profile.distinctNormalizedNames.length === 1) {
      const targetName = profile.distinctNormalizedNames[0];
      const exactMatches = employees.filter(
        (e) => isActiveNonDeletedEmployee(e) && normalizeNameForComparison(e.fullName) === targetName
      );
      if (exactMatches.length === 1) {
        return { profile, category: 'exact' as const, matchedEmployee: exactMatches[0], activeMapping: null, suggestions: [] };
      }
    }

    return {
      profile,
      category: 'needs_review' as const,
      matchedEmployee: null,
      activeMapping: null,
      suggestions: suggestEmployeesForIdentity(profile, employees),
    };
  });
}

/**
 * FUTURE COLLISION GUARDRAIL re-check for an ALREADY-MAPPED identity: if
 * later raw-event imports add a materially conflicting non-empty
 * normalized name for an exact Person No. that already has an active
 * mapping, that mapping must be flagged for review, never silently
 * treated as still-clean merely because a mapping already exists. This
 * is the same hasConflictingNames check, applied regardless of mapped
 * status -- callers should surface this prominently for any 'mapped'
 * identity where this returns true.
 */
export function mappedIdentityHasNameDrift(profile: HikCentralIdentityProfile): boolean {
  return hasConflictingNames(profile);
}
