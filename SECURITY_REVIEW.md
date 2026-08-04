# Security Review — Safeguard HR & Payroll System

**Last updated:** 2026-08-04 (third pass — added a note on `payrollPermissions.test.ts`'s app-level coverage). Read `AUDIT_REPORT.md`'s "Corrections from the first pass" section first — two claims in the original version of this review's sibling document were factually wrong (TypeScript error count, critical vulnerability attribution) and have been corrected throughout. This review remains a **static reading of the codebase and SQL migrations**, not a live penetration test — no Supabase admin access, no per-role test credentials, no staging database. Every claim states its evidence.

## Authentication review

- Supabase Auth via the anon key (`src/lib/supabase.ts`) — correct pattern, no service-role key anywhere in frontend code.
- `.env`/`.env.local`/`.env.test` are gitignored; only `.env.example`/`.env.test.example` (placeholders) are tracked.
- Login form's error-message mapping (`Login.tsx`) is now genuinely tested: `e2e/static/login.spec.ts` mocks Supabase Auth's real error response shape (via Playwright's `page.route()`) and confirms the app maps `"Invalid login credentials"` to a user-facing message and a rate-limit response to a different one — actually run in this environment, both pass.
- **New finding: `Login.tsx`'s Email/Password `<label>` elements have no `htmlFor`/`id` association and don't wrap their `<input>`s** (confirmed by reading the source and confirmed again by Playwright's `getByLabel()` not finding them, forcing the E2E tests to use `getByPlaceholder` instead). This is a real accessibility gap (WCAG 1.3.1/4.1.2) — a screen reader cannot programmatically associate the visible "Email"/"Password" text with their inputs. Not fixed this pass.
- **New finding, confirmed by actually loading the app in a real browser**: the password input has no `autocomplete` attribute — Chromium's own DevTools console flags this (`"Input elements should have autocomplete attributes (suggested: \"current-password\")"`), now locked in as a regression test (`e2e/static/login.spec.ts`).
- Session expiration / token refresh: handled internally by `@supabase/supabase-js`. **Unverified** — needs a live session over a real token lifetime.
- Password reset flow (`ResetPassword.tsx`): **not reviewed this pass either** — still flagged from the first pass.
- Login rate limiting (`checkRateLimit` in `rateLimiter.ts`) is client-side only, trivially reset by reloading or using a different browser. Supabase's own platform-level rate limiting is the real backstop; **not verified** (no dashboard access).
- **A1: hardcoded admin credential in git history** (`src/tests/auth.test.ts`, since `58c4a9a`). Removed from the current tree; history not rewritten. **Still needs password rotation.**

## Authorization matrix

| Table | View | Create | Edit | Delete | DB enforcement status |
|---|---|---|---|---|---|
| `profiles` | self + tenant | self | self (sensitive columns blocked) | super-admin only | Covered (pre-existing fix) |
| `employees` | tenant-wide | tenant-wide, **no role check** | tenant-wide, **no role check** | super-admin only (this audit) | **Gap remains on INSERT/UPDATE** — needs column-level design (Supervisors write guard/shift/uniform columns via Security.tsx; Admins/Managers write everything via Employees.tsx) |
| `payroll` | tenant-wide | role_level = 1 or super-admin | role_level = 1 or super-admin | super-admin only (this audit) | Covered, plus a new atomic RPC (unwired) closing the non-atomicity gap |
| `attendance` | tenant-wide | **no role check** | **no role check** | **no role check** | **Not touched this pass** — Staff (role 4), who cannot even see the Attendance page in the UI, can currently write attendance directly via API |
| `applicants` | tenant-wide | role_level ≤ 2 (this audit) | role_level ≤ 2 (this audit) | role_level ≤ 2 (this audit) | Covered |
| `payment_status` | tenant-wide | role_level ≤ 2 (this audit) | role_level ≤ 2 (this audit) | no role check | INSERT/UPDATE covered, DELETE not touched. **Now has an executable staging test** (`e2e/authenticated/rls-policy-matrix.spec.ts`) |
| `terminal_dues` | tenant-wide | role_level ≤ 2 (this audit) | role_level ≤ 2 (this audit) | no role check | INSERT/UPDATE covered, DELETE not touched |
| `employee_deductions` | tenant-wide | role_level ≤ 3 (this audit) | role_level ≤ 3 (this audit) | no role check | INSERT/UPDATE covered, DELETE not touched |
| `system_settings` | tenant-wide | role_level = 1 (this audit) | role_level = 1 (this audit) | super-admin only (pre-existing) | Covered. **Now has an executable staging test** |
| `audit_logs` | tenant-wide | tenant-wide (app writes as acting user) | no policy → denied by default | no policy → denied by default | Already correctly immutable — a real pass, not a gap |
| `regions`/`companies`/`positions` | tenant-wide | tenant-wide, no role check | tenant-wide, no role check | tenant-wide, no role check | Not touched (lower sensitivity, follow-up) |
| `company-logo` storage | public | any authenticated user | any authenticated user | any authenticated user | Not touched |

**"Covered" still means "migration written and reviewed, not executed."** See "RLS testing status" below.

**Note on the `payroll` row's "role_level = 1 or super-admin" app-level gating**: this is now backed by a real unit test (`src/utils/payrollPermissions.test.ts`, 15 tests) covering `canProcessPayroll`/`canEditPayroll`/`canViewPayroll`/`canApprovePayroll` against all 4 role levels plus the super-admin override. This is **frontend** logic only — it controls what the UI shows/allows, and does **not** substitute for the DB-level RLS policy in the same row, which remains the actual enforcement boundary against a direct API call bypassing the UI.

## RLS testing status (updated — this is no longer purely hypothetical)

`e2e/authenticated/rls-policy-matrix.spec.ts` is a real, runnable Playwright/supabase-js test file exercising:
- `payment_status`: Admin and Manager can INSERT; Supervisor and Staff cannot; Staff cannot UPDATE an existing row (verified via re-reading the row afterward, since a denied UPDATE under RLS returns no client-visible error but affects zero rows — a subtlety this test explicitly accounts for rather than trusting `error === null`).
- `system_settings`: Manager cannot UPDATE.
- `employees`: a non-super-admin Admin cannot hard-DELETE a (disposable, test-created) employee record.

Actually run in this environment: **all 7 tests report as SKIPPED**, with a clear reason (`Missing: E2E_BASE_URL, E2E_SUPABASE_URL, ...`), because no staging credentials exist here. This was verified by running it, not assumed. To turn these into a real pass/fail signal, set the env vars listed in `e2e/fixtures.ts` against a real staging Supabase project with the role_level hardening migration applied and 4 seeded test accounts.

## Candidate region/access-control model (documented, NOT implemented)

Requested explicitly: document the following candidate rules and the schema changes each needs, without writing any code or migration for them. Region isolation (A12) stays blocked until you confirm which of these (or some other variant) is actually correct.

| Role | Candidate rule | Already supported by the schema? | Schema change needed |
|---|---|---|---|
| Super Admin | Explicitly authorized global access (all tenants/regions) | **Yes** — `profiles.is_super_admin` already exists and is already the universal bypass in every RLS policy this schema has | None |
| Admin | All regions within their own tenant | **Yes, implicitly** — every existing RLS policy already scopes to `tenant_id = get_current_tenant_id()` with no region restriction; an Admin (role_level 1) with a NULL `region_id` already behaves this way today, matching the client-side `if (!is_super_admin && region_id)` pattern used throughout the app | None, if "Admin's `region_id` is NULL" is confirmed as the intended way to express "sees all regions in their tenant." If instead Admins should have an *explicit* "all regions" flag distinct from just leaving the column NULL (clearer intent, avoids NULL doing double duty as both "unset" and "unlimited access"), that needs a new boolean column, e.g. `profiles.all_regions_access` |
| Manager | Assigned region **or regions** (plural) | **Partially** — `profiles.region_id` is a single nullable UUID, singular. The word "regions" (plural) in the requested candidate rule is a real design fork: if a Manager can ever legitimately oversee more than one region (not just "all of them," a specific subset), the current single-column model cannot express that at all | A join table, e.g. `profile_regions (profile_id, region_id)`, replacing or supplementing `profiles.region_id`. This is the single biggest schema decision in this whole model — confirm whether multi-region Managers are a real requirement before building either the join table (if yes) or keeping the simpler single-column model (if no, in which case the existing `region_id` column already suffices and no schema change is needed for Managers specifically) |
| Supervisor | Assigned region **and authorized workstations** | **Region: same as Manager above (partial). Workstations: no.** `employees.workstation` is a free-text column (not a foreign key to any `workstations`/`positions`-like lookup table), and there is no concept anywhere in the schema of a *Supervisor* being authorized for a specific *subset* of workstations within their region | Two changes, in order of how foundational they are: (1) a real `workstations` table (currently just a free-text field on `employees`) if workstation-level authorization is to be enforced by more than string-matching; (2) a `profile_workstations (profile_id, workstation_id)` join table (or `profile_id, workstation_text` if the free-text approach is kept) recording which workstations a given Supervisor may access |
| Staff | **Own profile, payslips, and permitted personal information only** | **No — this is the most severe gap found in this whole review.** See Finding A17 in `AUDIT_REPORT.md`: there is no column anywhere linking a `profiles` row (an auth account) to a specific `employees` row (an HR/payroll record). `Payslips.tsx`, the one page Staff can reach for this purpose, currently has **zero per-employee scoping** and shows every employee's payslip in the Staff user's region, not just their own | **A new `profiles.employee_id` column** (nullable UUID, `REFERENCES employees(id)`), populated when a Staff account is provisioned for a specific employee. Without this, no RLS policy or client-side filter can express "Staff sees only their own record" at all — there's nothing to filter *on*. This should be treated as a prerequisite to fixing A17, not an optional nice-to-have. |

**Summary of the schema decision this table is really asking you to make:** do Managers/Supervisors ever need *multiple* regions (plural, as literally requested) rather than one? If yes, `profiles.region_id` needs replacing with a join table before any of this can be built correctly — retrofitting that after RLS policies already depend on the single-column shape is much more disruptive than deciding now. Independent of that question, **`profiles.employee_id` is needed regardless** to make Staff self-service mean anything at all.

## Secret management review

Unchanged from the first pass: no service-role key or other real secret found anywhere outside `.env.example`/`.env.test.example` (both placeholders only). Both Edge Functions read `SUPABASE_SERVICE_ROLE_KEY` from `Deno.env` server-side correctly. Audit-log message content spot-checked (not exhaustive) across the files reviewed this pass — no salaries/tokens observed being logged in plain console output.

## Storage policy review

Unchanged: `company-logo` bucket is public-read (deliberate) but has unrestricted authenticated write (A7, not fixed — lower priority, not sensitive data).

## Audit log integrity

Unchanged and still a genuine pass: `audit_logs` has no UPDATE/DELETE policy at all, meaning those operations are denied by default under RLS. Confirmed by reading the full policy block. Coverage across every sensitive action still not exhaustively verified.

## User Manual security claims — verified, and now corrected in the app itself

| Claim | Status | Action taken |
|---|---|---|
| "Data Encryption... TLS/SSL" | Reasonably substantiated (inherent to Supabase/Vercel) | Left as-is |
| "Access Control: Role-based access" | Partially true, improved by this session's (unexecuted) migrations; `employees`/`attendance` still have no role_level check | Left as-is — the claim isn't false, just not fully realized yet |
| "Audit Trail" | Reasonably substantiated | Left as-is |
| "Two-Factor Authentication (optional)" | **False** — confirmed by the codebase's own comment ("no 2FA exists in this app") | **Removed from the User Manual** |
| "Data Isolation: Regional data isolation ensures employees only access data relevant to their region" | **False as a security guarantee** — real as a UI filter | **Reworded** to "The interface displays only the data relevant to your assigned region" — accurate about what actually happens, without claiming an enforcement guarantee that doesn't exist |
| "Backup & Recovery: automated daily backups with point-in-time recovery" | **False** | **Removed from the User Manual** |

## Remaining security risks, in order of severity

1. **A17: no `profiles`↔`employees` link at all** — Staff self-service payslips currently expose every employee's payslip in-region, not just the viewer's own. Needs `profiles.employee_id` before any fix is possible.
2. **A12: region isolation is UI-only** — needs the candidate-rules decision above before a fix can be written.
3. **A5: `employees`/`attendance` writes have no role_level check** — needs column-level design (which columns Supervisors may touch).
4. **A16: `jspdf` critical vulnerability, unfixed** — needs a visually-verified major-version upgrade, not a blind bump.
5. **A6: backup/recovery non-functional** — documentation now corrected; the underlying feature gap (build vs. leave unbuilt) is still an open decision.
6. **A7: `company-logo` storage bucket** unrestricted writes.
7. **A1: credential in git history** — pending your decision on history rewriting; password rotation still needed regardless.
8. Password reset flow, audit-log exhaustive coverage — both still unreviewed.

## Verification status legend

- **Verified (static)** — confirmed by reading the actual SQL/code.
- **Verified (build/lint/test/E2E)** — confirmed by actually running the relevant command in this environment and recording its real output/exit code.
- **Unverified** — would require a live database, live browser session, or credentials not available here. Not guessed at.
