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
//
// Three-tier classification, replacing the earlier flat Levenshtein-ratio
// cutoff. Combines several independent signals rather than one loosened
// threshold:
//
//   1. Whole-name edit-distance similarity (catches straightforward
//      spelling variants: insertions/deletions/substitutions anywhere in
//      the string, including across what would otherwise be a token
//      boundary).
//   2. Token-level, ORDER-INDEPENDENT alignment: each name is split into
//      whitespace tokens, and the best one-to-one pairing between the two
//      token lists is found by trying every assignment (names realistically
//      have at most a handful of tokens, so this is cheap and exact, not a
//      heuristic). This is what lets "ELLIAS SEMU MAKUNGWA" line up with
//      "SEMU ELIAS MAKUNGWA" despite the reordering, while still separately
//      scoring each matched pair (so a spelling variant in one token, e.g.
//      ELLIAS/ELIAS, doesn't have to be perfect -- each token pair is scored
//      on its own edit distance, which is also how given-name and
//      surname-position evidence end up counted independently rather than
//      as one undifferentiated blob).
//   3. A minimum-evidence floor: a single short token (e.g. "TED") can
//      match some employee's name perfectly and still be weak evidence,
//      because a one-token name is inherently ambiguous and uninformative.
//      "Strong" is only reachable when at least two of the identity's name
//      tokens each found a good partner -- a single matched token can never
//      promote a candidate past "Possible match", no matter how close the
//      edit distance.
//   4. A margin/ambiguity check: "strong" requires not just a high score,
//      but a CLEAR separation from the next-best candidate. If two or more
//      employees score similarly close to the top, that is treated as
//      ambiguous (never bulk-confirmable), matching the instruction that a
//      strong suggestion must be "substantially stronger than alternatives".
//
// None of this is surfaced as an invented confidence percentage -- see this
// module's header. Labels are restricted to the three fixed strings below.

export type SuggestionLabel = 'Strong suggestion' | 'Possible match';

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

function editSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const dist = levenshteinDistance(a, b);
  return Math.max(0, 1 - dist / Math.max(a.length, b.length, 1));
}

function tokenize(normalizedName: string): string[] {
  return normalizedName.split(' ').filter((t) => t.length > 0);
}

/**
 * Similarity between two individual name tokens. A single-letter token
 * (an initial) gets partial credit for matching the other token's first
 * letter -- "initials" are explicitly in scope per the task -- but never
 * full credit, since an initial is strictly weaker evidence than a
 * complete token match.
 */
function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 1 || b.length === 1) {
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    return short.length === 1 && long.startsWith(short) ? 0.8 : 0;
  }
  return editSimilarity(a, b);
}

const GOOD_TOKEN_MATCH_MIN_SIMILARITY = 0.5;

interface TokenAlignmentResult {
  /** Similarity-ordered list of every (shortIdx, longIdx, similarity) pair in the chosen assignment. */
  pairSimilarities: number[];
  /** How many of those pairs clear GOOD_TOKEN_MATCH_MIN_SIMILARITY -- the "evidence count". */
  goodPairCount: number;
}

/**
 * Finds the best one-to-one assignment between the tokens of two names,
 * trying every possible assignment of the SHORTER token list into the
 * longer one (exact, not greedy -- real names have few enough tokens that
 * this is cheap). Extra tokens on the longer side (e.g. a middle name the
 * other source omitted) are simply left unmatched rather than penalized,
 * which is what "forgives" optional middle names/initials: the score below
 * is driven by how well the SHORTER name's tokens are covered, not by what
 * fraction of the longer name was used.
 */
function bestTokenAlignment(tokensA: string[], tokensB: string[]): TokenAlignmentResult {
  const [shortTokens, longTokens] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  if (shortTokens.length === 0 || longTokens.length === 0) return { pairSimilarities: [], goodPairCount: 0 };

  // Defensive cap -- real HikCentral/employee names never have this many
  // tokens, but never let a pathological input blow up factorially.
  const n = Math.min(shortTokens.length, 8);
  const m = longTokens.length;

  let best: { total: number; sims: number[] } = { total: -1, sims: [] };
  const used = new Array(m).fill(false);
  const current: number[] = [];

  function recurse(i: number, total: number) {
    if (i === n) {
      if (total > best.total) best = { total, sims: [...current] };
      return;
    }
    for (let j = 0; j < m; j++) {
      if (used[j]) continue;
      used[j] = true;
      current.push(tokenSimilarity(shortTokens[i], longTokens[j]));
      recurse(i + 1, total + current[current.length - 1]);
      current.pop();
      used[j] = false;
    }
  }
  recurse(0, 0);

  const goodPairCount = best.sims.filter((s) => s >= GOOD_TOKEN_MATCH_MIN_SIMILARITY).length;
  return { pairSimilarities: best.sims, goodPairCount };
}

interface NameMatchScore {
  /** 0..1, used for ranking and threshold comparisons. */
  combinedScore: number;
  /** How many of the identity's name tokens found a good (>=0.5) partner -- the minimum-evidence signal. */
  goodTokenMatches: number;
  /** Token count of the shorter of the two names being compared. */
  shorterTokenCount: number;
}

function scoreNameMatch(targetName: string, candidateName: string): NameMatchScore {
  const wholeNameScore = editSimilarity(targetName, candidateName);
  const targetTokens = tokenize(targetName);
  const candidateTokens = tokenize(candidateName);
  const alignment = bestTokenAlignment(targetTokens, candidateTokens);
  const shorterTokenCount = Math.min(targetTokens.length, candidateTokens.length);

  // Token score: average similarity of the GOOD pairs only (a token that
  // matched nothing useful shouldn't drag down an otherwise strong pair),
  // scaled by how much of the shorter name's tokens were covered by a good
  // pair at all (so a single lucky token match on an otherwise-unrelated
  // multi-token name doesn't look like a full match).
  const goodSims = alignment.pairSimilarities.filter((s) => s >= GOOD_TOKEN_MATCH_MIN_SIMILARITY);
  const coverage = shorterTokenCount > 0 ? goodSims.length / shorterTokenCount : 0;
  const avgGoodSim = goodSims.length > 0 ? goodSims.reduce((a, b) => a + b, 0) / goodSims.length : 0;
  const tokenScore = avgGoodSim * coverage;

  return {
    combinedScore: Math.max(wholeNameScore, tokenScore),
    goodTokenMatches: alignment.goodPairCount,
    shorterTokenCount,
  };
}

// Thresholds. Deliberately conservative -- see this module's header comment
// for why these are not just "the old ratio, loosened". Tuned against the
// real STAGING dataset's 40 Needs Review identities (spelling-variant pairs
// such as ELLAD HAWARD LESTERN/ELLARD HAWARD LESTERN, BRANDINA MAULIDI/
// BRANDINA MAULINDI, reordered tokens such as ELLIAS SEMU MAKUNGWA/SEMU
// ELIAS MAKUNGWA, and the deliberately-weak single-token case "TED").
const STRONG_SCORE_MIN = 0.78;
const STRONG_MARGIN_MIN = 0.15;
const POSSIBLE_SCORE_MIN = 0.55;
const STRONG_MIN_GOOD_TOKENS = 2;
const MAX_SUGGESTIONS = 3;

/**
 * Ranks active, non-deleted employees by name similarity to the given
 * HikCentral identity profile's name, using the multi-signal scoring above.
 * Returns at most 3 candidates, each labeled 'Strong suggestion' (at most
 * ONE, and only when it is both a high-confidence match AND clearly
 * separated from every other candidate) or 'Possible match' (everything
 * else that clears the much lower usefulness bar). Never auto-selects or
 * auto-confirms anything -- callers must still require explicit human
 * selection before any mapping is written.
 */
export function suggestEmployeesForIdentity(
  profile: HikCentralIdentityProfile,
  employees: EmployeeLite[]
): EmployeeSuggestion[] {
  if (profile.distinctNormalizedNames.length !== 1) return []; // no name, or conflicting names -- nothing to suggest from
  const targetName = profile.distinctNormalizedNames[0];
  const candidates = employees.filter(isActiveNonDeletedEmployee);

  const scored = candidates.map((employee) => ({
    employee,
    match: scoreNameMatch(targetName, normalizeNameForComparison(employee.fullName)),
  }));

  const useful = scored.filter((s) => s.match.combinedScore >= POSSIBLE_SCORE_MIN);
  useful.sort((a, b) => b.match.combinedScore - a.match.combinedScore);
  if (useful.length === 0) return [];

  const top = useful[0];
  const runnerUpScore = useful.length > 1 ? useful[1].match.combinedScore : 0;
  const margin = top.match.combinedScore - runnerUpScore;

  const topIsStrong =
    top.match.combinedScore >= STRONG_SCORE_MIN &&
    margin >= STRONG_MARGIN_MIN &&
    top.match.goodTokenMatches >= STRONG_MIN_GOOD_TOKENS;

  return useful.slice(0, MAX_SUGGESTIONS).map((s, i) => ({
    employee: s.employee,
    label: i === 0 && topIsStrong ? 'Strong suggestion' : 'Possible match',
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
