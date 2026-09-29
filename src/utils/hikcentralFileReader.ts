// Browser-only entry point: reads a File (e.g. from an <input
// type="file">) into the raw grid parseHikCentralSheet() expects. Kept
// as its own tiny module, separate from hikcentralExcelParser.ts, so the
// parser itself stays a pure function of already-loaded data with no
// dependency on `read-excel-file/browser` -- tests exercise the parser
// via `read-excel-file/node` against an in-memory buffer instead (see
// hikcentralExcelParser.test.ts), and neither environment pulls in the
// other's library build.
import { readSheet } from 'read-excel-file/browser';
import { parseHikCentralSheet, HikCentralParseResult, SheetRow, HikCentralFileError } from './hikcentralExcelParser';

// A real HikCentral export tested against PR #44's STAGING Preview
// (2026-09-29, 1,276 event rows, the export's two "Captured Picture"
// columns) was observed stuck on "Parsing file..." past 5 minutes with
// no error. `read-excel-file` gives no built-in cancellation or progress
// signal, so without a bound here a slow/pathological file leaves
// HikCentralImportPage's `setParsing(false)` (in its existing
// try/finally) waiting on a promise that may never settle -- an
// indefinite spinner, not a crash. This timeout guarantees the promise
// this module returns ALWAYS settles, so the caller's finally block
// always runs. It reports file size/elapsed time to explain *why* it
// gave up rather than just hiding a slow parse behind a generic error.
export const HIKCENTRAL_PARSE_TIMEOUT_MS = 90_000;

/**
 * Resolves/rejects exactly as `promise` does, unless `timeoutMs` elapses
 * first, in which case it rejects with `onTimeout()`'s error instead.
 * `promise` itself is never cancelled (the underlying library offers no
 * way to do that) -- it's left to settle in the background, with its
 * eventual result/error silently discarded so it can never surface as an
 * unhandled rejection after the caller has already moved on.
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
  const parsed = readSheet(file, 1).then((sheet) => {
    const elapsedMs = Math.round(performance.now() - startedAt);
    // eslint-disable-next-line no-console
    console.info(`[HikCentral import] parsed "${file.name}" (${file.size} bytes) in ${elapsedMs}ms`);
    return parseHikCentralSheet(sheet as unknown as SheetRow[]);
  });
  return raceWithTimeout(parsed, HIKCENTRAL_PARSE_TIMEOUT_MS, () => {
    const elapsedMs = Math.round(performance.now() - startedAt);
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    // eslint-disable-next-line no-console
    console.error(`[HikCentral import] TIMED OUT parsing "${file.name}" (${file.size} bytes) after ${elapsedMs}ms`);
    return new HikCentralFileError(
      `This file is taking too long to parse (over ${Math.round(HIKCENTRAL_PARSE_TIMEOUT_MS / 1000)}s for a ${sizeMb} MB file) ` +
      `and has been stopped rather than leaving the page stuck. This usually means the export contains large embedded ` +
      `images (e.g. the "Captured Picture" columns) that are slowing down parsing. Try re-exporting without captured-picture ` +
      `images, or report this file's size and row count if the problem continues.`
    );
  });
}
