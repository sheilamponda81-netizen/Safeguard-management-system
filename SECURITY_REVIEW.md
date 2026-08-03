# Security Review — Safeguard HR & Payroll System

**Date:** 2026-08-03. Read `AUDIT_REPORT.md`'s "Access limitations" section first — this review is a **static reading of the codebase and SQL migrations**, not a live penetration test. No Supabase admin access, no per-role test credentials, and no staging database were available. Every claim below states its evidence; anything not directly checkable says so.

## Authentication review

- Supabase Auth (email/password) via `@supabase/supabase-js`, using the anon key (`src/lib/supabase.ts`) — correct client-side pattern, no service-role key present anywhere in frontend code (confirmed by grep across `src/`).
- `.env`/`.env.local` are gitignored; only `.env.example` (placeholder values) is tracked. Confirmed via `git ls-files | grep env`.
- Session expiration / token refresh: handled by `@supabase/supabase-js` internally (its default behavior). Not independently tested — would need a live browser session to observe refresh behavior over a real token lifetime. **Unverified.**
- Password reset (`src/pages/ResetPassword.tsx` exists): not reviewed line-by-line in this pass for information leakage (e.g. whether it reveals if an email exists). **Unverified — flagged for a follow-up read.**
- Brute-force protection: `src/utils/rateLimiter.ts`'s `checkRateLimit` is used in `Login.tsx`. This is **client-side only** — it rate-limits based on state held in the browser tab, which a reloading page or a different browser/incognito session trivially resets. It provides no protection against a scripted attacker hitting Supabase Auth directly. Supabase itself has its own platform-level rate limiting on auth endpoints, which is the actual backstop here, not this app-level check. **Not fixed in this pass** (would need Supabase dashboard access to check/configure the platform-level settings — unverified).
- **A1 (from AUDIT_REPORT.md): a real-looking admin credential was committed to git history** in `src/tests/auth.test.ts` (removed from the current tree; history not rewritten pending your decision). Treat this as compromised — rotate the password regardless of anything else here.

## Authorization matrix

Derived from `src/App.tsx`'s `rolePages` (client-side page access) cross-referenced against what each table's RLS policy actually enforces, **after** this audit's `20260803000000_role_level_rls_hardening.sql` migration (not yet executed against any database — see below).

| Table | View | Create | Edit | Delete | Approve | DB enforcement (post-migration, unexecuted) |
|---|---|---|---|---|---|---|
| `profiles` (own role/tenant/admin flag) | self + tenant | self | self (other columns only) | super-admin only | n/a | Trigger blocks self-escalation of `role_level`/`is_super_admin`/`tenant_id` (pre-existing fix, `20260727000001`) |
| `employees` | tenant-wide | tenant-wide | **tenant-wide, no role check** | super-admin only (this migration) | n/a | **Gap remains on INSERT/UPDATE** — see below |
| `payroll` | tenant-wide | role_level = 1 or super-admin (pre-existing fix) | role_level = 1 or super-admin (pre-existing fix) | super-admin only (this migration) | role_level = 1 or super-admin, via UPDATE policy | Covered |
| `attendance` | tenant-wide | tenant-wide, no role check | tenant-wide, no role check | tenant-wide, no role check | n/a | **Not touched this pass** — see "Not yet covered" below |
| `applicants` | tenant-wide | role_level ≤ 2 (this migration) | role_level ≤ 2 (this migration) | role_level ≤ 2 (this migration) | n/a | Covered |
| `payment_status` | tenant-wide | role_level ≤ 2 (this migration) | role_level ≤ 2 (this migration) | tenant-wide, no role check | n/a | INSERT/UPDATE covered, DELETE not touched |
| `terminal_dues` | tenant-wide | role_level ≤ 2 (this migration) | role_level ≤ 2 (this migration) | tenant-wide, no role check | n/a | INSERT/UPDATE covered, DELETE not touched |
| `employee_deductions` | tenant-wide | role_level ≤ 3 (this migration) | role_level ≤ 3 (this migration) | tenant-wide, no role check | n/a | INSERT/UPDATE covered, DELETE not touched |
| `system_settings` | tenant-wide | role_level = 1 (this migration) | role_level = 1 (this migration) | super-admin only (pre-existing) | n/a | Covered |
| `audit_logs` | tenant-wide | tenant-wide (app writes as acting user) | **no policy → denied by default** | **no policy → denied by default** | n/a | Already correctly immutable |
| `regions`/`companies`/`positions` | tenant-wide | tenant-wide, no role check | tenant-wide, no role check | tenant-wide, no role check | n/a | **Not touched this pass** (lower sensitivity, flagged as follow-up) |
| `company-logo` storage | public | any authenticated user | any authenticated user | any authenticated user | n/a | **Not touched this pass** (A7) |

**Reading this table honestly:** "Covered" means the migration file exists and its SQL mirrors an already-established client-side rule — it does **not** mean this has been executed or verified against a real database. See "Verification status" below.

### Gaps intentionally left open this pass (and why)

- **`employees` INSERT/UPDATE** has no role_level check at all. This table is written from both the Employees page (role_level ≤ 2) and the Security page (role_level ≤ 3, Supervisors manage guard/shift/uniform columns there). A blanket restriction would lock Supervisors out of legitimate writes. Needs column-level policies (which columns each role may touch) — needs your confirmed column list, not a guess.
- **`attendance` INSERT/UPDATE/DELETE** — same shape of gap, not yet analyzed for its full role/column matrix in this pass. Flagged as a follow-up; the Attendance page itself is role_level ≤ 3, so a Staff account (role 4) currently *can* write attendance directly via API despite having no UI access to the page at all.
- **DELETE on `payment_status`/`terminal_dues`/`employee_deductions`/`regions`/`companies`/`positions`** — INSERT/UPDATE were prioritized (higher-impact: creating fraudulent records or approving things); DELETE was not, as a scope-control decision for this pass, not because it's safe.

## Region isolation testing

**Not tested live** (no test accounts). Verified statically instead: grepped every migration file for `region_id` inside a `CREATE POLICY` — **zero matches**. Every RLS policy in this schema gates only on `tenant_id`/`is_super_admin()`. Region filtering happens exclusively in application code (e.g. `Attendance.tsx` line ~125: `if (!userProfile?.is_super_admin && userProfile?.region_id) { query = query.eq('region_id', userProfile.region_id) }`).

**Conclusion: regional data isolation, as advertised in the User Manual ("Regional data isolation ensures employees only access data relevant to their region"), is not implemented at the database layer at all.** Any authenticated user, of any role, in any region, can read or write any other region's data via a direct Supabase client call bypassing the UI entirely. This is the single largest gap this review found and is not fixed — see AUDIT_REPORT.md Finding A12 for why (nullable `region_id` semantics need your confirmation before a fix can be written safely).

## Secret management review

- No service-role key, database password, or other secret found anywhere in `src/`, `vite.config.ts`, or any tracked file other than `.env.example` (which contains only placeholders).
- `src/tests/auth.test.ts`'s hardcoded credential (A1) is the one real exposure found, addressed above.
- Both Edge Functions (`supabase/functions/backup`, `/rollback`) read `SUPABASE_SERVICE_ROLE_KEY` from `Deno.env` server-side — correct pattern, key never reaches the browser.
- Logs: `console.error`/`console.log` calls throughout the app were spot-checked in the files reviewed this pass (Attendance, Recruitment, Payroll, Payments, Payslips, Employees, TerminalDues) — none observed printing full employee objects, salaries, or tokens; errors are generally logged as `err.message` or the raw Postgres error object. **Not exhaustively checked across the whole codebase** — flagged as a follow-up (a repo-wide grep for `console.log(` combined with variables named `salary`/`token`/`password`/`account` would be a fast next step).

## Storage policy review

- `company-logo` bucket: public read (deliberate, documented in the migration as equivalent to a public website asset), but INSERT/UPDATE/DELETE are open to **any authenticated user**, no tenant or role scoping (A7, not fixed this pass — lower priority given it's just a logo image, but real and live).
- No other storage buckets found in the migrations.

## Audit log integrity

- `audit_logs` has SELECT and INSERT policies only — **no UPDATE or DELETE policy exists**, which under Postgres RLS means those operations are denied by default for any non-owner role. Confirmed by reading the full `CREATE POLICY` block for this table in `20260727000000_reconstructed_base_schema.sql` — nothing past INSERT is defined.
- **This is a genuine pass**: audit logs are immutable as claimed, without needing any additional fix.
- Coverage: `logAudit()` calls were confirmed present in `Attendance.tsx` (deduction saves), `Recruitment.tsx` (applicant creation), `Payroll.tsx` (processing, approval), `Payments.tsx` (status changes). **Not verified for every single sensitive action across every page** — a full coverage check (grep for every `.insert(`/`.update(`/`.delete(` call and confirming each has a matching `logAudit`) was not completed in this pass.

## User Manual security claims — verified against actual implementation

| Claim | Status | Evidence |
|---|---|---|
| "Data Encryption: All data is encrypted at rest and in transit using industry-standard TLS/SSL" | **Reasonably substantiated** | Inherent to Supabase (Postgres at rest) + Vercel (HTTPS) hosting, not something the app implements itself, but a fair claim for this stack |
| "Access Control: Role-based access ensures only authorized personnel can view sensitive information" | **Partially true, was mostly false before this audit** | Server-side enforcement existed on 2/13 tables before this pass; extended to 5 more tables by an unexecuted migration; `employees` and `attendance` still have no role_level check at all (see gaps above) |
| "Audit Trail: Every action is logged, providing complete accountability" | **Reasonably substantiated** | `audit_logs` is real and immutable; coverage across every action not exhaustively verified |
| "Two-Factor Authentication: Optional 2FA adds an extra layer of security" | **False** | Confirmed by the codebase's own comment in `Misc.tsx`: *"no 2FA exists in this app"* |
| "Data Isolation: Regional data isolation ensures employees only access data relevant to their region" | **False at the database layer** | Zero RLS policies reference `region_id` anywhere; UI-only filtering, trivially bypassed via direct API calls |
| "Backup & Recovery: Automated daily backups with point-in-time recovery capabilities" | **False** | No scheduler, no frontend invocation, `restoreBackup` is a no-op, target storage table doesn't exist in the schema (see AUDIT_REPORT.md A6) |

## Remaining security risks (unranked list, see AUDIT_REPORT.md for severity)

1. Region isolation is UI-only (A12) — the largest open item.
2. `employees`/`attendance` writes have no server-side role check (needs column-level design, A5).
3. Backup/recovery and 2FA are documented but non-functional (A6, A13) — misleading to anyone relying on the User Manual as ground truth.
4. `company-logo` storage bucket writes are unrestricted (A7).
5. The credential in git history (A1) — pending your decision on history rewriting.
6. Password reset flow not reviewed for information leakage.
7. Rate limiting on login is client-side only; platform-level protection not verified (no dashboard access).
8. Audit log coverage not exhaustively verified across every sensitive action.

## Verification status legend (used throughout this review)

- **Verified (static)** — confirmed by reading the actual SQL/code in this repository.
- **Verified (build/lint)** — confirmed by running `tsc`/`eslint`/`vite build` in this environment.
- **Unverified** — would require a live database, live browser session, or credentials not available in this environment. Explicitly not guessed at.
