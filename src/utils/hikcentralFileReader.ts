// Browser-only entry point: reads a File (e.g. from an <input
// type="file">) into the raw grid parseHikCentralSheet() expects. Kept
// as its own tiny module, separate from hikcentralExcelParser.ts, so the
// parser itself stays a pure function of already-loaded data with no
// dependency on `read-excel-file/browser` -- tests exercise the parser
// via `read-excel-file/node` against an in-memory buffer instead (see
// hikcentralExcelParser.test.ts), and neither environment pulls in the
// other's library build.
import { readSheet } from 'read-excel-file/browser';
import { parseHikCentralSheet, HikCentralParseResult, SheetRow } from './hikcentralExcelParser';

export async function parseHikCentralExcelFile(file: File): Promise<HikCentralParseResult> {
  const sheet = await readSheet(file, 1);
  return parseHikCentralSheet(sheet as unknown as SheetRow[]);
}
