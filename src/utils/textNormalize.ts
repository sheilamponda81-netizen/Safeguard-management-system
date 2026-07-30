// Same normalization rule Employees.tsx's own normalizeText() uses for
// company/resident autocomplete matching -- shared here so the Settings ->
// Data Cleanup duplicate-detection tab groups names exactly the same way
// employees are already being matched against when someone types a new one.
export const normalizeForDedup = (value: string | null | undefined): string => {
  if (!value) return '';

  let normalized = value.trim().replace(/\s+/g, ' ');
  normalized = normalized.toUpperCase();
  normalized = normalized.replace(/[^A-Z0-9\s-]/g, '');
  normalized = normalized.replace(/\s+/g, ' ');

  return normalized;
};
