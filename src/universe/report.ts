/**
 * Bericht der nächtlichen Universums-Auswahl. Er soll eine Frage beantworten:
 * Warum handelt die Plattform ab morgen genau diese Symbole — und warum die
 * anderen nicht? Deshalb steht JEDER Kandidat in der Tabelle, auch der
 * abgelehnte, mit Kennzahl und Grund.
 */
import type { UniverseAuswahl, UniverseRegeln } from './select.ts';

function geld(x: number): string {
  if (x >= 1e9) return `${(x / 1e9).toFixed(2)} Mrd.`;
  if (x >= 1e6) return `${(x / 1e6).toFixed(1)} Mio.`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(0)} Tsd.`;
  return x.toFixed(0);
}

export function renderUniverseReport(a: {
  auswahl: UniverseAuswahl;
  regeln: UniverseRegeln;
  benchmark: string | undefined;
  kandidaten: number;
  jetzt: number;
}): string {
  const { auswahl, regeln } = a;
  const L: string[] = [];
  const iso = new Date(a.jetzt).toISOString();
  L.push(`# Universums-Auswahl ${iso.slice(0, 10)}`);
  L.push('');
  L.push(`- Erzeugt: ${iso.slice(0, 16).replace('T', ' ')} UTC`);
  L.push(`- Kandidaten: ${a.kandidaten} · gewählt: ${auswahl.symbols.length} von höchstens ${regeln.max}`);
  L.push(
    `- Regel: Median-Dollarumsatz über ${regeln.fensterTage} Handelstage; mindestens ${regeln.minTage} Bars, ` +
      `Kurs ≥ ${regeln.minPreis} $, Umsatz ≥ ${geld(regeln.minDollarVolumen)} $/Tag, letzte Bar höchstens ${regeln.maxAlterTage} Tage alt`,
  );
  L.push(
    `- Hysterese: Wer schon dabei ist, bleibt bis Rang ${regeln.max + regeln.haltePuffer} — sonst tauscht der Korb jede Nacht auf Rauschen. ` +
      `Umgekehrt kommt ein Neuer erst herein, wenn ein Bestandswert hinter Rang ${regeln.max + regeln.haltePuffer} fällt`,
  );
  L.push(`- Notbremsen: mindestens ${Math.max(1, Math.ceil(regeln.max * regeln.minAnteil))} Symbole, höchstens ${regeln.maxAbgang} Abgänge je Nacht (sonst Abbruch, Universum bleibt stehen)`);
  L.push(`- Benchmark: ${a.benchmark ?? '—'}`);
  L.push('');
  L.push('**Nach Handelbarkeit gewählt, nie nach dem Ergebnis der Strategie.** Die Auswahl sieht kein PnL, keine Trades und keinen Champion —');
  L.push('sonst wäre sie Selektionsbias mit Extraschritt: Symbole aussuchen, auf denen es zufällig lief, und sie dann auf denselben Daten messen.');
  L.push('');
  L.push('> Zwei ehrliche Einschränkungen. **(1)** Dollarumsatz ist Stückzahl × Kurs, enthält also das Kursniveau und damit vergangene Rendite;');
  L.push('> bei gleicher Stückzahl gewinnt der gestiegene Wert. Das ist der Preis dafür, Liquidität in Dollar zu messen — und Dollar sind, was ein');
  L.push('> Auto-Trader bewegt. **(2)** Diese Auswahl beschreibt HEUTE und gilt dem Betrieb. Der Optimierer wählt je Fold punkt-in-zeit aus');
  L.push('> demselben Pool (§5a.13); der Pool selbst ist von heute — wer im Messzeitraum verschwunden ist, kommt nicht vor.');
  L.push('');
  L.push(`- Zugang: ${auswahl.zugang.length ? auswahl.zugang.join(', ') : '—'}`);
  L.push(`- Abgang: ${auswahl.abgang.length ? auswahl.abgang.join(', ') : '—'}`);
  L.push('');
  L.push('| Rang | Symbol | Median-Umsatz/Tag | Bars | Kurs | Status | Grund |');
  L.push('|---:|---|---:|---:|---:|---|---|');
  for (const b of auswahl.bewertung) {
    L.push(
      `| ${b.rang ?? '—'} | ${b.symbol} | ${geld(b.dollarVolumen)} $ | ${b.tage} | ${b.letzterKurs.toFixed(2)} | ${b.status} | ${b.grund} |`,
    );
  }
  L.push('');
  return L.join('\n');
}
