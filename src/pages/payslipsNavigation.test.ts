import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// HOTFIX: test item 15 from the hotfix's required 15-item test list --
// "Go to Payroll uses internal navigation and does not hard-load
// /payroll." This SPA (see App.tsx) has no URL router and no Vercel
// rewrite rule for any path other than `/`, so a hard
// `window.location.href = '/payroll'` navigation 404s -- confirmed root
// cause of the production bug report. This repo has no React component-
// rendering test infrastructure (no @testing-library/react dependency),
// so a full click-through test of the button isn't available; this test
// instead pins the exact regression at the source level -- both that the
// specific broken pattern is gone, and that the fixed pattern (calling the
// onNavigate prop threaded down from App.tsx) is present -- so the bug
// cannot silently return through a future edit.
const payslipsSource = fs.readFileSync(
  path.resolve(__dirname, './Payslips.tsx'),
  'utf-8'
);

describe('Payslips "Go to Payroll" navigation (HOTFIX test item 15)', () => {
  it('no longer hard-navigates via window.location.href to /payroll', () => {
    expect(payslipsSource).not.toMatch(/window\.location\.href\s*=\s*['"]\/payroll['"]/);
  });

  it('uses the internal onNavigate callback instead', () => {
    expect(payslipsSource).toMatch(/onNavigate\(\s*['"]payroll['"]\s*\)/);
  });

  it('PayslipsPage declares an onNavigate prop (so App.tsx can thread its in-memory nav callback down)', () => {
    expect(payslipsSource).toMatch(/onNavigate\??\s*:/);
  });
});
