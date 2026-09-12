// Extracted from Security.tsx, which previously had this same expression
// duplicated in 5 separate places -- inconsistently: the guard-creation
// form's own auto-fill effect used Math.floor(1000 + Math.random() * 9000)
// (a 4-digit range, 1000-9999), while 4 other fallback call sites (used
// when saving a guard whose guardId somehow ended up empty) used
// Math.floor(Math.random() * 1000) (0-999, un-padded, so anywhere from 1
// to 3 digits).
//
// SUPERSEDED by generateGuardIdServerSide() below, per
// supabase/migrations/20260804000000_guard_id_generation.sql: this
// function is a random draw with NO uniqueness check against the
// database, and with a 9000-value range the birthday-paradox collision
// probability crosses 50% at roughly 112 guards -- a real, live risk for
// a company this app describes as managing "200+ employees". It is kept
// (a) as the client-side fallback generateGuardIdServerSide() uses if the
// RPC call fails for any reason, so guard creation degrades to the old
// (working, if collision-prone) behavior instead of hard-failing, and
// (b) because its own tests below still document, mechanically, exactly
// why it needed replacing.
import { supabase } from '../lib/supabase';

/**
 * Generates a random guard ID in the existing "G-XXXX" format (4-digit
 * random number, 1000-9999). Does NOT check for uniqueness -- see the
 * file-level comment above. Client-side fallback only; prefer
 * generateGuardIdServerSide() for anything that actually persists a
 * guard record.
 */
export function generateGuardId(): string {
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  return `G-${randomNum}`;
}

/**
 * Calls the `generate_guard_id()` Postgres function (a real, atomic
 * SEQUENCE-backed counter -- see the migration referenced above) so a
 * guard ID is reserved by the database itself, with no possibility of a
 * collision under concurrent creation. Falls back to the client-side
 * generateGuardId() (logging the failure) if the RPC call errors --
 * e.g. because the migration hasn't been applied to this environment
 * yet -- so guard creation itself never hard-fails because of this call.
 *
 * NOT SAFE TO CALL until 20260804000000_guard_id_generation.sql has been
 * applied to the target database; until then this always falls back to
 * generateGuardId(), which is the same behavior as before this change.
 */
export async function generateGuardIdServerSide(): Promise<string> {
  try {
    const { data, error } = await supabase.rpc('generate_guard_id');
    if (error) throw error;
    if (typeof data === 'string' && data.length > 0) return data;
    throw new Error('generate_guard_id() returned an unexpected value');
  } catch (err) {
    console.error('generate_guard_id() RPC failed, falling back to client-side generation:', err);
    return generateGuardId();
  }
}
