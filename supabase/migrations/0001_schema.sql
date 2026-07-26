-- autotrd — Grundschema (MS1 der Supabase-Migration).
--
-- Leitgedanken (bewusst anders als das Firestore-Modell):
--   1. GELD-INVARIANTEN GEHÖREN IN DIE DATENBANK. Firestore konnte einen
--      negativen Kontostand nur per Anwendungscode verhindern; hier tut es
--      ein CHECK-Constraint, an dem auch ein fehlerhafter Codepfad scheitert.
--   2. Jede Geld-Tabelle hat eine user_id mit RLS: Lesen darf nur der
--      Eigentümer, SCHREIBEN ausschließlich die service_role (Edge Functions).
--      Das ist die Übersetzung der Firestore-Regel „wallet/positions/trades
--      sind auch für den Owner read-only".
--   3. Numerik: Geldbeträge als numeric(20,4) — NIEMALS float. Cent-Rundung
--      bleibt Sache der Anwendung, aber Float-Drift kann hier nicht entstehen.
--   4. Zeitstempel immer timestamptz (UTC). Kalendertage (Equity-Snapshots,
--      Steuer-Jahre) bleiben date, weil sie fachlich Tage sind.

create extension if not exists pgcrypto;

-- ── Profile: 1:1 zu auth.users ───────────────────────────────────────────────
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  -- Strategie + UI-Präferenzen als JSONB: das flache Strategie-Schema aus
  -- shared/ bleibt unverändert gültig (ein Validator, zwei Speicher).
  settings jsonb not null default '{}'::jsonb,
  live_approved_at timestamptz,           -- M14-Doppelschloss, nur Owner setzt
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Wallets: mehrere je Nutzer (M12-Vorgriff), genau eines ist aktiv ────────
create table if not exists public.wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null default 'Paper',
  balance numeric(20,4) not null default 25000,
  currency text not null default 'USD',
  -- Reset-Zähler: eine Kennzahlenreihe bricht an der Zäsur bewusst ab,
  -- statt alte und neue Historie zu vermischen.
  epoch integer not null default 1,
  strategy_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- DIE zentrale Invariante: Ein Paper-Konto kann nicht ins Minus laufen.
  constraint wallets_balance_nonneg check (balance >= 0)
);
create index if not exists wallets_user_idx on public.wallets (user_id);

-- ── Positionen: je Wallet und Symbol höchstens eine offene ──────────────────
create table if not exists public.positions (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  symbol text not null,
  asset_class text,
  side text not null default 'long' check (side in ('long', 'short')),
  qty numeric(20,8) not null,
  avg_entry numeric(20,4) not null,
  stop_loss numeric(20,4),
  take_profit numeric(20,4),
  high_water numeric(20,4),   -- Bezugspunkt Trailing-Stop (long)
  low_water numeric(20,4),    -- Bezugspunkt Trailing-Stop (short)
  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint positions_qty_pos check (qty > 0),
  constraint positions_entry_pos check (avg_entry > 0),
  constraint positions_unique_open unique (wallet_id, symbol)
);
create index if not exists positions_user_idx on public.positions (user_id);

-- ── Trades: append-only Journal, Grundlage für Kennzahlen UND Steuer-Log ────
create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.wallets (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  symbol text not null,
  asset_class text,
  side text not null check (side in ('buy', 'sell')),
  qty numeric(20,8) not null check (qty > 0),
  price numeric(20,4) not null check (price > 0),
  raw_price numeric(20,4),                 -- vor Gebühren/Slippage
  fee numeric(20,4) not null default 0,
  pnl numeric(20,4),                       -- nur bei schließenden Trades
  is_cover boolean not null default false, -- Short-Eindeckung
  risk_exit text,                          -- stop_loss | take_profit | …
  source text not null check (source in ('engine', 'manual')),
  strategy_id uuid,
  -- Steuer-Felder (M12b): getrennt eingefroren, nie nachträglich gerechnet.
  fx_rate numeric(20,8),                   -- EZB-Referenzkurs USD→EUR
  fx_date date,
  tax_category text,                       -- aktie | fonds_etf | krypto | …
  executed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists trades_user_time_idx on public.trades (user_id, executed_at desc);
create index if not exists trades_wallet_time_idx on public.trades (wallet_id, executed_at desc);

-- ── Strategien (Studio) ────────────────────────────────────────────────────
create table if not exists public.strategies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  draft jsonb not null,
  compiled jsonb,
  status text not null default 'draft' check (status in ('draft', 'published')),
  mode text not null default 'paper' check (mode in ('paper', 'shadow')),
  symbols text[] not null default '{}',
  shadow jsonb,
  version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists strategies_user_idx on public.strategies (user_id);

-- ── Equity-Snapshots + Kennzahlen (M12) ────────────────────────────────────
create table if not exists public.equity_snapshots (
  wallet_id uuid not null references public.wallets (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  day date not null,
  equity numeric(20,4) not null,
  balance numeric(20,4) not null,
  positions_value numeric(20,4) not null default 0,
  positions_count integer not null default 0,
  created_at timestamptz not null default now(),
  -- Idempotenz wie die Datums-Doc-ID in Firestore: ein Rerun am selben Tag
  -- überschreibt, statt die Reihe zu verdoppeln.
  primary key (wallet_id, day)
);
create index if not exists equity_user_day_idx on public.equity_snapshots (user_id, day desc);

-- ── Marktdaten: geteilt, für alle Nutzer lesbar ────────────────────────────
create table if not exists public.market_symbols (
  symbol text primary key,
  name text,
  asset_class text,
  quote_price numeric(20,4),
  quote_change_pct numeric(10,4),
  quote_updated_at timestamptz,
  sentiment jsonb,
  forecast jsonb,
  forecast_intraday jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.bars (
  symbol text not null references public.market_symbols (symbol) on delete cascade,
  day date not null,
  open numeric(20,4) not null,
  high numeric(20,4) not null,
  low numeric(20,4) not null,
  close numeric(20,4) not null,
  volume bigint,
  primary key (symbol, day)
);

create table if not exists public.bars_5m (
  symbol text not null references public.market_symbols (symbol) on delete cascade,
  t bigint not null,                      -- Unix-Sekunden des Bar-Starts
  open numeric(20,4) not null,
  high numeric(20,4) not null,
  low numeric(20,4) not null,
  close numeric(20,4) not null,
  volume bigint,
  primary key (symbol, t)
);

create table if not exists public.signals (
  id uuid primary key default gen_random_uuid(),
  symbol text not null references public.market_symbols (symbol) on delete cascade,
  scan_id text not null,
  direction text not null check (direction in ('buy', 'sell', 'hold')),
  confluence integer not null default 0,
  price numeric(20,4),
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists signals_symbol_time_idx on public.signals (symbol, created_at desc);

-- ── Systemzustand (Heartbeat, Lernstatistik) — öffentlich lesbar ───────────
create table if not exists public.meta (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- ── updated_at automatisch pflegen ─────────────────────────────────────────
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['profiles','wallets','positions','strategies','market_symbols']
  loop
    execute format(
      'drop trigger if exists %I_touch on public.%I; '
      'create trigger %I_touch before update on public.%I '
      'for each row execute function public.touch_updated_at();',
      t, t, t, t);
  end loop;
end;
$$;
