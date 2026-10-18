// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readHikCentralWorkbookGrid, DEFAULT_HIKCENTRAL_OOXML_LIMITS } from './hikcentralOoxmlReader';
import { HikCentralFileError } from './hikcentralExcelParser';

// Low-level fixture builder, deliberately independent of
// testFixtures/buildTestXlsx.ts (which only ever produces well-formed,
// all-inlineStr workbooks from a row grid) -- these tests need to inject
// sharedStrings.xml, sparse/omitted cells, malformed XML, and missing
// relationships directly, which requires raw XML control.
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

const WORKBOOK_RELS_XML_NO_MATCH = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdDifferent" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

interface FixtureOptions {
  worksheetXml: string;
  sharedStringsXml?: string;
  workbookRelsXml?: string;
  omitWorkbookRels?: boolean;
}

async function buildRawFixture(options: FixtureOptions): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES_XML);
  zip.file('_rels/.rels', ROOT_RELS_XML);
  zip.file('xl/workbook.xml', WORKBOOK_XML);
  if (!options.omitWorkbookRels) {
    zip.file('xl/_rels/workbook.xml.rels', options.workbookRelsXml ?? WORKBOOK_RELS_XML);
  }
  zip.file('xl/worksheets/sheet1.xml', options.worksheetXml);
  if (options.sharedStringsXml) {
    zip.file('xl/sharedStrings.xml', options.sharedStringsXml);
  }
  return zip.generateAsync({ type: 'arraybuffer' });
}

function worksheetXml(sheetDataInner: string, dimensionRef?: string): string {
  const dimension = dimensionRef ? `<dimension ref="${dimensionRef}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${dimension}
<sheetData>${sheetDataInner}</sheetData>
</worksheet>`;
}

describe('readHikCentralWorkbookGrid', () => {
  it('reads an inlineStr-only workbook (matches the real HikCentral export, which has no sharedStrings.xml)', async () => {
    const xml = worksheetXml(
      `<row r="1"><c r="A1" t="inlineStr"><is><t>Person No.</t></is></c><c r="B1" t="inlineStr"><is><t>Name</t></is></c></row>` +
      `<row r="2"><c r="A2" t="inlineStr"><is><t>00000174</t></is></c><c r="B2" t="inlineStr"><is><t>Test Person</t></is></c></row>`
    );
    const buffer = await buildRawFixture({ worksheetXml: xml });
    const grid = await readHikCentralWorkbookGrid(buffer);
    expect(grid).toEqual([
      ['Person No.', 'Name'],
      ['00000174', 'Test Person'],
    ]);
  });

  it('works correctly when xl/sharedStrings.xml is entirely absent from the archive', async () => {
    const xml = worksheetXml(`<row r="1"><c r="A1" t="inlineStr"><is><t>only inline</t></is></c></row>`);
    const buffer = await buildRawFixture({ worksheetXml: xml });
    const grid = await readHikCentralWorkbookGrid(buffer);
    expect(grid).toEqual([['only inline']]);
  });

  it('resolves shared-string cells (t="s") by index when xl/sharedStrings.xml IS present', async () => {
    const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
<si><t>00000174</t></si>
<si><t>Second String</t></si>
</sst>`;
    const xml = worksheetXml(
      `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>`
    );
    const buffer = await buildRawFixture({ worksheetXml: xml, sharedStringsXml: sharedStrings });
    const grid = await readHikCentralWorkbookGrid(buffer);
    expect(grid).toEqual([['00000174', 'Second String']]);
  });

  it('resolves a shared string built from multiple rich-text <r><t/></r> runs, concatenated in order', async () => {
    const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<si><r><t>Hello, </t></r><r><t>World</t></r></si>
</sst>`;
    const xml = worksheetXml(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`);
    const buffer = await buildRawFixture({ worksheetXml: xml, sharedStringsXml: sharedStrings });
    const grid = await readHikCentralWorkbookGrid(buffer);
    expect(grid).toEqual([['Hello, World']]);
  });

  it('handles sparse rows and sparse cells within a row, padding gaps with null', async () => {
    // Row 1: cells at A and C only (B skipped). Rows 2-4 entirely missing. Row 5 has one cell.
    const xml = worksheetXml(
      `<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="C1" t="inlineStr"><is><t>c</t></is></c></row>` +
      `<row r="5"><c r="B5" t="inlineStr"><is><t>b5</t></is></c></row>`
    );
    const buffer = await buildRawFixture({ worksheetXml: xml });
    const grid = await readHikCentralWorkbookGrid(buffer);
    expect(grid).toEqual([
      ['a', null, 'c'],
      [],
      [],
      [],
      [null, 'b5'],
    ]);
  });

  it('preserves duplicate "Captured Picture" headers as two distinct columns by position', async () => {
    const xml = worksheetXml(
      `<row r="1">` +
      `<c r="A1" t="inlineStr"><is><t>Captured Picture</t></is></c>` +
      `<c r="B1" t="inlineStr"><is><t>Captured Picture</t></is></c>` +
      `<c r="C1" t="inlineStr"><is><t>Person No.</t></is></c>` +
      `</row>`
    );
    const buffer = await buildRawFixture({ worksheetXml: xml });
    const grid = await readHikCentralWorkbookGrid(buffer);
    expect(grid[0]).toEqual(['Captured Picture', 'Captured Picture', 'Person No.']);
  });

  it('treats a cell with no <v>/<is> child as blank (null)', async () => {
    const xml = worksheetXml(`<row r="1"><c r="A1"/><c r="B1" t="inlineStr"><is><t>present</t></is></c></row>`);
    const buffer = await buildRawFixture({ worksheetXml: xml });
    const grid = await readHikCentralWorkbookGrid(buffer);
    expect(grid).toEqual([[null, 'present']]);
  });

  it('preserves "00000174" exactly as text, never coercing to the number 174', async () => {
    const xml = worksheetXml(`<row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve">00000174</t></is></c></row>`);
    const buffer = await buildRawFixture({ worksheetXml: xml });
    const grid = await readHikCentralWorkbookGrid(buffer);
    expect(grid[0][0]).toBe('00000174');
    expect(typeof grid[0][0]).toBe('string');
  });

  it('reads a plain numeric cell (no t attribute) as a JS number', async () => {
    const xml = worksheetXml(`<row r="1"><c r="A1"><v>42</v></c></row>`);
    const buffer = await buildRawFixture({ worksheetXml: xml });
    const grid = await readHikCentralWorkbookGrid(buffer);
    expect(grid[0][0]).toBe(42);
    expect(typeof grid[0][0]).toBe('number');
  });

  it('rejects malformed XML with a clear HikCentralFileError', async () => {
    const malformed = '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"';
    const buffer = await buildRawFixture({ worksheetXml: malformed });
    await expect(readHikCentralWorkbookGrid(buffer)).rejects.toThrow(HikCentralFileError);
    await expect(readHikCentralWorkbookGrid(buffer)).rejects.toThrow(/malformed XML/);
  });

  it('rejects a workbook whose worksheet relationship cannot be resolved (no matching Relationship Id)', async () => {
    const xml = worksheetXml(`<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>`);
    const buffer = await buildRawFixture({ worksheetXml: xml, workbookRelsXml: WORKBOOK_RELS_XML_NO_MATCH });
    await expect(readHikCentralWorkbookGrid(buffer)).rejects.toThrow(/worksheet relationship/);
  });

  it('rejects a workbook missing xl/_rels/workbook.xml.rels entirely', async () => {
    const xml = worksheetXml(`<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>`);
    const buffer = await buildRawFixture({ worksheetXml: xml, omitWorkbookRels: true });
    await expect(readHikCentralWorkbookGrid(buffer)).rejects.toThrow(HikCentralFileError);
  });

  it('rejects a declared <dimension> that exceeds the configured row/column limits, without walking the sheet data', async () => {
    const xml = worksheetXml(
      `<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>`,
      'A1:A500000'
    );
    const buffer = await buildRawFixture({ worksheetXml: xml });
    await expect(
      readHikCentralWorkbookGrid(buffer, { ...DEFAULT_HIKCENTRAL_OOXML_LIMITS, maxRows: 200_000 })
    ).rejects.toThrow(/more rows\/columns/);
  });

  it('rejects a row number that exceeds the configured row limit while parsing (defense in depth even without a <dimension>)', async () => {
    const xml = worksheetXml(`<row r="999"><c r="A999" t="inlineStr"><is><t>x</t></is></c></row>`);
    const buffer = await buildRawFixture({ worksheetXml: xml });
    await expect(
      readHikCentralWorkbookGrid(buffer, { ...DEFAULT_HIKCENTRAL_OOXML_LIMITS, maxRows: 100 })
    ).rejects.toThrow(/more rows than are supported/);
  });

  it('rejects a column position that exceeds the configured column limit', async () => {
    const xml = worksheetXml(`<row r="1"><c r="ZZ1" t="inlineStr"><is><t>x</t></is></c></row>`);
    const buffer = await buildRawFixture({ worksheetXml: xml });
    await expect(
      readHikCentralWorkbookGrid(buffer, { ...DEFAULT_HIKCENTRAL_OOXML_LIMITS, maxColumns: 10 })
    ).rejects.toThrow(/more columns than are supported/);
  });

  it('rejects worksheet XML larger than the configured uncompressed-size limit', async () => {
    const bigInline = 'x'.repeat(1000);
    const xml = worksheetXml(`<row r="1"><c r="A1" t="inlineStr"><is><t>${bigInline}</t></is></c></row>`);
    const buffer = await buildRawFixture({ worksheetXml: xml });
    await expect(
      readHikCentralWorkbookGrid(buffer, { ...DEFAULT_HIKCENTRAL_OOXML_LIMITS, maxWorksheetXmlBytes: 500 })
    ).rejects.toThrow(/worksheet data is larger/);
  });

  it('rejects a file larger than the configured compressed-size limit', async () => {
    const xml = worksheetXml(`<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>`);
    const buffer = await buildRawFixture({ worksheetXml: xml });
    await expect(
      readHikCentralWorkbookGrid(buffer, { ...DEFAULT_HIKCENTRAL_OOXML_LIMITS, maxZipBytes: 10 })
    ).rejects.toThrow(/larger than the maximum supported size/);
  });

  it('rejects bytes that are not a valid ZIP/xlsx at all', async () => {
    const garbage = new TextEncoder().encode('this is not a zip file, just plain text').buffer;
    await expect(readHikCentralWorkbookGrid(garbage)).rejects.toThrow(HikCentralFileError);
    await expect(readHikCentralWorkbookGrid(garbage)).rejects.toThrow(/valid Excel/);
  });

  it('rejects a workbook missing xl/workbook.xml entirely', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', CONTENT_TYPES_XML);
    zip.file('_rels/.rels', ROOT_RELS_XML);
    // xl/workbook.xml deliberately omitted.
    const buffer = await zip.generateAsync({ type: 'arraybuffer' });
    await expect(readHikCentralWorkbookGrid(buffer)).rejects.toThrow(/valid Excel workbook/);
  });
});
