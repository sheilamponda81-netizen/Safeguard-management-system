import { describe, it, expect } from 'vitest';
import { raceWithTimeout } from './hikcentralFileReader';

// `parseHikCentralExcelFile` itself is not tested here (it depends on
// the browser's `File.arrayBuffer()` -- see this module's own header
// comment; the actual XLSX reading it delegates to,
// hikcentralOoxmlReader.ts, has its own dedicated, directly-testable
// suite in hikcentralOoxmlReader.test.ts). `raceWithTimeout` is the
// pure, directly-testable piece of the fix for the real-file hang
// observed on PR #44's STAGING Preview (2026-09-29): it's what
// guarantees `parseHikCentralExcelFile`'s returned promise always
// settles, so HikCentralImportPage's `finally { setParsing(false) }` is
// never left waiting forever on a slow/pathological file.
describe('raceWithTimeout', () => {
  it('resolves with the underlying promise\'s value when it settles before the timeout', async () => {
    const result = await raceWithTimeout(
      Promise.resolve('parsed value'),
      1000,
      () => new Error('should not be used')
    );
    expect(result).toBe('parsed value');
  });

  it('rejects with the underlying promise\'s error when it rejects before the timeout', async () => {
    await expect(
      raceWithTimeout(Promise.reject(new Error('real parse error')), 1000, () => new Error('should not be used'))
    ).rejects.toThrow('real parse error');
  });

  it('rejects with the timeout error, not the underlying promise, when the underlying promise never settles in time', async () => {
    const neverSettles = new Promise<string>(() => {});
    await expect(
      raceWithTimeout(neverSettles, 10, () => new Error('timed out waiting for parse'))
    ).rejects.toThrow('timed out waiting for parse');
  });

  it('rejects with the timeout error even when the underlying promise eventually settles, just too late', async () => {
    const settlesLate = new Promise<string>((resolve) => setTimeout(() => resolve('too late'), 50));
    await expect(
      raceWithTimeout(settlesLate, 10, () => new Error('timed out'))
    ).rejects.toThrow('timed out');
    // The late resolution itself must never throw/reject unhandled --
    // give it time to settle in the background and confirm the test
    // process is still healthy (vitest would fail the run on an
    // unhandled rejection if `raceWithTimeout` didn't silence it).
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
});
