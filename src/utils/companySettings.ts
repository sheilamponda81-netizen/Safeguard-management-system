import { supabase } from '../lib/supabase';

export interface CompanyInfo {
  companyName: string;
  registration: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  taxId: string;
  pensionReg: string;
  logoUrl: string;
}

export const DEFAULT_COMPANY_INFO: CompanyInfo = {
  companyName: 'Safeguard Security Services Ltd.',
  registration: 'REG-123456-MW',
  address: 'Head Office , Tikumbe, Building - Naperi',
  phone: '+265 882 014 775',
  email: 'headoffice@safeguardsecurity.mw',
  website: 'www.safeguardsecurities.co',
  taxId: 'MW-12345678',
  pensionReg: 'NBS-123456',
  logoUrl: '',
};

const KEYS: Record<keyof CompanyInfo, string> = {
  companyName: 'company_name',
  registration: 'company_registration',
  address: 'company_address',
  phone: 'company_phone',
  email: 'company_email',
  website: 'company_website',
  taxId: 'company_tax_id',
  pensionReg: 'company_pension_reg',
  logoUrl: 'company_logo_url',
};

// Storage bucket the company logo is uploaded to (see the
// supabase/migrations/*_company_logo_storage.sql migration for the bucket
// and its RLS policies) -- public read so it can be shown in the app UI
// without needing a signed URL, upload/update/delete restricted to
// authenticated users.
export const LOGO_STORAGE_BUCKET = 'company-logo';

// Shared, per-tenant company profile -- stored in `system_settings` (same
// key/value table and upsert pattern as payrollSettings.ts) so every admin's
// browser sees the same company info, and anything that displays it (e.g.
// Payslips.tsx's PDF template) reads the one value an admin actually set in
// Settings -> Company, instead of its own separate hardcoded copy.
export const getCompanySettings = async (): Promise<CompanyInfo> => {
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('key, value')
      .in('key', Object.values(KEYS));

    if (error) {
      console.error('Error fetching company settings:', error);
      return { ...DEFAULT_COMPANY_INFO };
    }

    const byKey = new Map((data || []).map(row => [row.key, row.value]));
    const result = { ...DEFAULT_COMPANY_INFO };
    (Object.keys(KEYS) as (keyof CompanyInfo)[]).forEach(field => {
      const raw = byKey.get(KEYS[field]);
      if (raw !== undefined && raw !== null && raw !== '') {
        result[field] = raw;
      }
    });
    return result;
  } catch (err) {
    console.error('Unexpected error in getCompanySettings:', err);
    return { ...DEFAULT_COMPANY_INFO };
  }
};

const upsertSetting = async (key: string, value: string, userId: string): Promise<boolean> => {
  const { data: existing, error: checkError } = await supabase
    .from('system_settings')
    .select('id')
    .eq('key', key)
    .maybeSingle();

  if (checkError) {
    console.error(`Error checking existing setting ${key}:`, checkError);
    return false;
  }

  const result = existing
    ? await supabase
        .from('system_settings')
        .update({ value, updated_at: new Date().toISOString(), updated_by: userId })
        .eq('id', existing.id)
    : await supabase
        .from('system_settings')
        .insert([{ key, value, updated_by: userId }]);

  if (result.error) {
    console.error(`Error saving setting ${key}:`, result.error);
    return false;
  }
  return true;
};

export const setCompanySettings = async (info: CompanyInfo, userId: string): Promise<boolean> => {
  const results = await Promise.all(
    (Object.keys(KEYS) as (keyof CompanyInfo)[]).map(field =>
      upsertSetting(KEYS[field], info[field] ?? '', userId)
    )
  );
  return results.every(Boolean);
};

const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2MB
const ALLOWED_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];

// Uploads a new logo file and returns its public URL -- caller is still
// responsible for saving that URL via setCompanySettings so it actually
// takes effect (matches the rest of this form: nothing persists until Save
// Changes is clicked). Always uploads to the same fixed path so a re-upload
// simply replaces the previous file instead of accumulating orphaned ones.
export const uploadCompanyLogo = async (file: File): Promise<{ url: string } | { error: string }> => {
  if (!ALLOWED_LOGO_TYPES.includes(file.type)) {
    return { error: 'Logo must be a PNG, JPEG, WEBP, or SVG image.' };
  }
  if (file.size > MAX_LOGO_BYTES) {
    return { error: 'Logo must be smaller than 2MB.' };
  }

  const ext = file.name.split('.').pop() || 'png';
  const path = `logo.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(LOGO_STORAGE_BUCKET)
    .upload(path, file, { upsert: true, cacheControl: '3600' });

  if (uploadError) {
    console.error('Error uploading company logo:', uploadError);
    return { error: uploadError.message || 'Failed to upload logo' };
  }

  const { data } = supabase.storage.from(LOGO_STORAGE_BUCKET).getPublicUrl(path);
  // Cache-bust so every admin's browser picks up a replaced logo immediately
  // instead of an old cached image at the same URL.
  return { url: `${data.publicUrl}?t=${Date.now()}` };
};
