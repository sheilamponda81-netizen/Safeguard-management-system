// HikCentral Attendance MVP -- targeted OOXML (.xlsx) grid reader.
//
// WHY THIS EXISTS (replacing `read-excel-file`): a real HikCentral export
// (~85 KB, 1,276 event rows, 18 columns, two duplicate "Captured Picture"
// headers) was retested against PR #44's STAGING Preview and left the
// import UI stuck on "Parsing file..." until the app's own 90-second
// safety timeout fired -- `read-excel-file` gives no way to diagnose or
// bound that. Investigation confirmed the real workbook contains NO
// embedded media/drawings and NO sharedStrings.xml (every text cell is
// `t="inlineStr"`), so the fix is not "stop decompressing images" (that
// was already correctly skipped) -- it's to stop depending on a
// general-purpose library at all for a workbook shape this narrow, and
// read exactly the parts this feature needs.
//
// This reader:
//   - Opens the .xlsx (a .zip) with JSZip (already a project dependency).
//   - Reads ONLY xl/workbook.xml, xl/_rels/workbook.xml.rels, the
//     resolved target worksheet's XML, and xl/sharedStrings.xml (if
//     present -- optional per the OOXML spec, and absent from the real
//     file, but supported for a future export that uses it instead of
//     inline strings).
//   - Never reads xl/media/*, xl/drawings/*, or xl/styles.xml. Styles are
//     deliberately skipped: this reader never manufactures a `Date`
//     value from a numeric+date-format cell (unlike `read-excel-file`),
//     because the real file stores "Time" as an inline-string wall-clock
//     value (e.g. "2026-09-28 07:27:44"), which
//     hikcentralExcelParser.ts's parseHikCentralTimeToUtcIso() already
//     parses directly as a string -- so no styles.xml-driven date
//     detection is needed for this feature to be correct.
//   - Parses XML with the browser's native `DOMParser` (no regex-only
//     XML handling).
//
// Returns the SAME row-grid shape (`SheetRow[]`, one entry per 1-based
// row number, sparse cells padded with `null`) that
// hikcentralExcelParser.ts's parseHikCentralSheet() already consumes, so
// that pure, already-tested business logic needed no changes at all.

import JSZip from 'jszip';
import { SheetCell, SheetRow, HikCentralFileError } from './hikcentralExcelParser';

export interface HikCentralOoxmlReaderLimits {
  /** Bytes, measured on the original (compressed) .xlsx file. */
  maxZipBytes: number;
  /** Bytes, measured on the target worksheet's XML AFTER decompression. */
  maxWorksheetXmlBytes: number;
  /** 1-based row numbers above this are rejected. */
  maxRows: number;
  /** 1-based column numbers above this are rejected. */
  maxColumns: number;
}

// Generous on purpose (per the approved requirements: "legitimate
// HikCentral exports with several thousand or tens of thousands of
// events still work"). The real file is 1,276 rows / 18 columns / ~85 KB
// -- these ceilings are 100x-1000x that, which comfortably covers organic
// growth while still rejecting a pathological or hostile file (e.g. the
// "phantom row number in the millions" class of bug this reader's row-gap
// handling was specifically designed to bound -- see maxRows below).
export const DEFAULT_HIKCENTRAL_OOXML_LIMITS: HikCentralOoxmlReaderLimits = {
  maxZipBytes: 50 * 1024 * 1024,
  maxWorksheetXmlBytes: 100 * 1024 * 1024,
  maxRows: 200_000,
  maxColumns: 500,
};

const CELL_REF_PATTERN = /^([A-Za-z]+)(\d+)$/;
const DIMENSION_PATTERN = /^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/;

function columnLettersToNumber(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.toUpperCase().charCodeAt(i) - 64);
  }
  return n;
}

function parseCellRef(ref: string): { row: number; col0: number } {
  const match = CELL_REF_PATTERN.exec(ref);
  if (!match) {
    throw new HikCentralFileError(`This file's worksheet data is malformed (invalid cell reference "${ref}").`);
  }
  return { row: Number(match[2]), col0: columnLettersToNumber(match[1]) - 1 };
}

function parseXml(xmlText: string, whatForErrorMessage: string): Document {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new HikCentralFileError(`This file's ${whatForErrorMessage} could not be parsed (malformed XML).`);
  }
  return doc;
}

/**
 * Concatenates the text of a `<t/>` (simple) or one-or-more `<r><t/></r>`
 * (rich-text run) children of a `<si/>` (shared string) or `<is/>`
 * (inline string) element. `<rPh/>` (East Asian phonetic guide) content
 * is intentionally ignored, matching how every mainstream XLSX reader
 * treats it -- it's a pronunciation aid, never the cell's real value.
 */
function extractStringValue(container: Element): string {
  const directT = Array.from(container.children).find((c) => c.tagName === 't');
  if (directT) return directT.textContent || '';
  const runs = Array.from(container.children).filter((c) => c.tagName === 'r');
  if (runs.length > 0) {
    return runs
      .map((run) => {
        const t = Array.from(run.children).find((c) => c.tagName === 't');
        return t ? t.textContent || '' : '';
      })
      .join('');
  }
  return '';
}

function parseSharedStrings(xmlText: string): string[] {
  const doc = parseXml(xmlText, 'shared strings data');
  const siElements = Array.from(doc.getElementsByTagName('si'));
  return siElements.map((si) => extractStringValue(si));
}

function getRequiredZipEntry(zip: JSZip, path: string, whatForErrorMessage: string): JSZip.JSZipObject {
  const entry = zip.file(path);
  if (!entry) {
    throw new HikCentralFileError(`This does not look like a valid Excel workbook (missing ${whatForErrorMessage}).`);
  }
  return entry;
}

/** Mirrors the relationship-target-resolution rule real XLSX writers rely on. */
function resolveRelationshipTarget(target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  return `xl/${target}`;
}

/**
 * Resolves the FIRST worksheet listed in `xl/workbook.xml` to its actual
 * zip path, via `xl/_rels/workbook.xml.rels` -- never assumes
 * "worksheets/sheet1.xml" is the right file, since that's only a
 * (very common but not guaranteed) convention.
 */
async function resolveFirstWorksheetPath(zip: JSZip): Promise<string> {
  const workbookXml = await getRequiredZipEntry(zip, 'xl/workbook.xml', 'workbook data').async('string');
  const workbookDoc = parseXml(workbookXml, 'workbook data');
  const sheetElements = workbookDoc.getElementsByTagName('sheet');
  if (sheetElements.length === 0) {
    throw new HikCentralFileError('This workbook has no worksheets.');
  }
  const firstSheet = sheetElements[0];
  const relationId = firstSheet.getAttribute('r:id') || firstSheet.getAttribute('id');
  if (!relationId) {
    throw new HikCentralFileError("Could not find the workbook's worksheet data (missing worksheet relationship).");
  }

  const relsXml = await getRequiredZipEntry(zip, 'xl/_rels/workbook.xml.rels', 'workbook relationships').async(
    'string'
  );
  const relsDoc = parseXml(relsXml, 'workbook relationships');
  const relationshipElements = Array.from(relsDoc.getElementsByTagName('Relationship'));
  const matching = relationshipElements.find((r) => r.getAttribute('Id') === relationId);
  if (!matching) {
    throw new HikCentralFileError("Could not find the workbook's worksheet data (missing worksheet relationship).");
  }
  const target = matching.getAttribute('Target');
  if (!target) {
    throw new HikCentralFileError("Could not find the workbook's worksheet data (missing worksheet relationship).");
  }
  return resolveRelationshipTarget(target);
}

function checkDeclaredDimension(worksheetDoc: Document, limits: HikCentralOoxmlReaderLimits): void {
  const dimensionElements = worksheetDoc.getElementsByTagName('dimension');
  if (dimensionElements.length === 0) return;
  const ref = dimensionElements[0].getAttribute('ref');
  if (!ref) return;
  const match = DIMENSION_PATTERN.exec(ref);
  if (!match) return; // e.g. a single-cell "A1" dimension -- not absurd, nothing to check.
  const rowCount = Number(match[4]);
  const colCount = columnLettersToNumber(match[3]);
  if (rowCount > limits.maxRows || colCount > limits.maxColumns) {
    throw new HikCentralFileError(
      `This file declares more rows/columns (${rowCount} rows, ${colCount} columns) than are supported ` +
      `(max ${limits.maxRows} rows, ${limits.maxColumns} columns).`
    );
  }
}

function parseCellValue(cellEl: Element, sharedStrings: string[]): SheetCell {
  const type = cellEl.getAttribute('t');
  if (type === 'inlineStr') {
    const isEl = Array.from(cellEl.children).find((c) => c.tagName === 'is');
    return isEl ? extractStringValue(isEl) : null;
  }
  const vEl = Array.from(cellEl.children).find((c) => c.tagName === 'v');
  const vText = vEl ? vEl.textContent : null;
  if (vText === null || vText === undefined || vText === '') {
    // 'e' (formula error) and a formula cell whose cached result is
    // absent are both treated as blank, matching hikcentralExcelParser's
    // existing tolerance for "malformed → row-level error, not a crash".
    return null;
  }
  switch (type) {
    case 's': {
      const index = Number(vText);
      return Number.isInteger(index) && index >= 0 && index < sharedStrings.length ? sharedStrings[index] : null;
    }
    case 'str':
      return vText;
    case 'b':
      return vText === '1';
    case 'e':
      return null;
    default:
      // No `t` attribute, or `t="n"` -- numeric, per the OOXML default.
      // Deliberately never converted to a `Date` here (see this file's
      // header comment) -- callers that need a date value already parse
      // it from an inline/shared STRING cell instead.
      { const n = Number(vText); return Number.isNaN(n) ? null : n; }
  }
}

function parseWorksheetRows(
  worksheetDoc: Document,
  sharedStrings: string[],
  limits: HikCentralOoxmlReaderLimits
): SheetRow[] {
  const sheetDataElements = worksheetDoc.getElementsByTagName('sheetData');
  if (sheetDataElements.length === 0) return [];
  const rowElements = Array.from(sheetDataElements[0].children).filter((c) => c.tagName === 'row');

  const rows: SheetRow[] = [];
  for (const rowEl of rowElements) {
    const rAttr = rowEl.getAttribute('r');
    if (!rAttr) {
      throw new HikCentralFileError("This file's worksheet data is malformed (a <row> is missing its row number).");
    }
    const rowNumber = Number(rAttr);
    if (!Number.isInteger(rowNumber) || rowNumber < 1) {
      throw new HikCentralFileError(`This file's worksheet data is malformed (invalid row number "${rAttr}").`);
    }
    if (rowNumber > limits.maxRows) {
      throw new HikCentralFileError(`This file has more rows than are supported (max ${limits.maxRows}).`);
    }
    // Fill any gap between the last row we recorded and this one --
    // preserves row-number-to-array-index alignment, exactly like the
    // grid hikcentralExcelParser.ts already expects (it infers each
    // row's number purely from array position).
    while (rows.length < rowNumber - 1) rows.push([]);

    const rowArr: SheetCell[] = [];
    const cellElements = Array.from(rowEl.children).filter((c) => c.tagName === 'c');
    for (const cellEl of cellElements) {
      const ref = cellEl.getAttribute('r');
      if (!ref) {
        throw new HikCentralFileError("This file's worksheet data is malformed (a <c> is missing its cell reference).");
      }
      const { col0 } = parseCellRef(ref);
      if (col0 >= limits.maxColumns) {
        throw new HikCentralFileError(`This file has more columns than are supported (max ${limits.maxColumns}).`);
      }
      // Gap-fill blank cells between this one and the previous one in
      // this row, so column POSITION (not just presence) is preserved --
      // required for hikcentralExcelParser.ts's header-index lookups to
      // stay correct on a sparse row.
      while (rowArr.length < col0) rowArr.push(null);
      rowArr[col0] = parseCellValue(cellEl, sharedStrings);
    }
    rows.push(rowArr);
  }
  return rows;
}

/**
 * Reads an in-memory `.xlsx` file's first worksheet into the same
 * `SheetRow[]` grid shape `read-excel-file`'s `readSheet()` used to
 * produce -- see this file's header comment for why, and what's
 * deliberately NOT read (media, drawings, styles).
 */
export async function readHikCentralWorkbookGrid(
  bytes: ArrayBuffer | Uint8Array,
  limits: HikCentralOoxmlReaderLimits = DEFAULT_HIKCENTRAL_OOXML_LIMITS
): Promise<SheetRow[]> {
  const byteLength = bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.byteLength;
  if (byteLength > limits.maxZipBytes) {
    throw new HikCentralFileError(
      `This file (${(byteLength / (1024 * 1024)).toFixed(1)} MB) is larger than the maximum supported size ` +
      `(${(limits.maxZipBytes / (1024 * 1024)).toFixed(0)} MB).`
    );
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new HikCentralFileError('This file could not be read as a valid Excel (.xlsx) file.');
  }

  const worksheetPath = await resolveFirstWorksheetPath(zip);
  const worksheetEntry = getRequiredZipEntry(zip, worksheetPath, 'worksheet data');
  const worksheetXml = await worksheetEntry.async('string');
  if (worksheetXml.length > limits.maxWorksheetXmlBytes) {
    throw new HikCentralFileError(
      `This file's worksheet data is larger than the maximum supported size ` +
      `(${(limits.maxWorksheetXmlBytes / (1024 * 1024)).toFixed(0)} MB uncompressed).`
    );
  }

  const sharedStringsEntry = zip.file('xl/sharedStrings.xml');
  const sharedStrings = sharedStringsEntry ? parseSharedStrings(await sharedStringsEntry.async('string')) : [];

  const worksheetDoc = parseXml(worksheetXml, 'worksheet data');
  checkDeclaredDimension(worksheetDoc, limits);
  return parseWorksheetRows(worksheetDoc, sharedStrings, limits);
}
