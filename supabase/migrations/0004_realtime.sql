-- Realtime-Veröffentlichung (MS1 → Vorbereitung MS2).
--
-- Supabase liefert Live-Updates nur für Tabellen, die in der Publikation
-- `supabase_realtime` stehen. Das ist das Gegenstück zu Firestores
-- onSnapshot: Ohne diesen Eintrag liest der Client zwar korrekt, sieht
-- Änderungen aber erst beim nächsten manuellen Laden — ein Fehlerbild, das
-- man leicht für „Engine handelt nicht" hält.
--
-- REPLICA IDENTITY FULL bei den nutzerbezogenen Tabellen: Ohne sie enthält
-- der WAL-Eintrag bei UPDATE/DELETE nur den Primärschlüssel. Realtime kann
-- dann nicht prüfen, ob die betroffene Zeile dem lauschenden Nutzer gehört,
-- und liefert das Ereignis vorsichtshalber NICHT aus. Mit FULL steht die
-- ganze Zeile im Log, die RLS-Prüfung greift, und jeder Nutzer bekommt
-- ausschließlich seine eigenen Änderungen. Kostet etwas mehr WAL-Volumen —
-- bei unseren Zeilengrößen (ein paar Zahlen je Trade) irrelevant.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end;
$$;

-- Hilfsprozedur: Tabelle nur hinzufügen, wenn sie noch nicht drin ist
-- (die Migration muss beliebig oft laufen dürfen).
do $$
declare t text;
begin
  foreach t in array array[
    'market_symbols',   -- Kurse/Prognosen: treibt Watchlist und Charts
    'signals',          -- Signal-Feed
    'meta',             -- Heartbeat
    'wallets',          -- Kontostand nach jedem Trade
    'positions',        -- offene Positionen
    'trades',           -- Trade-Historie
    'strategies',       -- Studio-Karten (Status/Zuordnung)
    'equity_snapshots'  -- Kennzahlen-Karte nach dem Tages-Snapshot
  ]
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;

-- Vollständige Zeilen im WAL, damit Realtime die RLS-Prüfung machen kann.
-- Nur für nutzerbezogene Tabellen nötig; market_symbols/meta sind für alle
-- Angemeldeten gleich sichtbar und brauchen keinen Zeilenfilter.
alter table public.wallets          replica identity full;
alter table public.positions        replica identity full;
alter table public.trades           replica identity full;
alter table public.strategies       replica identity full;
alter table public.equity_snapshots replica identity full;
