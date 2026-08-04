/**
 * Signatur-Wächter der Supabase-Datenschicht (04.08.).
 *
 * Die Migration nach Supabase ist eingefroren (MILESTONES §MK: Firebase ist
 * bei jeder Nutzerzahl billiger, das Zeitdruck-Argument aus §MS ist zirkulär
 * geworden). Eingefroren heißt aber nicht vergessen — und genau da liegt die
 * Gefahr: `dataSupabase.ts` ist heute toter Code, der bei jeder Erweiterung
 * von `data.ts` still weiter zurückfällt. Aus zwanzig fehlenden Funktionen
 * werden unbemerkt vierzig, und dann ist MS keine Migration mehr, sondern
 * eine Neuimplementierung.
 *
 * Dieser Test misst den Rückstand und schreibt ihn fest. Er verlangt NICHT,
 * dass die Lücke geschlossen wird — er verlangt nur, dass sie nicht wächst,
 * ohne dass es jemand bemerkt. Wer eine Funktion zu `data.ts` hinzufügt,
 * trägt sie hier ein und entscheidet damit bewusst, ob die Supabase-Schicht
 * sie braucht.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const hier = dirname(fileURLToPath(import.meta.url));
const src = (datei: string): string => readFileSync(join(hier, '..', 'src', datei), 'utf8');

/** Exportierte Namen einer Datei (Funktionen und Konstanten). */
function exporte(quelle: string): Set<string> {
  const namen = new Set<string>();
  for (const m of quelle.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_]+)/gm)) {
    namen.add(m[1]!);
  }
  return namen;
}

/**
 * Bekannter Rückstand, Stand 04.08. — jeder Eintrag ist eine bewusste
 * Entscheidung, nicht ein Versehen.
 *
 * Die Gruppen sagen, WARUM etwas fehlt: Schreibende Callables laufen bei
 * Supabase über Edge Functions und brauchen einen anderen Aufruf; die
 * Lesepfade sind schlicht noch nicht portiert (MS2 Teil 3/4).
 */
const BEKANNTE_LUECKE = new Set([
  // Schreibpfade — bei Supabase Edge Functions statt Firebase Callables
  'adminListUsers', 'adminSetAccess', 'adminSetAdmin',
  'callQuoteNow', 'callSavePrediction', 'callTrade',
  'ensureProfile', 'resetWallet', 'saveStrategy', 'saveWorkspace',
  // Lesepfade — MS2 Teil 3 (Nutzerdaten) und Teil 4 (Prognose-Ketten)
  'loadDailyChunk', 'loadMoreTrades', 'loadPrediction', 'loadUniverse',
  'loadWorkspace', 'watchEvaluatedForecasts', 'watchPositioning',
  'watchTuneGlobal', 'watchWatchedSymbols',
  // Konstante, kein Verhalten
  'TRADE_PAGE',
]);

describe('Supabase-Datenschicht: Signatur-Parität', () => {
  const firebase = exporte(src('data.ts'));
  const supabase = exporte(src('dataSupabase.ts'));
  const fehlend = [...firebase].filter((n) => !supabase.has(n)).sort();

  it('hat keine UNBEKANNTE Lücke — neue data.ts-Exporte müssen entschieden werden', () => {
    const neu = fehlend.filter((n) => !BEKANNTE_LUECKE.has(n));
    expect(
      neu,
      `Neu in data.ts, aber nicht in dataSupabase.ts: ${neu.join(', ')}\n` +
        'Entweder portieren oder bewusst in BEKANNTE_LUECKE eintragen.',
    ).toEqual([]);
  });

  it('hält die Liste sauber — erledigte Einträge müssen raus', () => {
    // Wer eine Funktion portiert, soll sie hier streichen. Sonst verliert die
    // Liste ihre Aussagekraft und wird zum Friedhof.
    const erledigt = [...BEKANNTE_LUECKE].filter((n) => supabase.has(n)).sort();
    expect(
      erledigt,
      `Portiert, steht aber noch in BEKANNTE_LUECKE: ${erledigt.join(', ')}`,
    ).toEqual([]);
  });

  it('dokumentiert den Rückstand als Zahl', () => {
    // Kein Grenzwert, nur ein Messpunkt: 20 von 40 Exporten fehlen (04.08.).
    // Wächst die Zahl, schlägt der erste Test an — nicht dieser.
    expect(fehlend.length).toBe(BEKANNTE_LUECKE.size);
    expect(firebase.size).toBeGreaterThan(supabase.size);
  });
});
