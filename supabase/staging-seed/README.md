# Staging seed data — not run in this pass

This directory exists because item 5 of the pre-staging blocker list asks for
a real staging Supabase project seeded with synthetic data, safe test
accounts across all 4 roles, at least 2 regions, and at least 2 tenants (for
multi-tenant testing), with identifiable test-data prefixes and cleanup
scripts.

**This environment cannot create a Supabase project, cannot reach any
Supabase Auth Admin API, and has no dashboard access — so nothing here has
been run.** These two files are a ready-to-adapt template for whoever does
have staging access, not a confirmation that staging exists or is seeded.

## Before running `seed_staging_data.sql`

1. **Create the staging Supabase project first** (or confirm one already
   exists that is genuinely separate from production — see
   `AUDIT_REPORT.md`'s Vercel-environment-isolation section for why this
   matters before any of this is safe to run).
2. **`profiles.id` is a foreign key to `auth.users(id)`, which this SQL file
   cannot create** — Supabase Auth users must be created through the
   Supabase dashion or the Auth Admin API (`supabase.auth.admin.createUser`),
   not by inserting rows into `auth.users` directly. For each of the 4 test
   accounts below, create the auth user first (dashboard: Authentication →
   Users → Add User, or the Admin API), then substitute the real returned
   `id` (UUID) into the `INSERT INTO profiles` statements before running
   this file. The placeholder UUIDs below (`00000000-0000-0000-0000-...`)
   **will fail the foreign-key constraint as-is** — they are placeholders to
   replace, not values to run verbatim.
3. Confirm this repo's own schema migrations (all 5 written this audit, plus
   the reconstructed base schema) have actually been applied to the staging
   project first — this seed script assumes every table/column referenced
   below already exists.
4. This schema is a **reconstruction** derived from reading application code
   (see `supabase/migrations/20260727000000_reconstructed_base_schema.sql`'s
   own header) — it may not match the real project's schema column-for-
   column. Diff against the real staging schema before running, and adjust
   column names/types as needed.

## Identifiable test-data prefix

Every synthetic row uses the prefix `ZZSTAGING_` in a human-readable field
(full name, email local-part, employee number, guard ID, applicant name) so
it can be found and removed with a single `LIKE 'ZZSTAGING\_%'` pattern —
see `cleanup_staging_data.sql`. Nothing here reuses or is derived from any
real employee's data; every name/number is fabricated.

## What this seed covers

- 2 tenants (`ZZSTAGING_TenantA`, `ZZSTAGING_TenantB`) — for multi-tenant
  isolation testing (confirming a TenantA admin can never see TenantB rows).
- 2 regions per tenant (4 total) — for region-isolation testing once a
  region policy is approved and implemented (see `SECURITY_REVIEW.md`'s
  candidate region model — do not implement RLS for this ahead of that
  approval; this seed only provides the *data* to test against once policy
  exists).
- 4 auth-backed profiles per tenant (Admin/Manager/Supervisor/Staff — 8
  total) — placeholders for the auth-user substitution step above.
- A handful of positions, employees (guards + office staff), attendance rows,
  one month of payroll, payment_status rows, and applicants — enough to
  exercise the RPC/role test matrix in `TEST_PLAN.md`/`e2e/authenticated/*`
  without needing hundreds of rows.

## Cleanup

`cleanup_staging_data.sql` deletes everything this seed created, by prefix,
in FK-safe order (children before parents). It does **not** delete the
tenants/regions/profiles themselves by default (commented out) — uncomment
those sections only when you want a full teardown, not just a data reset
between test runs.
