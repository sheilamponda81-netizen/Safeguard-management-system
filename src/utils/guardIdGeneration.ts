// Extracted from Security.tsx, which previously had this same expression
// duplicated in 5 separate places -- inconsistently: the guard-creation
// form's own auto-fill effect used Math.floor(1000 + Math.random() * 9000)
// (a 4-digit range, 1000-9999), while 4 other fallback call sites (used
// when saving a guard whose guardId somehow ended up empty) used
// Math.floor(Math.random() * 1000) (0-999, un-padded, so anywhere from 1
// to 3 digits). Consolidated to the wider, more consistent 4-digit range
// used everywhere now.
//
// IMPORTANT, NOT FIXED HERE: this is still a random ID with NO uniqueness
// check against the database (unlike employee number generation, which
// queries for the highest existing number in a prefix -- see
// employeeNumberGeneration.ts). There is also no UNIQUE constraint on
// employees."guardId" in the schema. With a 9000-value range, the
// birthday-paradox collision probability crosses 50% at roughly 112
// guards created -- a real, live risk for a company this app describes
// as managing "200+ employees". Flagged in AUDIT_REPORT.md as a finding
// requiring a business decision (e.g. a sequential/DB-checked scheme
// like employee numbers use) rather than silently redesigned here.

/**
 * Generates a random guard ID in the existing "G-XXXX" format (4-digit
 * random number, 1000-9999). Does NOT check for uniqueness -- see the
 * file-level comment above.
 */
export function generateGuardId(): string {
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  return `G-${randomNum}`;
}
