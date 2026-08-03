# Performance Report — Safeguard HR & Payroll System

**Date:** 2026-08-03. Read `AUDIT_REPORT.md`'s "Access limitations" section first. **No Lighthouse or Vercel Speed Insights run was possible** — both require either a live browser session against a deployed URL (this environment's outbound network proxy blocks the production domain) or a authenticated app to click through (no credentials). Everything below is derived from **build output analysis and static code review**, which is real and reproducible, but is not the same thing as measured Core Web Vitals. Anywhere a number below isn't from an actual command run in this environment, it says so.

## Baseline measurements (actual `npm run build` output, start of this audit)

| Chunk | Raw size | Gzip |
|---|---|---|
| `vendor-charts-core` (recharts) | 556 KB | 151 KB |
| `vendor-pdf-core` (jspdf) | 352 KB | 115 KB |
| `vendor-pdf-utils` | 197 KB | 47 KB |
| `vendor-ui` | 191 KB | 60 KB |
| `index.es` | 147 KB | 50 KB |
| `Payslips` page | 134 KB | 39 KB |
| `vendor-auth` | 94 KB | 22 KB |
| `vendor-supabase` | 80 KB | 24 KB |
| `Employees` page | 76 KB | 15 KB |

All of the above are already **route-level lazy-loaded** (confirmed: every page in `src/App.tsx`'s `pageComponents` is wrapped in `safeLazy(() => import(...))`, and `recharts`/`jspdf` are already dynamically imported at their point of use in `src/utils/charts.ts` / `src/utils/clickHandlers.ts` / `Payslips.tsx` — this was already good practice before this audit, not something this pass introduced).

## Changes made this pass, with before/after measurements

### 1. `jszip` was a static top-level import in `Payslips.tsx`

Every visitor of the Payslips page downloaded the ~30 KB-gzipped ZIP library, even though it's only used by the bulk-download button — most visits are almost certainly a single employee downloading their own payslip. Converted to a dynamic `import('jszip')` inside `handleBulkDownload`, matching the pattern already used for `jspdf`/`recharts` elsewhere in this codebase (and matching this exact file's own pre-existing comment: *"PERFORMANCE: Lazy load PDF libraries only when needed"*, which JSZip had apparently been left out of).

| | Before | After |
|---|---|---|
| `Payslips` chunk (gzip) | 38.5 KB | 9.6 KB |
| `jszip` | bundled into Payslips chunk | separate 29.5 KB (gzip) chunk, loaded only on bulk download |

**Net effect:** ~29 KB gzip removed from the common-case Payslips page load. Verified via actual `npm run build` output before and after the change (chunk hashes/sizes shown above are real build artifacts, not estimates).

### 2. `xlsx` dependency removed entirely

Confirmed via full-repo grep it was never imported anywhere in `src/`. Removing it has no bundle-size effect (dead code doesn't get bundled either way by Vite's tree-shaking) but removes it from `npm install` entirely and drops `npm audit`'s critical-vulnerability count from 1 to 0. This is a security fix with a minor secondary benefit (smaller `node_modules`, one less thing to ever accidentally import).

### 3. `dev` script no longer forces a full dependency re-optimization on every start

Not a production bundle change — this only affects local development iteration speed. Verified by actually starting the dev server both with and without `--force`: without it, cold start is ~270ms and the app serves correctly (checked via `curl` against the dev server — HTML loads, React refresh injects, `/src/main.tsx` returns 200). `--force` was clearing Vite's `.vite` cache and re-bundling every dependency from scratch on every single `npm run dev`, for no verified reason (no linked/monorepo packages, no symlinked deps found in this project).

## Remaining bottlenecks (identified, not fixed this pass)

- **`vendor-charts-core` (recharts, 151 KB gzip) is the single largest chunk in the app.** It's already dynamically imported (good), but 151 KB is still a lot for a charting library — worth checking, in a follow-up pass, exactly which recharts sub-components are actually used (Dashboard's charts) and whether a lighter charting approach is viable. Not attempted here: swapping a charting library is a much larger, riskier change than this pass's scope, and doing it blind without being able to visually verify the Dashboard's charts afterward would be irresponsible.
- **`vendor-pdf-core` (jspdf, 115 KB gzip) + `vendor-pdf-utils` (47 KB gzip)** — already lazy, but combined ~160 KB gzip is substantial for payslip generation specifically. Not investigated further for sub-module tree-shaking opportunities in this pass.
- **218 pre-existing TypeScript errors** don't affect runtime bundle size directly, but several are `Badge`/`Button` components receiving props (`className`, out-of-union `color` values) the shared component doesn't declare — meaning some styling props are silently doing nothing at runtime (dead weight in the JSX, not the bundle). Not fixed wholesale this pass (see AUDIT_REPORT.md).
- **No explicit code-splitting analysis was done for `vendor-ui` (191 KB raw / 60 KB gzip)** — this is `components/ui.tsx` plus whatever it pulls in; not broken down further in this pass.

## Database query performance

**Not measured** — no live Supabase connection with realistic data volume was available (no staging project, no production access). Static review of `.select('*')` usage: several pages (`Attendance.tsx`, `Recruitment.tsx`, `Payments.tsx`) do call `.select('*')` rather than naming specific columns, which is a reasonable candidate for reducing over-the-wire payload size at scale, but this wasn't quantified against real row counts and is not fixed in this pass — flagged as a follow-up once a staging project with representative data volume exists.

Indexes: `20240618000000_create_indexes.sql` exists and was skimmed but not deeply audited against actual query patterns in this pass (would need `EXPLAIN ANALYZE` against real data to say anything meaningful — unverified).

## React render-frequency / re-render analysis

Not profiled with React DevTools (needs a live running app). Static review during the `EmployeeModal`/`AddApplicantModal` refactor (AUDIT_REPORT.md A2–A4) specifically confirmed: converting those from `useCallback`-invoked-as-a-function to genuine standalone components, with stable module-level identity, means React will **never** spuriously remount them across renders — which is a render-frequency improvement as a side effect of the correctness fix (the original risky pattern existed specifically because a naive `<Modal />` JSX approach with an unstable component identity *would* have caused exactly this kind of remount-on-every-render, so this fix addresses the same underlying concern the original (broken) code was trying to solve, just correctly).

## Accessibility-adjacent performance (Core Web Vitals context)

Not measured (no Lighthouse). One relevant static observation: `vite.config.ts` has `server: { open: true }`, which is dev-only and irrelevant to production performance; no obvious render-blocking resource issues were spotted in `index.html` during a skim (font preconnects present, no synchronous third-party scripts found). This is not a substitute for an actual Lighthouse run and should not be read as a performance score.

## What this report cannot claim

- No Lighthouse performance/accessibility/best-practices/SEO scores — **unmeasured**, not "assumed good."
- No Core Web Vitals (LCP/CLS/INP) numbers — **unmeasured**.
- No mobile-network-throttled measurements — **unmeasured**.
- No real database query timing — **unmeasured**.

Recommend running Lighthouse (`npx lighthouse https://safeguard-management-system.vercel.app/ --view`) and checking Vercel's own Speed Insights dashboard as the immediate next step once someone with browser/dashboard access can do so — both are quick to run and would replace several of the "unmeasured" lines above with real numbers.
