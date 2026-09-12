import { describe, it, expect } from 'vitest';
import { FINANCIAL_REPORT_IDS, RECRUITMENT_REPORT_IDS } from './Reports';

// Correction round 2, item 3: the first pass wrongly classified every
// report except Payroll as "operational", which put Recruitment inside
// the bucket Operations Manager (reports.operational.view) already has --
// even though Operations Manager is explicitly denied Recruitment
// everywhere else in the app. This test locks in the corrected
// classification so a future edit can't silently regress it.
describe('Reports.tsx tab classification', () => {
  it('only payroll is financial', () => {
    expect(FINANCIAL_REPORT_IDS).toEqual(['payroll']);
  });

  it('recruitment is its own category, NOT financial and NOT (implicitly) operational', () => {
    expect(RECRUITMENT_REPORT_IDS).toEqual(['recruitment']);
    expect(FINANCIAL_REPORT_IDS).not.toContain('recruitment');
  });

  it('every other tab (employee/company/workstation/attendance/department) falls through to operational by exclusion', () => {
    const otherTabs = ['employee', 'company', 'workstation', 'attendance', 'department'];
    otherTabs.forEach((tab) => {
      expect(FINANCIAL_REPORT_IDS).not.toContain(tab);
      expect(RECRUITMENT_REPORT_IDS).not.toContain(tab);
    });
  });
});
