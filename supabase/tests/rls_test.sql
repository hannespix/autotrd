-- RLS- und Constraint-Tests (MS1).
--
-- Prüft genau die Zusagen, die in Firestore per Rules galten und jetzt der
-- Datenbank obliegen. Jeder Fehlschlag wirft eine Exception → das Skript
-- endet mit Exit-Code ungleich 0, der Lauf wird rot.

\set ON_ERROR_STOP on

-- ── Testdaten anlegen (als Eigentümer/Superuser, RLS wirkt hier nicht) ─────
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a@test.de'),
  ('22222222-2222-2222-2222-222222222222', 'b@test.de');

insert into public.profiles (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a@test.de'),
  ('22222222-2222-2222-2222-222222222222', 'b@test.de');

insert into public.wallets (id, user_id, balance) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 25000),
  ('bbbbbbbb-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 25000);

insert into public.market_symbols (symbol, name, asset_class, quote_price)
  values ('QQQ', 'Invesco QQQ', 'etf_sectors', 684.23);

insert into public.trades (wallet_id, user_id, symbol, side, qty, price, source)
  values ('aaaaaaaa-0000-0000-0000-000000000001',
          '11111111-1111-1111-1111-111111111111', 'QQQ', 'buy', 3, 684.23, 'manual');

-- Leserechte für die Rollen (in Supabase macht das die Plattform)
grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to anon, authenticated;
grant insert, update, delete on all tables in schema public to authenticated;

-- ── 1) Eigentümer sieht seine Zeilen ──────────────────────────────────────
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claim.role = 'authenticated';

do $$
declare n integer;
begin
  select count(*) into n from public.wallets;
  if n <> 1 then raise exception 'FAIL 1a: Eigentümer sieht % Wallets statt 1', n; end if;
  select count(*) into n from public.trades;
  if n <> 1 then raise exception 'FAIL 1b: Eigentümer sieht % Trades statt 1', n; end if;
  raise notice 'OK 1: Eigentümer sieht genau seine Wallet- und Trade-Zeilen';
end;
$$;

-- ── 2) Fremde Daten sind unsichtbar (der eigentliche Mandanten-Schutz) ────
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$
declare n integer;
begin
  select count(*) into n from public.trades;
  if n <> 0 then raise exception 'FAIL 2: Fremder Nutzer sieht % Trades statt 0', n; end if;
  select count(*) into n from public.wallets;
  if n <> 1 then raise exception 'FAIL 2b: Nutzer B sieht % Wallets statt seiner 1', n; end if;
  raise notice 'OK 2: Nutzer B sieht keine fremden Trades, nur sein eigenes Wallet';
end;
$$;

-- ── 3) Geld ist auch für den Eigentümer READ-ONLY ─────────────────────────
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$
begin
  begin
    update public.wallets set balance = 999999
      where id = 'aaaaaaaa-0000-0000-0000-000000000001';
    -- Ohne UPDATE-Policy trifft der Befehl 0 Zeilen (RLS blendet sie aus),
    -- statt zu werfen. Deshalb wird der Effekt geprüft, nicht die Exception.
    if found then raise exception 'FAIL 3: Eigentümer konnte seinen Kontostand ändern'; end if;
  exception when insufficient_privilege then
    null; -- ebenfalls in Ordnung
  end;
  raise notice 'OK 3: Kontostand ist per RLS nicht vom Client änderbar';
end;
$$;

do $$
begin
  begin
    insert into public.trades (wallet_id, user_id, symbol, side, qty, price, source)
      values ('aaaaaaaa-0000-0000-0000-000000000001',
              '11111111-1111-1111-1111-111111111111', 'QQQ', 'sell', 1, 700, 'manual');
    raise exception 'FAIL 4: Client konnte einen Trade erfinden';
  exception when insufficient_privilege or check_violation then
    raise notice 'OK 4: Client kann keine Trades schreiben';
  end;
end;
$$;

-- ── 5) Eigene Einstellungen darf der Nutzer ändern (Strategie-Formular) ───
do $$
declare n integer;
begin
  update public.profiles set settings = '{"strategy":{"watchlist":["QQQ"]}}'::jsonb
    where id = '11111111-1111-1111-1111-111111111111';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 5: Eigene settings nicht änderbar (% Zeilen)', n; end if;
  raise notice 'OK 5: Eigene Einstellungen sind änderbar';
end;
$$;

-- ── 6) Fremdes Profil bleibt unangetastet ─────────────────────────────────
do $$
declare n integer;
begin
  update public.profiles set settings = '{"boese":true}'::jsonb
    where id = '22222222-2222-2222-2222-222222222222';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 6: Fremdes Profil war änderbar'; end if;
  raise notice 'OK 6: Fremdes Profil ist nicht änderbar';
end;
$$;

-- ── 7) Geld-Invariante: negativer Kontostand ist unmöglich ────────────────
-- Auch der Server (service_role) kommt daran nicht vorbei — genau das ist
-- der Gewinn gegenüber Firestore, wo nur der Anwendungscode aufpasste.
reset role;
do $$
begin
  begin
    update public.wallets set balance = -1
      where id = 'aaaaaaaa-0000-0000-0000-000000000001';
    raise exception 'FAIL 7: Negativer Kontostand wurde akzeptiert';
  exception when check_violation then
    raise notice 'OK 7: Negativer Kontostand wird von der Datenbank abgelehnt';
  end;
end;
$$;

-- ── 8) Weitere Invarianten: qty/price müssen positiv sein ─────────────────
do $$
begin
  begin
    insert into public.positions (wallet_id, user_id, symbol, qty, avg_entry)
      values ('aaaaaaaa-0000-0000-0000-000000000001',
              '11111111-1111-1111-1111-111111111111', 'QQQ', 0, 684.23);
    raise exception 'FAIL 8: Position mit qty=0 wurde angelegt';
  exception when check_violation then
    raise notice 'OK 8: qty=0 wird abgelehnt';
  end;
end;
$$;

-- ── 9) Doppelte offene Position je Wallet+Symbol ist ausgeschlossen ───────
do $$
begin
  insert into public.positions (wallet_id, user_id, symbol, qty, avg_entry)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            '11111111-1111-1111-1111-111111111111', 'QQQ', 3, 684.23);
  begin
    insert into public.positions (wallet_id, user_id, symbol, qty, avg_entry)
      values ('aaaaaaaa-0000-0000-0000-000000000001',
              '11111111-1111-1111-1111-111111111111', 'QQQ', 1, 690);
    raise exception 'FAIL 9: Zweite offene Position auf dasselbe Symbol möglich';
  exception when unique_violation then
    raise notice 'OK 9: Nur eine offene Position je Wallet und Symbol';
  end;
end;
$$;

-- ── 10) Equity-Snapshot ist idempotent (Rerun am selben Tag) ──────────────
do $$
declare n integer;
begin
  insert into public.equity_snapshots (wallet_id, user_id, day, equity, balance)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            '11111111-1111-1111-1111-111111111111', current_date, 25000, 25000);
  insert into public.equity_snapshots (wallet_id, user_id, day, equity, balance)
    values ('aaaaaaaa-0000-0000-0000-000000000001',
            '11111111-1111-1111-1111-111111111111', current_date, 25100, 25100)
    on conflict (wallet_id, day) do update
      set equity = excluded.equity, balance = excluded.balance;
  select count(*) into n from public.equity_snapshots;
  if n <> 1 then raise exception 'FAIL 10: % Snapshot-Zeilen statt 1', n; end if;
  raise notice 'OK 10: Zweiter Snapshot am selben Tag überschreibt statt zu verdoppeln';
end;
$$;

-- ── 11) Marktdaten: angemeldet lesbar, anonym nicht ───────────────────────
set role authenticated;
set request.jwt.claim.role = 'authenticated';
do $$
declare n integer;
begin
  select count(*) into n from public.market_symbols;
  if n <> 1 then raise exception 'FAIL 11: Angemeldeter sieht % Symbole statt 1', n; end if;
  raise notice 'OK 11: Angemeldete lesen die geteilten Marktdaten';
end;
$$;

reset role;
set role anon;
set request.jwt.claim.role = 'anon';
do $$
declare n integer;
begin
  select count(*) into n from public.market_symbols;
  if n <> 0 then raise exception 'FAIL 12: Anonymer sieht % Symbole statt 0', n; end if;
  raise notice 'OK 12: Anonyme sehen keine Marktdaten';
end;
$$;
reset role;

select '── Alle RLS- und Constraint-Tests bestanden ──' as ergebnis;
