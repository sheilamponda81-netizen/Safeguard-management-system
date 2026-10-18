// Browser-only entry point: reads a File (e.g. from an <input
// type="file">) into the raw grid parseHikCentralSheet() expects. Kept
// as its own tiny module, separate from hikcentralExcelParser.ts, so the
// parser itself stays a pure function of already-loaded data, and
// separate from hikcentralOoxmlReader.ts, so THAT stays a pure function
// of raw bytes (directly unit-testable without a `File`/`Blob`) with no
// dependency on the browser's File-reading APIs.
import { parseHikCentralSheet, HikCentralParseResult, HikCentralFileError } from './hikcentralExcelParser';
import { readHikCentralWorkbookGrid } from './hikcentralOoxmlReader';

// A real HikCentral export tested against PR #44's STAGING Preview
// (2026-09-29) was observed stuck on "Parsing file..." past 5 minutes
// with no error -- first against `read-excel-file` (since replaced by
// hikcentralOoxmlReader.ts; see that file's header for why), and this
// timeout was kept as defense in depth regardless of which reader is
// underneath: nothing guarantees a future change to the reader (or a
// pathological file it doesn't yet defend against) can't again leave a
// promise that never settles. This timeout guarantees the promise this
// module returns ALWAYS settles, so HikCentralImportPage's existing
// `finally { setParsing(false) }` can never be left waiting forever.
export const HIKCENTRAL_PARSE_TIMEOUT_MS = 90_000;

/**
 * Resolves/rejects exactly as `promise` does, unless `timeoutMs` elapses
 * first, in which case it rejects with `onTimeout()`'s error instead.
 * `promise` itself is never cancelled -- it's left to settle in the
 * background, with its eventual result/error silently discarded so it
 * can never surface as an unhandled rejection after the caller has
 * already moved on.
 */
export function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  promise.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

export async function parseHikCentralExcelFile(file: File): Promise<HikCentralParseResult> {
  const startedAt = performance.now();
  const parsed = file
    .arrayBuffer()
    .then((buffer) => readHikCentralWorkbookGrid(buffer))
    .then((sheet) => {
      const elapsedMs = Math.round(performance.now() - startedAt);
      console.info(`[HikCentral import] parsed "${file.name}" (${file.size} bytes) in ${elapsedMs}ms`);
      return parseHikCentralSheet(sheet);
    });
  return raceWithTimeout(parsed, HIKCENTRAL_PARSE_TIMEOUT_MS, () => {
    const elapsedMs = Math.round(performance.now() - startedAt);
    console.error(`[HikCentral import] TIMED OUT parsing "${file.name}" (${file.size} bytes) after ${elapsedMs}ms`);
    // Deliberately does NOT claim a cause (e.g. embedded images) that
    // wasn't actually detected -- the real file that triggered this
    // safeguard had no embedded media/drawings at all.
    return new HikCentralFileError(
      'The workbook could not be parsed within the allowed time. No data was imported. ' +
      'Please retry or contact the system administrator.'
    );
  });
}
