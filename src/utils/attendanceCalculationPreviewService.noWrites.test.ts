import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Stage B boundary guard: the preview's data-access layer must never gain
// a write path. This is a deliberately crude source scan (not a mock of
// the Supabase client) -- its only job is to fail loudly if a future edit
// ever adds `.insert(`, `.update(`, `.upsert(`, `.delete(`, or `.rpc(` to
// this file, since every one of those would mean this "read-only preview"
// stopped being read-only.
describe('attendanceCalculationPreviewService.ts -- no write calls', () => {
  it('contains no insert/update/upsert/delete/rpc calls', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(dir, 'attendanceCalculationPreviewService.ts'), 'utf-8');
    // Strip `//` line comments first so the file's own documentation
    // (which legitimately needs to SAY "no .insert() here" in prose) can
    // never trip this scan -- only actual code lines are checked.
    const codeOnly = source
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    const forbidden = ['.insert(', '.update(', '.upsert(', '.delete(', '.rpc('];
    for (const pattern of forbidden) {
      expect(codeOnly.includes(pattern), `found forbidden write call ${pattern}`).toBe(false);
    }
  });
});
