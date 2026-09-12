// Extracted from Reports.tsx's exportReport() (previously an inline
// `row.map(cell => ...).join(',')`) so this logic is unit-testable in
// isolation. Behavior for quoting/escaping is unchanged from what
// Reports.tsx already did; formula-injection protection is new (see
// escapeCsvCell below) -- this repo had no protection against it before.

// Characters that Excel/Google Sheets/LibreOffice treat as the start of a
// formula when a CSV cell is opened, even if the cell's value is inside
// quotes -- quoting protects against delimiter/newline problems, not
// against formula evaluation. A cell value under an attacker's control
// (e.g. an employee or applicant name field) starting with any of these
// could execute arbitrary formulas/commands when a report is opened in a
// spreadsheet application.
const FORMULA_TRIGGER_CHARS = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Escapes a single value for inclusion as one CSV cell: wraps in double
 * quotes, doubles any internal double quotes (RFC 4180), and -- if the
 * value would otherwise start with a formula-trigger character -- prefixes
 * it with a single quote so spreadsheet applications treat it as literal
 * text instead of evaluating it as a formula. The leading single quote is
 * a standard, widely-used mitigation (the same one Excel itself inserts
 * when you type a leading apostrophe to force text formatting) and does
 * not change how the value reads in a plain CSV/text viewer.
 */
export function escapeCsvCell(value: unknown): string {
  let str = String(value ?? '');
  if (FORMULA_TRIGGER_CHARS.includes(str[0])) {
    str = `'${str}`;
  }
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * Builds one CSV line from an array of cell values, comma-joined.
 */
export function toCsvRow(cells: unknown[]): string {
  return cells.map(escapeCsvCell).join(',');
}
