import { describe, it, expect } from 'vitest';
import { jsPDF } from 'jspdf';

// Real, non-mocked tests against the upgraded jsPDF (2.5.2 -> 4.2.1, fixing
// the critical GHSA-f8cm-6447-x5h2 / GHSA-wfv2-pwc8-crg5 advisories -- see
// AUDIT_REPORT.md Finding A16). These exercise the exact same jsPDF API
// surface this app actually calls -- confirmed by reading every call site
// in src/utils/clickHandlers.ts (text-only reports: setFontSize/
// setTextColor/setFont/text/addPage/line/setDrawColor/setLineWidth/save)
// and src/pages/Payslips.tsx (addImage + output('blob'), fed an
// internally-generated PNG from html2canvas, never a raw user-uploaded
// image format) -- not a mock of the library, and not a full integration
// test of either click handler (which have DOM/Supabase/notification side
// effects out of scope here), but real coverage of the upgraded library
// against this app's real input patterns and edge cases.
//
// `.save()` itself is NOT called here -- it requires a browser's Blob-
// download machinery (creates an <a> tag and clicks it), which needs a
// real DOM this test environment (Vitest, `environment: 'node'`) doesn't
// have. `.output('arraybuffer')`/`.output('blob')` -- what both real call
// sites ultimately produce before handing off to the browser -- work
// correctly in plain Node (confirmed: Node 18+ has a global `Blob`) and
// are what's actually asserted on below.

function isValidPdf(bytes: ArrayBuffer): boolean {
  const header = Buffer.from(bytes.slice(0, 5)).toString('ascii');
  return header === '%PDF-';
}

describe('jsPDF 4.2.1 -- text-report path (src/utils/clickHandlers.ts pattern)', () => {
  it('renders employee/department names containing quotes, brackets, and HTML-like text without throwing or executing them', () => {
    const pdf = new jsPDF();
    const dangerousStrings = [
      `O'Brien "The Guard" [Night Shift]`,
      `<script>alert(1)</script>`,
      `Department & Co. <b>Bold</b>`,
      `Name; DROP TABLE employees;--`,
    ];
    expect(() => {
      let y = 20;
      for (const s of dangerousStrings) {
        pdf.text(s, 10, y);
        y += 10;
      }
    }).not.toThrow();

    const out = pdf.output('arraybuffer');
    expect(isValidPdf(out)).toBe(true);
    // The dangerous strings are drawn as literal PDF text-showing
    // operators (glyphs), not interpreted as markup/SQL/script -- the
    // produced PDF bytes contain no raw '<script>' tag text un-escaped
    // into a content stream in a way a PDF viewer would ever execute
    // (PDF has no HTML/script execution model for page content at all;
    // the real risk class here is jsPDF's own addJS/AcroForm APIs, which
    // this app never calls -- see the dedicated /JavaScript-object test
    // below for that check against the produced bytes directly).
  });

  it('renders Unicode names (CJK, accented Latin, emoji) without throwing', () => {
    const pdf = new jsPDF();
    expect(() => {
      pdf.text('José García Muñoz', 10, 20);
      pdf.text('中文姓名测试', 10, 30);
      pdf.text('Employee 👷 Guard 🛡️', 10, 40);
    }).not.toThrow();
    expect(isValidPdf(pdf.output('arraybuffer'))).toBe(true);
  });

  it('renders a very long single text value (long department/name string) without hanging or throwing (ReDoS regression check for GHSA-w532-jxjh-hjhj)', () => {
    const pdf = new jsPDF();
    const longString = 'A'.repeat(5000) + ' ' + 'B'.repeat(5000);
    const start = Date.now();
    expect(() => pdf.text(longString, 10, 20)).not.toThrow();
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(2000); // generous bound -- a ReDoS would hang far longer than this
    expect(isValidPdf(pdf.output('arraybuffer'))).toBe(true);
  });

  it('renders currency-formatted payroll/deduction amounts (large, negative, decimal) as plain text correctly', () => {
    const pdf = new jsPDF();
    const amounts = ['MK 1,234,567.89', 'MK -5,000.00', 'MK 0.00', 'MK 999,999,999.99'];
    expect(() => {
      let y = 20;
      for (const a of amounts) {
        pdf.text(a, 10, y);
        y += 10;
      }
    }).not.toThrow();
    expect(isValidPdf(pdf.output('arraybuffer'))).toBe(true);
  });

  it('handles a large batch (200 rows) across multiple pages without throwing, matching the real report generator\'s addPage-on-overflow pattern', () => {
    const pdf = new jsPDF();
    let y = 20;
    expect(() => {
      for (let i = 0; i < 200; i++) {
        pdf.text(`Department ${i}: 12 employees | MK ${(i * 137931).toLocaleString()}`, 10, y);
        y += 6;
        if (y > 270) {
          pdf.addPage();
          y = 20;
        }
      }
    }).not.toThrow();
    const out = pdf.output('arraybuffer');
    expect(isValidPdf(out)).toBe(true);
    expect(pdf.getNumberOfPages()).toBeGreaterThan(1);
  });

  it('does not embed any /JavaScript action object in the produced PDF for a normal report (no addJS ever called)', () => {
    const pdf = new jsPDF();
    pdf.text('Normal report content', 10, 20);
    const out = pdf.output('arraybuffer');
    const text = Buffer.from(out).toString('latin1');
    // jsPDF 4.x's own default output includes a benign /OpenAction
    // (a plain "fit page width on open" viewer directive, e.g.
    // `/OpenAction [3 0 R /FitH null]` -- confirmed by inspecting this
    // exact test's own output) -- that alone is not a security concern
    // and this test does NOT ban it. What matters is that no action is
    // an actual /JavaScript (or /JS) action, which is what would let a
    // PDF execute script on open -- this app never calls addJS anywhere,
    // so no such action should ever appear.
    expect(text).not.toContain('/JavaScript');
    expect(text).not.toMatch(/\/JS\s/);
    expect(text).not.toMatch(/\/S\s*\/JavaScript/);
  });
});

describe('jsPDF 4.2.1 -- addImage path (src/pages/Payslips.tsx pattern)', () => {
  // A real, valid 1x1 PNG (not a mock) -- stands in for the html2canvas-
  // generated PNG data URL the real code path always produces internally;
  // this app never passes a raw user-uploaded image straight to addImage
  // (confirmed by reading Payslips.tsx -- the company logo is rendered via
  // an <img> tag inside the HTML that html2canvas rasterizes, not passed
  // to jsPDF directly), so a BMP/GIF-format image never reaches jsPDF's
  // own image decoder through this app's real usage.
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  it('embeds a valid PNG and outputs a valid PDF blob', () => {
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pdfWidth = pdf.internal.pageSize.getWidth();
    expect(() => pdf.addImage(tinyPng, 'PNG', 0, 0, pdfWidth, 100)).not.toThrow();
    const blob = pdf.output('blob');
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toBe('application/pdf');
  });

  it('a missing/empty image (matching a payslip whose logo failed to load) is handled as a real, catchable error -- not a silent corrupt PDF', async () => {
    const pdf = new jsPDF('p', 'mm', 'a4');
    // Payslips.tsx's own generatePDF() wraps this exact call in a
    // try/catch (confirmed by reading the source) and returns null on
    // failure rather than propagating -- this test confirms addImage
    // itself still throws a real, catchable error for malformed image
    // data (not silently producing a corrupt/empty PDF), which is what
    // that try/catch actually depends on to detect the failure.
    let threw = false;
    try {
      pdf.addImage('data:image/png;base64,NOT_VALID_IMAGE_DATA', 'PNG', 0, 0, 100, 100);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
