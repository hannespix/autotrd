-- autotrd — Row Level Security (MS1).
--
-- Übersetzung der Firestore-Regeln (ARCHITECTURE.md §5) nach Postgres:
--   • Marktdaten + meta: lesen darf jeder Angemeldete (meta sogar anonym,
--     die Landing Page zeigt den Heartbeat), schreiben NIEMAND per Client.
--   • User-Daten: lesen nur der Eigentümer.
--   • Geld (wallets/positions/trades/equity): für den Eigentümer READ-ONLY —
--     geschrieben wird ausschließlich von Edge Functions mit service_role.
--     service_role umgeht RLS grundsätzlich; es gibt hier also bewusst KEINE
--     INSERT/UPDATE-Policy, denn jede wäre ein Loch in genau dieser Regel.
--   • profiles.settings darf der Eigentümer ändern (Strategie-Formular) —
--     die geldrelevanten Spalten sind eigene Spalten und damit außer Reichweite
--     (in Firestore brauchte es dafür einen affectedKeys-Vergleich).

alter table public.profiles          enable row level security;
alter table public.wallets           enable row level security;
alter table public.positions         enable row level security;
alter table public.trades            enable row level security;
alter table public.strategies        enable row level security;
alter table public.equity_snapshots  enable row level security;
alter table public.market_symbols    enable row level security;
alter table public.bars              enable row level security;
alter table public.bars_5m           enable row level security;
alter table public.signals           enable row level security;
alter table public.meta              enable row level security;

-- ── Profil ────────────────────────────────────────────────────────────────
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select using (auth.uid() = id);

-- Nur das eigene Profil, und die Zeile muss dem Aufrufer gehören — der
-- WITH CHECK verhindert, dass jemand die Zeile auf eine fremde id umschreibt.
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- ── Geld: ausschließlich lesen ────────────────────────────────────────────
drop policy if exists wallets_select_own on public.wallets;
create policy wallets_select_own on public.wallets
  for select using (auth.uid() = user_id);

drop policy if exists positions_select_own on public.positions;
create policy positions_select_own on public.positions
  for select using (auth.uid() = user_id);

drop policy if exists trades_select_own on public.trades;
create policy trades_select_own on public.trades
  for select using (auth.uid() = user_id);

drop policy if exists equity_select_own on public.equity_snapshots;
create policy equity_select_own on public.equity_snapshots
  for select using (auth.uid() = user_id);

-- ── Strategien: lesen ja, schreiben nur über die Edge Functions ───────────
-- (Validierung gegen shared/rules gehört auf den Server, nicht in die DB.)
drop policy if exists strategies_select_own on public.strategies;
create policy strategies_select_own on public.strategies
  for select using (auth.uid() = user_id);

-- ── Geteilte Marktdaten: für Angemeldete lesbar ───────────────────────────
drop policy if exists market_read on public.market_symbols;
create policy market_read on public.market_symbols
  for select using (auth.role() = 'authenticated');

drop policy if exists bars_read on public.bars;
create policy bars_read on public.bars
  for select using (auth.role() = 'authenticated');

drop policy if exists bars5m_read on public.bars_5m;
create policy bars5m_read on public.bars_5m
  for select using (auth.role() = 'authenticated');

drop policy if exists signals_read on public.signals;
create policy signals_read on public.signals
  for select using (auth.role() = 'authenticated');

-- ── meta: öffentlich (Heartbeat auf der Landing Page) ─────────────────────
drop policy if exists meta_read on public.meta;
create policy meta_read on public.meta for select using (true);
