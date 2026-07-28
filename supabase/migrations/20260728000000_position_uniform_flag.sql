-- ============================================================
-- MIGRATION: Per-position uniform eligibility
-- Date: 2026-07-28
-- ============================================================
--
-- Uniform deduction (src/pages/Payroll.tsx's calculatePayroll) previously applied
-- unconditionally to every employee regardless of role -- there was no way to
-- exempt office/admin/senior staff who don't wear a uniform. Adds a per-position
-- toggle (defaulting to true, so nothing currently receiving the deduction stops
-- silently without an explicit opt-out) that Settings -> Positions can control.
-- ============================================================

ALTER TABLE positions
ADD COLUMN IF NOT EXISTS requires_uniform BOOLEAN NOT NULL DEFAULT true;
