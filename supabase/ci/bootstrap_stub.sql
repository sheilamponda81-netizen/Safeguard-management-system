-- ============================================================
-- CI SCHEMA BOOTSTRAP: Supabase-platform stand-ins
-- ============================================================
-- This repo's migrations run inside a real Supabase project, which
-- pre-provisions several platform schemas/objects that plain Postgres
-- does not have (auth.users + auth.uid()/auth.email(), the
-- "extensions" schema pgcrypto is installed into, and the storage
-- schema's buckets/objects tables that a handful of migrations define
-- RLS policies against). This file provides the NARROWEST stand-in for
-- each of those -- just enough that the real migration files in
-- supabase/migrations/ apply unmodified against a disposable Postgres
-- in CI, never against production. No attendance/payroll/roster
-- business logic lives here; every table and function that matters for
-- correctness comes from the real, unmodified migration files applied
-- after this one (see apply_ci_schema.sh).
--
-- auth.uid() here reads from a one-row `var_caller` table that tests
-- can update via set_caller(uuid) to simulate whichever user is
-- "logged in" for a given RPC call -- the same technique used
-- throughout this project's manual migration rehearsals.
-- ============================================================

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
-- Supabase's own default search_path includes "extensions" ahead of
-- "public" so migrations can call gen_random_uuid()/digest() either
-- qualified (extensions.digest(...)) or bare -- replicate that here.
SELECT set_config('search_path', 'public, extensions', false);

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT
);
CREATE TABLE IF NOT EXISTS public.var_caller (uid UUID);
INSERT INTO public.var_caller DEFAULT VALUES;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
  SELECT uid FROM public.var_caller LIMIT 1;
$$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION auth.email() RETURNS TEXT AS $$
  SELECT email FROM auth.users WHERE id = auth.uid();
$$ LANGUAGE sql STABLE;
-- Test/CI-only helper -- not part of any real Supabase schema. Lets a
-- test simulate "logged in as this user" for a server-side RPC call.
CREATE OR REPLACE FUNCTION set_caller(p_uid UUID) RETURNS VOID AS $$
  UPDATE public.var_caller SET uid = p_uid;
$$ LANGUAGE sql;

-- Minimal storage.* stand-in -- only what a handful of this project's
-- migrations need to exist in order to (idempotently) manage the
-- company-logo bucket's RLS policies. No file storage happens in CI.
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public BOOLEAN DEFAULT false
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id TEXT,
  name TEXT,
  owner UUID
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
