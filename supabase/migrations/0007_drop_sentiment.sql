-- 0007 — Sentiment-Spalte entfernen (Owner-Direktive 28.07.)
--
-- Die News-Strecke ist aus dem System ausgebaut: keine Feeds, kein
-- Lexikon-Sentiment, keine KI-Tageserklärung. Kein Lauf schreibt diese
-- Spalte mehr, kein Lesepfad wertet sie aus.
--
-- Warum eine eigene Migration statt einer Änderung an 0001: Migrationen
-- sind eine Historie, kein Entwurf. Wer 0001 nachträglich umschreibt,
-- bekommt bei jeder bereits migrierten Datenbank eine andere Wahrheit als
-- im Repo — genau der Zustand, in dem niemand mehr weiß, was live gilt.
--
-- IF EXISTS, weil die Spalte auf frischen Datenbanken je nach Reihenfolge
-- schon fehlen kann; die Migration muss auch dann durchlaufen.

alter table public.market_symbols drop column if exists sentiment;
