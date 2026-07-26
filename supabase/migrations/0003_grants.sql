-- Explizite Tabellenrechte (MS1, Nachtrag).
--
-- Das Projekt ist bewusst OHNE „Automatically expose new tables" angelegt:
-- Eine neue Tabelle ist damit erst erreichbar, wenn sie hier freigegeben
-- wird. Das kostet eine Zeile pro Tabelle und verhindert dafür den
-- teuersten denkbaren Fehler — eine Geld-Tabelle, die jemand ohne Schutz
-- ausliefert, weil die Freigabe „automatisch" passierte.
--
-- Zusammenspiel der beiden Ebenen:
--   GRANT  = darf die Rolle die Tabelle überhaupt ansprechen?
--   POLICY = welche ZEILEN sieht sie dann? (0002_rls.sql)
-- Beides muss zutreffen. Fehlt der GRANT, ist die Tabelle unsichtbar —
-- auch wenn eine Policy sie erlauben würde.

grant usage on schema public to anon, authenticated;

-- ── Eigene Daten: lesen (die Policies grenzen auf die eigenen Zeilen ein) ──
grant select on public.profiles         to authenticated;
grant select on public.wallets          to authenticated;
grant select on public.positions        to authenticated;
grant select on public.trades           to authenticated;
grant select on public.strategies       to authenticated;
grant select on public.equity_snapshots to authenticated;

-- Nur die Einstellungen darf der Nutzer selbst ändern (Strategie-Formular).
-- Kein UPDATE auf wallets/positions/trades: Geld schreibt ausschließlich die
-- service_role, und die umgeht Rechte wie Policies ohnehin.
grant update on public.profiles to authenticated;

-- ── Geteilte Marktdaten: lesen für Angemeldete ────────────────────────────
grant select on public.market_symbols to authenticated;
grant select on public.bars           to authenticated;
grant select on public.bars_5m        to authenticated;
grant select on public.signals        to authenticated;

-- ── Heartbeat: auch anonym (die Landing Page zeigt den Systemzustand) ─────
grant select on public.meta to anon, authenticated;
