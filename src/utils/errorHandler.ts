// src/utils/errorHandler.ts

export class AppError extends Error {
  constructor(
    public message: string,
    public code: string,
    public statusCode: number = 500,
    public userMessage: string = 'Something went wrong. Please try again.'
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NetworkError extends AppError {
  constructor(message: string = 'Network connection error') {
    super(message, 'NETWORK_ERROR', 0, 'Network error. Please check your internet connection.');
    this.name = 'NetworkError';
  }
}

export class AuthError extends AppError {
  constructor(message: string = 'Authentication failed') {
    super(message, 'AUTH_ERROR', 401, 'Please log in to continue.');
    this.name = 'AuthError';
  }
}

export class PermissionError extends AppError {
  constructor(message: string = 'Permission denied') {
    super(message, 'PERMISSION_ERROR', 403, 'You do not have permission to perform this action.');
    this.name = 'PermissionError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found') {
    super(message, 'NOT_FOUND_ERROR', 404, 'The requested resource was not found.');
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string = 'Validation failed', public validationErrors: string[] = []) {
    super(message, 'VALIDATION_ERROR', 400, 'Please check your input and try again.');
    this.name = 'ValidationError';
  }
}

// Shape of a Supabase/PostgREST error object -- these always carry a `code`
// (a Postgres SQLSTATE like '23505', or a PostgREST-specific code like
// 'PGRST116'), which is what lets the checks below distinguish "a raw
// database/driver failure" (never safe to show verbatim -- may contain
// table/column/constraint names, or in principle row data) from "a plain
// Error our own code threw on purpose" (safe, since we authored the text).
interface PostgrestLikeError {
  code: string;
  message?: string;
  details?: string;
  hint?: string;
}

function isPostgrestLikeError(error: unknown): error is PostgrestLikeError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  );
}

// Every Postgrest/Postgres error code this app has actually observed or
// deliberately guards against (see AUDIT_REPORT.md / migration files for
// where each constraint/RLS policy comes from). Codes not listed fall
// through to the generic message -- deliberately never echoing the raw
// `error.message`/`error.details`/`error.hint`, since those can contain
// table names, constraint names, or (for some Postgres errors) fragments
// of the offending row's data.
const POSTGREST_CODE_MESSAGES: Record<string, string> = {
  PGRST116: 'Record not found. Please refresh and try again.',
  '23505': 'This record already exists. Please check your data.',
  '23503': 'This operation could not be completed due to related records.',
  '42P01': 'System error. Please try again later.',
  '42501': 'You do not have permission to perform this action.',
  '22001': 'Input is too long. Please shorten your text.',
};

// The ONE safe error-normalization helper for this app: accepts whatever a
// `catch (error)` block actually receives (typed `unknown`, never `any`) and
// returns a string that is always safe to render directly to a user --
// never a raw SQL/Postgrest message, stack trace, token, or row of
// employee/payroll data. Every `catch (error: any) { ...error.message }`
// pattern in this codebase should route through this function instead.
export const getErrorMessage = (error: unknown): string => {
  if (error instanceof AppError) {
    return error.userMessage;
  }

  if (isPostgrestLikeError(error)) {
    return POSTGREST_CODE_MESSAGES[error.code] || 'Something went wrong. Please try again later.';
  }

  // A plain Error/string with no `code` was thrown by this app's own code
  // (Postgrest/Postgres errors always carry `code` -- see above), so its
  // message is application-authored text, not raw driver/database output,
  // and is safe to surface verbatim.
  if (error instanceof Error) {
    if (/failed to fetch|networkerror|network/i.test(error.message)) {
      return 'Network error. Please check your internet connection and try again.';
    }
    return error.message;
  }
  if (typeof error === 'string') return error;

  return 'Something went wrong. Please try again later.';
};