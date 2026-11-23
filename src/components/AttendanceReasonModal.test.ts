import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Final Phase 2 release review: AttendanceReasonModal replaces
// Attendance.tsx's former window.prompt() reason collection. Same
// source-pinning precedent as Attendance.monthlyRegisterRpc.test.ts
// (no @testing-library/react in this repo; vitest.config.ts runs in
// the 'node' environment, not 'jsdom').
const source = fs.readFileSync(path.resolve(__dirname, './AttendanceReasonModal.tsx'), 'utf-8');

describe('AttendanceReasonModal', () => {
  it('is built from this app\'s own Modal/Input/Button primitives, never a native window.prompt/confirm/alert', () => {
    expect(source).toMatch(/import \{ Modal, Button, Input \} from '\.\/ui';/);
    expect(source).not.toMatch(/window\.(prompt|confirm|alert)/);
  });

  it('resets the reason field every time the dialog (re)opens, so a leftover value can never be silently reused for a different employee/date/status change', () => {
    expect(source).toMatch(/useEffect\(\(\) => \{\s*if \(open\) setReason\(''\);\s*\}, \[open\]\);/);
  });

  it('disables Confirm until the trimmed reason is non-empty, and never calls onConfirm with an empty/whitespace-only reason', () => {
    expect(source).toMatch(/const trimmed = reason\.trim\(\);/);
    expect(source).toMatch(/<Button type="submit" variant="primary" disabled=\{!trimmed\}>/);
    expect(source).toMatch(/if \(!trimmed\) return;/);
    expect(source).toMatch(/onConfirm\(trimmed\)/);
  });

  it('Cancel calls onClose directly, never onConfirm, and is a plain (non-submit) button so it can never trigger the form submit handler', () => {
    expect(source).toMatch(/<Button type="button" variant="outline" onClick=\{onClose\}>Cancel<\/Button>/);
  });

  it('submits via a real <form>, not an onClick-only Confirm button -- Enter in the field submits too, matching ordinary accessible form semantics', () => {
    expect(source).toMatch(/<form onSubmit=\{handleSubmit\}/);
    expect(source).toMatch(/e\.preventDefault\(\);/);
  });

  it('labels the reason field via Input\'s own label prop (not a bare placeholder), so it has a real accessible name', () => {
    expect(source).toMatch(/label="Reason"/);
  });

  it('Restore fast manual entry: explains that the PREVIOUS status was automatically calculated, since this dialog now only ever opens to override an automatic decision (never for an ordinary manual-to-manual change)', () => {
    expect(source).toMatch(/was automatically calculated as/);
    expect(source).toMatch(/Overriding it to/);
  });
});
