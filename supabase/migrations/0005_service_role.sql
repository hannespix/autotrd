-- Rechte für die service_role (MS1, Nachtrag aus dem ersten Live-Lauf).
--
-- BEFUND 26.07.: Weil das Projekt ohne „Automatically expose new tables"
-- angelegt ist, vergibt Supabase auch der service_role keine Rechte mehr
-- automatisch. Der erste Zugriff scheiterte prompt mit
--   42501 permission denied for table market_symbols
-- Ohne diesen Nachtrag könnten die Edge Functions später NICHTS schreiben —
-- kein Trade, kein Scan-Ergebnis, kein Snapshot. Der lokale Test hat es
-- nicht gezeigt, weil er als Superuser lief, der ohnehin alles darf; erst
-- der Zugriff gegen die echte Instanz brachte es ans Licht.
--
-- Warum das trotzdem sicher ist: service_role ist der SERVER. Sie umgeht
-- Row Level Security ohnehin (bypassrls) — die Rechte hier machen sie also
-- nicht mächtiger, sie machen sie überhaupt erst arbeitsfähig. Der Schutz
-- liegt woanders: Der service_role-Schlüssel verlässt nie den Server, und
-- die CHECK-Constraints aus 0001 gelten auch für sie (ein negativer
-- Kontostand bleibt unmöglich, egal wer schreibt).

grant usage on schema public to service_role;
grant all privileges on all tables    in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant all privileges on all functions in schema public to service_role;

-- Damit künftige Migrationen nicht wieder in dieselbe Falle laufen: Neue
-- Tabellen bekommen die Rechte automatisch. Gilt für Objekte, die von der
-- Migrations-Rolle (postgres) angelegt werden — also für alle unsere.
alter default privileges in schema public grant all on tables    to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant all on functions to service_role;
