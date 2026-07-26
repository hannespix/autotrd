-- Nachbau der Supabase-Umgebung für Tests gegen einen nackten Postgres.
--
-- NUR FÜR TESTS — in der echten Datenbank bringt Supabase auth.users,
-- auth.uid(), auth.role() und die Rollen anon/authenticated/service_role
-- selbst mit. Dieses Shim existiert, damit die Policies aus 0002_rls.sql
-- ohne Docker verifizierbar sind (der Container hier hat keinen Daemon).
--
-- auth.uid() liest denselben Session-Parameter wie in Supabase: PostgREST
-- setzt `request.jwt.claim.sub` aus dem JWT, wir setzen ihn im Test von Hand.

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text
);

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon');
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- bypassrls entspricht dem Admin-SDK in Firestore: Der Server umgeht die
    -- Regeln, weil er sie selbst durchsetzt.
    create role service_role nologin bypassrls;
  end if;
end;
$$;
