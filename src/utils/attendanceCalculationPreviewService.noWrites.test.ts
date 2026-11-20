import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Stage B boundary guard: the preview's data-access layer must never gain
// a write path. This is a deliberately crude source scan (not a mock of
// the Supabase client) -- its only job is to fail loudly if a future edit
// ever adds `.insert(`, `.update(`, `.upsert(`, or `.delete(` to this
// file, since every one of those would mean this "read-only preview"
// stopped being read-only.
//
// Attendance coverage-consistency improvement: `.rpc(` calls are no
// longer banned outright -- a Postgres RPC can itself be a pure,
// read-only SELECT (attendanceServerPreviewService.ts's own
// attendance_preview_calculate is this file's own established
// precedent for exactly that), so textual absence of `.rpc(` was never
// actually the right proxy for "contains no write path." Instead, every
// `.rpc(` call in this file must name one of the explicitly reviewed,
// confirmed-read-only functions below -- confirmed read-only both by
// reading each migration's own SQL (no INSERT/UPDATE/DELETE, no RPC with
// any write path reachable from it) and, for attendance_coverage_explain,
// by a dedicated disposable-Postgres test
// (attendanceCoverageExplain.test.ts) asserting its SQL text never even
// references the attendance or payroll tables. Any OTHER rpc name is
// still an immediate failure, exactly as before.
const KNOWN_READ_ONLY_RPC_NAMES = ['attendance_coverage_explain'];

describe('attendanceCalculationPreviewService.ts -- no write calls', () => {
  it('contains no insert/update/upsert/delete calls, and every rpc() call names an explicitly reviewed, confirmed-read-only function', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(dir, 'attendanceCalculationPreviewService.ts'), 'utf-8');
    // Strip `//` line comments first so the file's own documentation
    // (which legitimately needs to SAY "no .insert() here" in prose) can
    // never trip this scan -- only actual code lines are checked.
    const codeOnly = source
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    const forbidden = ['.insert(', '.update(', '.upsert(', '.delete('];
    for (const pattern of forbidden) {
      expect(codeOnly.includes(pattern), `found forbidden write call ${pattern}`).toBe(false);
    }

    const rpcCalls = codeOnly.match(/\.rpc\(\s*'([^']+)'/g) ?? [];
    expect(rpcCalls.length).toBeGreaterThan(0); // this assertion itself must not go stale once nothing calls .rpc() at all
    for (const call of rpcCalls) {
      const name = /\.rpc\(\s*'([^']+)'/.exec(call)![1];
      expect(KNOWN_READ_ONLY_RPC_NAMES, `found an .rpc() call to an un-reviewed function: ${name}`).toContain(name);
    }
  });
});
