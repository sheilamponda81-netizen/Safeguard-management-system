# Performance Report — Safeguard HR & Payroll System

**Last updated:** 2026-08-04 (third pass — no new performance/bundle findings; see note below). Read `AUDIT_REPORT.md`'s "Corrections from the first pass" section — those corrections were about the TS-error count and vulnerability attribution, not this document, but the same standard applies here: everything below is either an actual command's real output, or explicitly marked unmeasured.

**Third-pass note:** this pass's changes (5 pure-function extractions in `src/utils/*` — `employeeNumberGeneration`, `guardIdGeneration`, `terminalDuesCalculations`, `payrollPermissions`, `attendanceDeductions` — for real unit-test coverage, see `TEST_PLAN.md`) are small, non-UI utility modules with no new dependencies and no lazy-loading changes. `npm run build` was re-run and stayed clean, but re-running Lighthouse would not show any real movement from these specific changes, so it wasn't repeated. The numbers below are unchanged from the second pass.

**Update from the first pass: a real Lighthouse run is no longer blocked.** The first pass said Lighthouse couldn't run because the production domain is blocked by this environment's outbound proxy. That's still true for the *production URL specifically*, but nothing stopped running Lighthouse against a **local** production build — which this pass did, twice (before and after a set of accessibility fixes), with real, reproducible numbers.

## Lighthouse — actually run, local production build, Chromium (headless)

Command: `npx lighthouse http://localhost:4173/ --chrome-flags="--headless --no-sandbox" --only-categories=performance,accessibility,best-practices,seo`, served via `vite preview` of a real `npm run build` output, with placeholder Supabase env vars (`.env.test.example`).

| Category | Before this session's a11y fixes | After |
|---|---|---|
| Performance | 92 | 93 |
| **Accessibility** | **70** | **89** |
| Best Practices | 96 | 96 |
| SEO | 82 | 82 |

Key metrics (unauthenticated login page, local network, no throttling applied): FCP 2.6s, LCP 2.6s, TBT 50ms, CLS 0, Interactive 2.9s. **These are local-network numbers on this environment's hardware, not representative of real-world mobile/throttled conditions or the actual Vercel-hosted production deployment** — flagged as a real limitation, not presented as final numbers.

### What moved the accessibility score, concretely

Real failing audits from the first run (`button-name`, `color-contrast`, `target-size` all scored 0):
- **`button-name`** (fixed): the password show/hide toggle in `Login.tsx` was an icon-only button with no accessible name. Added `aria-label`. Re-run confirms this audit now passes (score 1).
- **`color-contrast`** (not fixed): flagged on a `text-slate-400` element (the footer copy line). `text-slate-400` is an extremely common utility class across this entire codebase — a real, systemic contrast issue, but fixing it requires either a broader color-token change or per-element review, both bigger than this pass's scope. Documented, not blindly changed.
- **`target-size`** (not fixed): flagged on the same password-toggle button (too small a tap target). Same reasoning — a real, but broader UI-sizing decision, not attempted blind.

Two more issues fixed alongside `button-name` in the same commit, not separately Lighthouse-flagged but confirmed via Playwright's `getByLabel()` failing to find the inputs beforehand: the Email/Password `<label>`s had no `htmlFor`/`id` association at all, and the password input had no `autocomplete` attribute (Chromium's own console flagged this one independently). Both fixed; both now covered by passing E2E tests (`e2e/static/login.spec.ts`).

**This Lighthouse run only covers the unauthenticated login page** — every other page in the app needs real credentials to reach, so their accessibility/performance profiles remain unmeasured.

## Bundle analysis (build output, still real and reproducible)

| Chunk | Raw size | Gzip |
|---|---|---|
| `vendor-charts-core` (recharts) | 556 KB | 151 KB |
| `vendor-pdf-core` (jspdf) | 352 KB | 115 KB |
| `vendor-pdf-utils` | 197 KB | 47 KB |
| `vendor-ui` | 191 KB | 60 KB |
| `index.es` | 147 KB | 50 KB |
| `Payslips` page (after jszip lazy-load fix) | **40 KB** | **9.6 KB** (was 134 KB / 38.5 KB) |
| `vendor-auth` | 94 KB | 22 KB |
| `vendor-supabase` | 80 KB | 24 KB |

All page routes already lazy-loaded; `recharts`/`jspdf` already dynamically imported at point of use (pre-existing good practice, not introduced this pass).

### Changes made this pass, before/after measured

1. **`jszip` static → dynamic import in `Payslips.tsx`**: 38.5 KB → 9.6 KB gzip on that page's common-case load, `jszip`'s ~30 KB now a separate chunk loaded only for bulk ZIP download. Verified via real `npm run build` output, both before and after.
2. **`xlsx` removed** (confirmed unused anywhere in `src/` via grep): no bundle effect (dead code isn't bundled either way), but drops a high-severity, unfixable vulnerability from `npm audit`.
3. **`dev` script's `--force` removed**: dev-only, not a production bundle change. Verified dev server starts in ~270ms without it and serves correctly.
4. **CSV export logic consolidated** into `src/utils/csvExport.ts` (see `AUDIT_REPORT.md` A18) — negligible size impact (a few lines of shared logic replacing near-identical inline code at 6 call sites), the actual value here is correctness (escaping), not performance.

## Remaining bottlenecks (identified, not fixed)

- `vendor-charts-core` (151 KB gzip) is the single largest chunk. Already lazy; whether a lighter charting approach is viable for what Dashboard actually uses is unassessed — a library swap is out of scope for this pass without the ability to visually verify the charts afterward.
- `vendor-pdf-core` + `vendor-pdf-utils` (~162 KB gzip combined) — already lazy; no further sub-module tree-shaking investigated.
- `jspdf`'s critical vulnerability (`AUDIT_REPORT.md` A16) has a fix available but it's a major-version bump needing visual verification of payslip PDF output — not attempted.
- 211 pre-existing TypeScript errors don't affect bundle size directly, but several are `Badge`/`Button` receiving props the component doesn't declare (silently inert styling attempts) — not fixed wholesale.
- **`color-contrast`/`target-size` Lighthouse failures** — real, confirmed, not fixed (see above).

## Database query performance

**Still not measured** — no live Supabase connection with realistic data volume. `.select('*')` usage on several pages remains un-quantified against real row counts.

## What this report can now claim vs. still cannot

**Can claim (measured, real, reproducible in this environment):** Lighthouse scores for the unauthenticated login page, before/after bundle sizes for the two dependency changes, dev-server cold-start timing.

**Cannot claim:** anything about pages requiring authentication (every page except Login), real Core Web Vitals against the actual Vercel-hosted production URL (network-blocked), mobile-network-throttled measurements, real database query timing, Vercel Speed Insights data (needs dashboard access).
