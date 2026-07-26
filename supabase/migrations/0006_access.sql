-- Zugangsstufen & Admin-Freischaltung (Owner-Auftrag 26.07.).
--
-- „Registrierung nicht für jeden frei — Admin schaltet frei. Ohne
--  Freischaltung soll man das Tool sehen, aber die Engine nicht starten."
--
-- Umsetzung in DREI Ebenen, weil eine ausgegraute Schaltfläche keine Sperre
-- ist (wer die Browser-Konsole öffnet, ruft die Funktion trotzdem auf):
--   1. Datenbank (hier): Stufe am Profil + Policies, die Nicht-Freigeschaltete
--      gar nicht erst schreiben lassen.
--   2. Server: Scan überspringt sie, Callables weisen sie ab (MS3/MS4).
--   3. Oberfläche: Hinweis statt Knopf — Bequemlichkeit, nicht Sicherheit.
--
-- Die Stufen sind bewusst erweiterbar: 'pro' o. Ä. lässt sich später ohne
-- Migration ergänzen, weil die Prüfungen auf „darf handeln" abstellen und
-- nicht auf eine feste Aufzählung.

-- ── Profil: Stufe + Rolle ─────────────────────────────────────────────────
alter table public.profiles
  add column if not exists access_level text not null default 'pending',
  add column if not exists role         text not null default 'user',
  add column if not exists requested_at timestamptz not null default now(),
  add column if not exists approved_at  timestamptz,
  add column if not exists approved_by  uuid,
  add column if not exists access_note  text;   -- Notiz des Admins

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_access_level_chk') then
    alter table public.profiles add constraint profiles_access_level_chk
      check (access_level in ('pending', 'approved', 'blocked'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_role_chk') then
    alter table public.profiles add constraint profiles_role_chk
      check (role in ('user', 'admin'));
  end if;
end;
$$;

create index if not exists profiles_pending_idx
  on public.profiles (requested_at desc) where access_level = 'pending';

-- ── Hilfsfunktionen ───────────────────────────────────────────────────────
-- SECURITY DEFINER, weil die Funktion in profiles lesen muss, ohne dass die
-- aufrufende Rolle dort Leserechte auf FREMDE Zeilen braucht. search_path
-- wird festgenagelt — sonst könnte eine untergeschobene Tabelle im Suchpfad
-- die Antwort fälschen (klassische Rechteausweitung bei DEFINER-Funktionen).
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.may_trade(uid uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select access_level = 'approved' from public.profiles where id = uid), false);
$$;

comment on function public.may_trade(uuid) is
  'Darf dieser Nutzer die Engine starten und handeln? Einzige Wahrheit für '
  'Scan, Callables und UI — nie einzeln nachimplementieren.';

grant execute on function public.is_admin()          to authenticated, service_role;
grant execute on function public.may_trade(uuid)     to authenticated, service_role;

-- ── Admin darf alle Profile sehen und die Stufe setzen ────────────────────
drop policy if exists profiles_select_admin on public.profiles;
create policy profiles_select_admin on public.profiles
  for select using (public.is_admin());

drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());

-- ── Selbstschutz: der Nutzer darf seine EIGENE Stufe nicht anheben ────────
-- Die bestehende Policy profiles_update_own erlaubt Updates auf der eigenen
-- Zeile (Strategie-Formular). Ohne diesen Riegel könnte sich jeder selbst
-- freischalten — ein Einzeiler in der Browser-Konsole. Der Trigger greift
-- VOR der Zeile und lässt die geschützten Felder nur für Admins und den
-- Server durch.
-- ACHTUNG, hier steht bewusst KEIN security definer: In einer
-- DEFINER-Funktion ist current_user der EIGENTÜMER (postgres), nicht der
-- Aufrufer — der Riegel hätte die falsche Identität geprüft und jeden
-- durchgelassen. Genau das zeigte Testfall 18. Als INVOKER-Funktion ist
-- current_user die tatsächlich handelnde Rolle. is_admin() darunter bleibt
-- DEFINER, weil sie fremde Profilzeilen lesen muss.
create or replace function public.guard_profile_privileges() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  -- Der Riegel richtet sich AUSSCHLIESSLICH gegen Clients. Alles andere —
  -- der Server (service_role), Migrationen und Wartung (postgres) — darf
  -- durch; sonst könnte nicht einmal eine Migration eine Stufe setzen.
  -- Positivliste statt Ausnahmeliste: Eine neu hinzukommende Rolle bekäme
  -- sonst versehentlich Vollzugriff.
  if current_user not in ('authenticated', 'anon') or public.is_admin() then
    return new;
  end if;
  if new.access_level is distinct from old.access_level
     or new.role        is distinct from old.role
     or new.approved_at is distinct from old.approved_at
     or new.approved_by is distinct from old.approved_by then
    raise exception 'Zugangsstufe und Rolle sind nicht selbst änderbar'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profile_privileges();

-- ── Engine-Sperre auf Datenbankebene ──────────────────────────────────────
-- Selbst wenn ein Fehler im Servercode einen Nicht-Freigeschalteten
-- durchließe: Ohne Freischaltung entsteht hier keine Position und kein
-- Trade. Die Prüfung sitzt bewusst NICHT in einer Policy (service_role
-- umgeht die), sondern als Trigger — er gilt für JEDEN Schreibenden.
create or replace function public.guard_trading_allowed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.may_trade(new.user_id) then
    raise exception 'Konto ist noch nicht freigeschaltet — Handel gesperrt'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists trades_guard    on public.trades;
create trigger trades_guard before insert on public.trades
  for each row execute function public.guard_trading_allowed();

drop trigger if exists positions_guard on public.positions;
create trigger positions_guard before insert on public.positions
  for each row execute function public.guard_trading_allowed();

-- ── Sicht für die Admin-Ansicht: offene Anfragen ──────────────────────────
create or replace view public.access_requests as
  select id, email, requested_at, access_level, access_note
    from public.profiles
   where access_level = 'pending'
   order by requested_at;

grant select on public.access_requests to authenticated;

-- ── Profil bei Registrierung automatisch anlegen ──────────────────────────
-- Ersetzt das bisherige ensureProfile-Callable: Ein Trigger auf auth.users
-- legt das Profil an, sobald sich jemand registriert — auf Stufe 'pending'.
-- Damit gibt es keinen Zeitraum, in dem ein angemeldeter Nutzer ohne Profil
-- (und damit ohne Stufe) unterwegs ist.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.profiles (id, email, access_level, role)
    values (new.id, new.email, 'pending', 'user')
    on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
