import JSZip from 'jszip';

// Test-only .xlsx builder. Not imported by any production page/component --
// exists purely so the HikCentral parser tests can exercise the real
// `read-excel-file` library against a genuine, hand-built OOXML file
// (rather than mocking the library's return value), without checking a
// binary fixture into git and without depending on an XLSX *writer*
// library the app has no other use for. An .xlsx is just a zip of XML
// parts; this assembles the minimal set any real spreadsheet app needs.
//
// Every text cell is written as an inline string (`t="inlineStr"`), which
// is a genuinely TEXT-typed OOXML cell -- exactly how a value like
// "00000174" must be stored for Excel itself to display the leading
// zeros (a numeric cell can only fake leading zeros via a cosmetic
// display format, and the underlying value would really be 174). This
// mirrors what a real HikCentral export must be doing, since the sample
// export's leading zeros survive when opened in Excel.

export type XlsxCell = string | number | null;
export type XlsxRow = XlsxCell[];

function columnLetter(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSheetXml(rows: XlsxRow[]): string {
  const rowsXml = rows
    .map((row, rowIndex) => {
      const rowNum = rowIndex + 1;
      const cellsXml = row
        .map((cell, colIndex) => {
          if (cell === null || cell === undefined || cell === '') return '';
          const ref = `${columnLetter(colIndex)}${rowNum}`;
          if (typeof cell === 'number') {
            return `<c r="${ref}"><v>${cell}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(cell))}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowNum}">${cellsXml}</row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${rowsXml}</sheetData>
</worksheet>`;
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
<sheet name="Sheet1" sheetId="1" r:id="rId1"/>
</sheets>
</workbook>`;

const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

/**
 * Builds a minimal but genuinely valid .xlsx file (as a Buffer) from a
 * plain grid of rows. Numbers stay numeric OOXML cells; strings
 * (including digit-only strings like "00000174") are written as
 * inline-string cells, so a real XLSX parser reads them back as text.
 */
export async function buildTestXlsx(rows: XlsxRow[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES_XML);
  zip.file('_rels/.rels', ROOT_RELS_XML);
  zip.file('xl/workbook.xml', WORKBOOK_XML);
  zip.file('xl/_rels/workbook.xml.rels', WORKBOOK_RELS_XML);
  zip.file('xl/worksheets/sheet1.xml', buildSheetXml(rows));
  return zip.generateAsync({ type: 'nodebuffer' });
}
