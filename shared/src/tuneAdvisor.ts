/**
 * Einstellungs-Prüfer — findet Konfigurationen, die sich selbst widersprechen.
 *
 * ── Was das hier NICHT ist ────────────────────────────────────────────────
 *
 * Kein Optimierer. Es weiß nicht, welche Parameter Rendite bringen — das
 * kann derzeit niemand wissen, weil die Handelshistorie gerade
 * zurückgesetzt wurde und die davor ein System maß, das es nicht mehr gibt.
 * Wer hier „optimale Einstellungen" verspricht, verkauft eine Behauptung.
 *
 * Den datengetriebenen Teil gibt es bereits und er heißt `autoTune`: Der
 * probiert Varianten im Schatten aus und befördert nur, was eine
 * Evidenzschwelle besteht. Dieses Modul ist etwas anderes und Bescheideneres.
 *
 * ── Was es IST ────────────────────────────────────────────────────────────
 *
 * Eine Sammlung von Regeln, die Konfigurationen erkennen, deren Teile
 * gegeneinander arbeiten — unabhängig davon, wie der Markt läuft. Beispiele
 * aus dem echten Konto vom 28.07.:
 *
 *  - Hebel 3× bei ausgeschaltetem nachziehenden Stop. Der Hebel verdreifacht
 *    den Rücklauf eines Buchgewinns, und der einzige Mechanismus, der ihn
 *    sichern würde, ist aus.
 *  - „Max. 30 Positionen", während der Korrelations-Deckel bei ~24 bindet.
 *    Die Zahl steht da und bewirkt nichts.
 *  - 10 % je Position mal Hebel 3 sind 30 % Eigenkapital in einem einzigen
 *    Titel — mehr, als das Klumpenrisiko-Limit ohne Hebel je zuließe.
 *
 * Solche Befunde brauchen keine Statistik, nur Arithmetik. Genau deshalb
 * darf man sie automatisieren; eine Rendite-Vorhersage nicht.
 *
 * Jeder Vorschlag trägt seinen GRUND mit sich. Ein Prüfer, der nur „setz das
 * auf 3" sagt, erzieht zum Klicken statt zum Verstehen — und beim nächsten
 * Mal steht der Wert wieder falsch.
 */

import { DEFAULT_MAINTENANCE_MARGIN, MAX_LEVERAGE } from './margin.js';
import { MIN_EDGE_MULTIPLE } from './costGate.js';
import { MAX_OPEN_POSITIONS_CAP, type Strategy } from './strategy.js';
import { MAX_PER_CLUSTER, correlationCluster, tradableSymbols } from './universe.js';

export type Severity = 'kritisch' | 'wichtig' | 'hinweis';

export interface Suggestion {
  /** Stabiler Schlüssel — die UI übernimmt genau die angehakten. */
  key: string;
  /** Was betroffen ist, in der Sprache der Oberfläche. */
  label: string;
  severity: Severity;
  /** Aktueller Wert, wie er gespeichert ist. */
  current: number | string | boolean;
  /** Was stattdessen gesetzt würde. */
  suggested: number | string | boolean;
  /** WARUM. Der wichtigste Teil — ohne ihn ist es ein Zauberknopf. */
  reason: string;
}

/**
 * Bei welchem Marktrückgang der Zwangsverkauf greift — bei voller Auslastung
 * des Hebels.
 *
 * Herleitung: Bei Hebel L und Eigenkapital E stehen L·E im Markt, geliehen
 * sind (L−1)·E. Nach einem Rückgang d ist das Eigenkapital E·(1−L·d) und der
 * Positionswert L·E·(1−d). Die Marge ist der Quotient; der Zwangsverkauf
 * greift, wenn sie unter die Erhaltungsmarge m fällt:
 *
 *     (1 − L·d) / (L · (1 − d)) = m   ⟹   d = (1 − L·m) / (L − L·m)
 *
 * Für 3× und 25 % ergibt das 11,1 % — für 2× dagegen 33,3 %. Der Sprung
 * zwischen den beiden ist der Grund, warum diese Funktion existiert: Er ist
 * viel größer, als „ein Drittel weniger Hebel" vermuten lässt, und ohne die
 * Rechnung schätzt man ihn zuverlässig falsch.
 */
export function marginCallDrawdownPct(
  leverage: number,
  maintenanceMargin = DEFAULT_MAINTENANCE_MARGIN,
): number | null {
  const L = Math.min(Math.max(1, leverage), MAX_LEVERAGE);
  if (L <= 1) return null; // ohne Kredit kein Zwangsverkauf
  const d = (1 - L * maintenanceMargin) / (L - L * maintenanceMargin);
  if (!(d > 0)) return 0;
  return Math.round(d * 1000) / 10;
}

/**
 * Wie viele Positionen der Korrelations-Deckel überhaupt zulässt.
 *
 * Aus dem handelbaren Katalog gerechnet, nicht geschätzt: Jeder
 * Korrelationsblock stellt höchstens `MAX_PER_CLUSTER`. Steht das
 * Positionslimit darüber, ist die Zahl Dekoration — sie bindet nie.
 */
export function erreichbarePositionen(max = MAX_PER_CLUSTER): number {
  const bloecke = new Set(tradableSymbols().map(correlationCluster));
  return bloecke.size * max;
}

const r1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * Prüft eine Strategie und liefert die Widersprüche, schwerste zuerst.
 *
 * Leere Liste heißt NICHT „optimal" — nur „nichts, was sich selbst im Weg
 * steht". Der Unterschied steht auch in der Oberfläche.
 */
export function adviseStrategy(strategy: Strategy): Suggestion[] {
  const out: Suggestion[] = [];
  const e = strategy.engine;
  const s = strategy.signals;
  const hebel = Math.min(Math.max(1, strategy.broker.leverage ?? 1), MAX_LEVERAGE);
  const trailing = e.trailingStopPct ?? 0;
  const atrStop = e.atrStopMult ?? 0;

  // ── 1. Hebel ohne nachziehenden Stop ───────────────────────────────────
  if (hebel > 1 && trailing <= 0) {
    out.push({
      key: 'trailingStopPct',
      label: 'Nachziehender Stop',
      severity: 'kritisch',
      current: trailing,
      suggested: 3,
      reason:
        `Mit ${hebel}× Hebel wird jeder Rücklauf eines Buchgewinns ${hebel}-fach verstärkt — ` +
        'und der nachziehende Stop ist der einzige Ausstieg, der Gewinne sichert, sobald eine ' +
        'Position im Plus war. Er steht auf 0, also aus. Die Messung sagt dazu: Über 214 Trades ' +
        'hat das Gewinnziel KEIN EINZIGES MAL ausgelöst, 95 % starben am Signal-Ausstieg. Ohne ' +
        'nachziehenden Stop gibt es damit praktisch keinen Weg, einen Gewinn zu realisieren.',
    });
  }

  // ── 2. Zwangsverkaufs-Schwelle des Hebels ──────────────────────────────
  const dd = marginCallDrawdownPct(hebel);
  if (hebel > 2 && dd !== null) {
    const dd2 = marginCallDrawdownPct(2);
    out.push({
      key: 'leverage',
      label: 'Hebel (Margin)',
      severity: 'wichtig',
      current: hebel,
      suggested: 2,
      reason:
        `Bei ${hebel}× und voller Auslastung löst schon ein Marktrückgang von ${dd} % den ` +
        `Zwangsverkauf aus (Erhaltungsmarge 25 %). Bei 2× sind es ${dd2} % — der Abstand ist ` +
        'viel größer, als „ein Drittel weniger Hebel" klingt, weil die Marge nicht linear ' +
        'läuft. Solange keine saubere Messstrecke existiert, kaufst du dir mit 2× sehr viel ' +
        'Luft für sehr wenig entgangene Verstärkung.',
    });
  }

  // ── 3. Klumpenrisiko: Positionsgröße mal Hebel ─────────────────────────
  const effektiv = e.maxPositionPct * hebel;
  if (hebel > 1 && effektiv > 25) {
    const vorschlag = Math.max(1, Math.floor(25 / hebel));
    out.push({
      key: 'maxPositionPct',
      label: 'Investment je Trade',
      severity: 'wichtig',
      current: e.maxPositionPct,
      suggested: vorschlag,
      reason:
        `${e.maxPositionPct} % je Position mal ${hebel}× Hebel sind ${r1(effektiv)} % des ` +
        'Eigenkapitals in EINEM Titel. Die Risiko-Hülle deckelt ohne Hebel bei 25 % — mit Hebel ' +
        `skaliert die Tranche mit, und dieser Deckel greift nicht mehr. ${vorschlag} % ergeben ` +
        `wieder ${r1(vorschlag * hebel)} %.`,
    });
  }

  // ── 4. Positionslimit über dem, was der Korrelations-Deckel zulässt ────
  const erreichbar = erreichbarePositionen();
  if (e.maxOpenPositions !== undefined && e.maxOpenPositions > erreichbar) {
    out.push({
      key: 'maxOpenPositions',
      label: 'Max. gleichzeitige Positionen',
      severity: 'hinweis',
      current: e.maxOpenPositions,
      suggested: Math.min(MAX_OPEN_POSITIONS_CAP, erreichbar),
      reason:
        `Der Korrelations-Deckel lässt höchstens ${MAX_PER_CLUSTER} Positionen je Block zu; über ` +
        `das handelbare Universum ergibt das ${erreichbar}. Alles darüber ist Dekoration — die ` +
        'Zahl steht da und bindet nie. Im Live-Scan wurden zuletzt 10 von 10 Einstiegen wegen ' +
        'vollem Block abgelehnt, nicht wegen des Positionslimits.',
    });
  }

  // ── 5. Kostenschwelle aus ──────────────────────────────────────────────
  if ((s.minEdgeMultiple ?? MIN_EDGE_MULTIPLE) <= 0) {
    out.push({
      key: 'minEdgeMultiple',
      label: 'Kostenschwelle',
      severity: 'kritisch',
      current: s.minEdgeMultiple ?? 0,
      suggested: MIN_EDGE_MULTIPLE,
      reason:
        'Die Kostenschwelle ist abgeschaltet. Sie ist der Filter, der aus der Live-Auswertung ' +
        'hervorging: Über 214 Trades betrugen die Gebühren das 2,1-Fache des Brutto-Ergebnisses. ' +
        'Ohne sie handelt die Engine wieder um Beträge, die in der Größenordnung der Reibung liegen.',
    });
  }

  // ── 6. Mindest-Haltedauer zu kurz für 5-Minuten-Signale ────────────────
  const tf = s.timeframe ?? 'intraday';
  const minHold = e.minHoldMin ?? 60;
  if (tf === 'intraday' && minHold < 30) {
    out.push({
      key: 'minHoldMin',
      label: 'Mindest-Haltedauer',
      severity: 'wichtig',
      current: minHold,
      suggested: 60,
      reason:
        `Auf 5-Minuten-Kerzen kippt ständig eine von drei Indikator-Stimmen. Mit ${minHold} ` +
        'Minuten Mindest-Haltedauer fliegt eine Position im nächsten Rauschen wieder raus — ' +
        'inklusive Gebühr. Genau dieses Muster steckt hinter „95 % Ausstieg am Signal". Die ' +
        'Haltedauer bremst NUR den Signal-Ausstieg; Stop, Ziel und nachziehender Stop bleiben ' +
        'jederzeit scharf.',
    });
  }

  // ── 7. Momentum-Modus mit Hebel ────────────────────────────────────────
  if (e.mode === 'momentum' && hebel > 1) {
    out.push({
      key: 'leverageMomentum',
      label: 'Hebel im Momentum-Modus',
      severity: 'kritisch',
      current: hebel,
      suggested: 1,
      reason:
        'Der Momentum-Modus hält bewusst OHNE Stop-Loss durch Rücksetzer hindurch — das ist ' +
        'Teil der Strategie, nicht ein Versäumnis. Mit Hebel bedeutet das: verstärkte Verluste ' +
        'und als einzige Bremse der Margin-Call. Diese Kombination hat kein Sicherheitsnetz ' +
        'zwischen „läuft" und „Konto wird zwangsweise glattgestellt".',
    });
  }

  // ── 8. Weder fester noch ATR-Stop ──────────────────────────────────────
  if (e.stopLossPct <= 0 && atrStop <= 0) {
    out.push({
      key: 'stopLossPct',
      label: 'Stop-Loss',
      severity: 'kritisch',
      current: e.stopLossPct,
      suggested: 2,
      reason:
        'Es ist weder ein fester noch ein ATR-Stop gesetzt. Die Risiko-Hülle zieht dann eine ' +
        'Notbremse bei 25 % ein — aber die ist eine Katastrophengrenze, keine Handelsregel. ' +
        'Zwischen Einstieg und 25 % Verlust gäbe es nichts.',
    });
  }

  // ── 9. 5-Minuten-Signale: gemessen ohne Kante ──────────────────────────
  if (tf === 'intraday' && e.mode !== 'momentum') {
    out.push({
      key: 'timeframe',
      label: 'Signal-Zeitrahmen',
      severity: 'wichtig',
      current: 'intraday',
      suggested: 'daily',
      reason:
        'Der 5-Minuten-Zeitrahmen ist an der Realität gescheitert: In den zwei Handelstagen ' +
        'nach dem Konto-Reset entstanden 525 Trades, 97 % davon starben am Signal-Ausstieg ' +
        '(Trefferquote dort 16,8 %), die Gebühren waren das 4,7-Fache des Brutto-Ergebnisses, ' +
        'Profitfaktor 0,18. Auf 5-min-Kerzen kippt die Konfluenz im Rauschen — und die ' +
        'Kostenschwelle prüft die erwartete BEWEGUNG, nicht den erwarteten GEWINN; ein Signal ' +
        'ohne Richtungs-Kante kann sie nicht retten. Tageskerzen drehen um Größenordnungen ' +
        'seltener; Stop, Ziel und nachziehender Stop bekommen überhaupt erst die Zeit zu wirken.',
    });
  }

  // ── 10. News-Veto aus ──────────────────────────────────────────────────
  if (s.newsVeto === false) {
    out.push({
      key: 'newsVeto',
      label: 'News-Veto',
      severity: 'hinweis',
      current: false,
      suggested: true,
      reason:
        'Das News-Veto ist abgeschaltet. Es sperrt Einstiege für einige Stunden, wenn zu einem ' +
        'Symbol gerade ein hartes Ereignis läuft (Earnings, Klage, Guidance, Übernahme) — genau ' +
        'dann springen Kurse, und die Indikator-Signale, auf denen der Einstieg beruht, sind am ' +
        'wenigsten wert. Es kann Trades nur verhindern, nie erzeugen, und kostet nichts.',
    });
  }

  const rang: Record<Severity, number> = { kritisch: 0, wichtig: 1, hinweis: 2 };
  return out.sort((a, b) => rang[a.severity] - rang[b.severity]);
}

/**
 * Wendet ausgewählte Vorschläge an und liefert eine NEUE Strategie.
 *
 * Pure — das Original bleibt unangetastet. Und ausdrücklich nur die
 * angehakten: Ein Prüfer, der beim Anzeigen schon schreibt, ist kein Prüfer.
 */
export function applySuggestions(strategy: Strategy, keys: readonly string[]): Strategy {
  // JSON-Runde statt structuredClone: `shared` baut ohne DOM-Typen, und die
  // Strategie ist reines JSON — keine Daten, Maps oder Zyklen.
  const next = JSON.parse(JSON.stringify(strategy)) as Strategy;
  const gewaehlt = new Set(keys);
  for (const v of adviseStrategy(strategy)) {
    if (!gewaehlt.has(v.key)) continue;
    switch (v.key) {
      case 'trailingStopPct':
        next.engine.trailingStopPct = v.suggested as number;
        break;
      case 'leverage':
      case 'leverageMomentum':
        next.broker.leverage = v.suggested as number;
        break;
      case 'maxPositionPct':
        next.engine.maxPositionPct = v.suggested as number;
        break;
      case 'maxOpenPositions':
        next.engine.maxOpenPositions = v.suggested as number;
        break;
      case 'minEdgeMultiple':
        next.signals.minEdgeMultiple = v.suggested as number;
        break;
      case 'minHoldMin':
        next.engine.minHoldMin = v.suggested as number;
        break;
      case 'stopLossPct':
        next.engine.stopLossPct = v.suggested as number;
        break;
      case 'newsVeto':
        next.signals.newsVeto = true;
        break;
      case 'timeframe':
        next.signals.timeframe = 'daily';
        break;
      default:
        break;
    }
  }
  return next;
}
