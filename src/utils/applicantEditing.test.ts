import { describe, it, expect } from 'vitest';
import { buildApplicantUpdatePatch } from './applicantEditing';

// Regression coverage for the real staging gap: HR Manager had
// recruitment.edit granted but no Edit UI existed at all -- Shortlist/
// Interview/Hire/Reject only ever wrote interview_status/decision, never
// an applicant's own details. buildApplicantUpdatePatch is the new Edit
// save path's payload builder; these tests prove its one hard guarantee.
describe('buildApplicantUpdatePatch', () => {
  it('reflects every editable field passed in', () => {
    const patch = buildApplicantUpdatePatch({
      name: 'Jane Doe',
      position: 'Security Guard',
      qualification: 'Diploma',
      phone: '0888123456',
      email: 'jane@example.com',
      experience: '3',
      coverLetter: 'Motivated applicant.',
    });
    expect(patch).toEqual({
      name: 'Jane Doe',
      position: 'Security Guard',
      qualification: 'Diploma',
      phone: '0888123456',
      email: 'jane@example.com',
      experience: '3',
      cover_letter: 'Motivated applicant.',
    });
  });

  it('never includes interview_status, decision, or region_id -- an Edit save can never reset pipeline status or move regions', () => {
    const patch = buildApplicantUpdatePatch({ name: 'Jane Doe', position: 'Security Guard' });
    expect(patch).not.toHaveProperty('interview_status');
    expect(patch).not.toHaveProperty('decision');
    expect(patch).not.toHaveProperty('region_id');
  });

  it('maps an empty cover letter to null, not an empty string, matching the Add Applicant path', () => {
    const patch = buildApplicantUpdatePatch({ name: 'Jane Doe', position: 'Security Guard', coverLetter: '' });
    expect(patch.cover_letter).toBeNull();
  });

  it('maps a missing cover letter to null', () => {
    const patch = buildApplicantUpdatePatch({ name: 'Jane Doe', position: 'Security Guard' });
    expect(patch.cover_letter).toBeNull();
  });

  it('preserves a real cover letter unchanged', () => {
    const patch = buildApplicantUpdatePatch({ name: 'Jane Doe', position: 'Security Guard', coverLetter: 'Real letter text' });
    expect(patch.cover_letter).toBe('Real letter text');
  });
});
