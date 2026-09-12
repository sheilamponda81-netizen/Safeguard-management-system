// Pure helper for Recruitment.tsx's Edit Applicant feature, extracted so
// the one guarantee that matters most -- an Edit save can NEVER touch
// interview_status, decision, or region_id -- is directly provable in a
// unit test rather than only inspectable by reading the component.

export interface ApplicantEditFields {
  name: string;
  position: string;
  qualification?: string;
  phone?: string;
  email?: string;
  experience?: string;
  coverLetter?: string;
}

export interface ApplicantUpdatePatch {
  name: string;
  position: string;
  qualification?: string;
  phone?: string;
  email?: string;
  experience?: string;
  cover_letter: string | null;
}

// Builds the exact patch sent to `applicants` on an Edit save -- and ONLY
// this patch. There is deliberately no parameter, code path, or spread
// that could smuggle interview_status/decision/region_id into the
// result: those are the fields that must never change as a side effect
// of an Edit meant purely to correct administrative details (a typo'd
// phone number, a corrected qualification) -- pipeline status changes go
// through Recruitment.tsx's separate update() function, and region
// reassignment isn't exposed by the Edit form at all (also blocked
// server-side by trg_guard_applicant_region_assignment for anyone but an
// Admin).
export function buildApplicantUpdatePatch(fields: ApplicantEditFields): ApplicantUpdatePatch {
  return {
    name: fields.name,
    position: fields.position,
    qualification: fields.qualification,
    phone: fields.phone,
    email: fields.email,
    experience: fields.experience,
    cover_letter: fields.coverLetter || null,
  };
}
