/**
 * riskPulse — der 1-Minuten-Takt für den AUSSTIEG (Owner-Wunsch 28.07.).
 *
 * ── Warum ein zweiter Takt und nicht einfach der Scan häufiger ─────────────
 *
 * Gemessen am 28.07.: Ein voller Scan wäre technisch minütlich machbar —
 * Cloud Scheduler kann `* * * * *`, Yahoo liefert 1-Minuten-Bars, und die
 * Netzwerkzeit für 40 Symbole liegt bei 1 s parallel. Der Engpass ist die
 * SCHREIBLAST: ~330 Firestore-Writes je Scan × 1440 Läufe ≈ 475 000 Writes
 * am Tag, rund 26 $/Monat — für Daten, die zu vier Fünfteln unverändert
 * wären, weil ein Indikator auf 5-min-Kerzen fünfmal denselben Wert hat.
 *
 * Die Beobachtung, die das auflöst: Eine Minute ist nur an EINER Stelle Geld
 * wert. Ein Stop-Loss, der fünf Minuten zu spät auslöst, kostet echtes Geld.
 * Ein Einstiegssignal, das fünf Minuten später kommt, kostet fast nichts —
 * die Konfluenz aus RSI, MACD und Bollinger dreht ohnehin nicht im
 * Minutentakt.
 *
 * Also: Ausstieg minütlich, Analyse weiter alle fünf Minuten.
 *
 * ── Warum das fast nichts kostet ──────────────────────────────────────────
 *
 * Der Puls holt Kurse NUR für Symbole, in denen jemand eine offene Position
 * hat — meist eine Handvoll, also ein einziger Spark-Request (~200 ms). Und
 * er SCHREIBT nur, wenn sich etwas ändert: ein neuer Höchstkurs für den
 * nachziehenden Stop, oder ein tatsächlicher Ausstieg. Ein Lauf ohne
 * Bewegung kostet ein paar Reads und sonst nichts.
 *
 * ── Warum das gefahrlos neben dem Scan läuft ──────────────────────────────
 *
 * Beide Wege benutzen dieselbe `riskExitReason` und dieselbe
 * `executePaperTrade`. Letztere läuft in einer Firestore-Transaktion und
 * liest die Position darin neu: Hat der Puls gerade verkauft, findet der
 * Scan Sekunden später keine Position mehr und führt nichts aus. Ein
 * Doppelverkauf ist damit strukturell ausgeschlossen — nicht durch Timing,
 * sondern durch die Transaktion.
 *
 * Was der Puls ausdrücklich NICHT tut: kaufen. Er kennt keine Indikatoren
 * und keine Prognose; ihm fehlt alles, was für einen Einstieg nötig wäre.
 * Diese Asymmetrie ist gewollt und dieselbe wie bei der Ausstiegs-Konfluenz:
 * Ein verpasster Einstieg kostet eine Chance, ein verpasster Ausstieg Geld.
 */

import { FieldPath, getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import {
  classify,
  isStrategy,
  liquidationPlan,
  positionValue,
  resolveRisk,
  type Position,
  type Strategy,
} from '../../../shared/src/index.js';
import { executeTrade, riskExitReason } from '../core/broker.js';
import { mayTrade } from '../core/access.js';
import { clampStrategyRisk } from '../core/rulesTrading.js';
import { getSparkBatch } from '../core/marketData.js';
import { boersenOffen, offenMitUhr } from '../core/marktUhr.js';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';

/**
 * Obergrenze der beobachteten Symbole je Puls.
 *
 * Schutz gegen den Fall, dass sehr viele Konten sehr viele verschiedene
 * Symbole halten: Der Puls soll ein billiger Wächter bleiben, kein zweiter
 * Scan. Wird er erreicht, greift weiter der 5-min-Scan für den Rest — der
 * Ausstieg ist dann langsamer, aber nie ausgesetzt.
 */
export const PULSE_MAX_SYMBOLS = 60;

/**
 * Welche Symbole der Puls abfragen muss.
 *
 * Pur gehalten, weil die Auswahl sicherheitsrelevant ist: Fällt ein Symbol
 * heraus, verliert eine offene Position ihren schnellen Ausstieg — und das
 * fällt nirgends auf, weil nichts fehlschlägt.
 *
 * Geschlossene Märkte fallen raus: Dort steht der Kurs bis zur Eröffnung,
 * ein Stop kann also nicht auslösen. Sie trotzdem abzufragen wäre bezahlte
 * Arbeit für eine garantiert unveränderte Antwort.
 */
export function pulseSymbols(
  positionSymbols: string[],
  isOpen: (symbol: string) => boolean,
  max = PULSE_MAX_SYMBOLS,
): string[] {
  const out: string[] = [];
  const gesehen = new Set<string>();
  for (const sym of positionSymbols) {
    if (!sym || gesehen.has(sym)) continue;
    gesehen.add(sym);
    if (!isOpen(sym)) continue;
    out.push(sym);
    if (out.length >= max) break;
  }
  return out;
}

export interface PulseResult {
  /** Offene Positionen insgesamt (auch in geschlossenen Märkten). */
  positions: number;
  /** Davon in einem gerade offenen Markt — nur die werden abgefragt. */
  watched: number;
  /** Tatsächlich ausgeführte Ausstiege. */
  exits: number;
  /** Fortgeschriebene Höchst-/Tiefstkurse (Basis des Trailing-Stops). */
  waterMarks: number;
  /** Konten, die unter die Nachschussgrenze gefallen sind (Hebel). */
  marginCalls: number;
  skipped?: string;
}

export async function runPulse(now = new Date()): Promise<PulseResult> {
  const db = getFirestore();

  // Ein Collection-Group-Read über alle Positionen — `select()` holt nur die
  // Doc-IDs, nicht die Felder: Der Symbol-Überblick soll billig sein, die
  // Daten kommen erst für die Konten, die wirklich betroffen sind.
  const alle = await db.collectionGroup('positions').select().get();
  // Börsen-Uhr NUR lesen (der Scan hält sie frisch): Halbtage enden für den
  // Puls damit genau dann, wenn sie beim Broker enden — nicht erst 16:00 ET.
  const uhrOffen = await boersenOffen(now.getTime());
  const symbole = pulseSymbols(
    alle.docs.map((d) => d.id),
    (sym) => offenMitUhr(sym, now, uhrOffen),
  );
  if (symbole.length === 0) {
    return { positions: alle.size, watched: 0, exits: 0, waterMarks: 0, marginCalls: 0, skipped: 'market_closed' };
  }

  const quotes = await getSparkBatch(symbole);
  if (quotes.size === 0) {
    // Lieber gar nichts tun als auf einem leeren Kursbild handeln: Ein
    // fehlender Kurs darf keinen Ausstieg auslösen, und der 5-min-Scan
    // holt es ohnehin nach.
    return {
      positions: alle.size,
      watched: symbole.length,
      exits: 0,
      waterMarks: 0,
      marginCalls: 0,
      skipped: 'keine_kurse',
    };
  }

  let exits = 0;
  let waterMarks = 0;
  let marginCalls = 0;

  const users = await db
    .collection('users')
    .where('settings.strategy.engine.running', '==', true)
    .get();

  for (const userDoc of users.docs) {
    try {
      const roh = userDoc.get('settings.strategy') as Strategy | undefined;
      if (!roh || !isStrategy(roh)) continue;
      /* Audit-Fix K-1 (13.08.): Live-Konten werden hier NICHT mehr
       * übersprungen. Der Puls macht ausschließlich Schutzarbeit — Stops,
       * Trailing, Margin-Call. Genau die stand für ein wirklich lives
       * Konto still: Die als Einstiegs-Verriegelung gedachte Zeile
       * `resolveBrokerMode(roh) !== 'paper' → continue` verriegelte auch
       * jeden Ausstieg. Einstiege kennt der Puls nicht, also gibt es hier
       * nichts zu verriegeln. Das Order-Routing der Exits prüft seine
       * Drei-Guard-Kette selbst (orderRouting.brokerVerbindung). */
      if (!mayTrade(userDoc.data())) continue;
      const clamped = clampStrategyRisk(structuredClone(roh));

      const posSnap = await userDoc.ref.collection('positions').get();

      // ── Nachschussgrenze (Hebel, Owner-Wunsch 28.07.) ─────────────────
      //
      // Zuerst, vor allen Einzel-Stops: Wenn das Eigenkapital unter die
      // Erhaltungsmarge gefallen ist, entscheidet nicht mehr der Stop des
      // einzelnen Titels, sondern das Konto als Ganzes. Genau diese Prüfung
      // fehlt in selbstgebauten Hebel-Simulationen, und ohne sie sehen die
      // Ergebnisse systematisch zu gut aus (margin.ts, Modul-Kopf).
      //
      // Ein bar geführtes Konto kann hier nie hängen bleiben: Ohne Kredit
      // ist der Cash ≥ 0, das Eigenkapital also mindestens so groß wie der
      // Positionswert — die Marge liegt bei ≥ 100 %.
      const cash = (userDoc.get('wallet.paperBalance') as number | undefined) ?? 0;
      const zwangsschluss = new Set(
        liquidationPlan(
          posSnap.docs.map((d) => {
            const p = d.data() as Position;
            // Fehlt der Kurs (geschlossener Markt), zählt der Einstand. Das
            // ist die vorsichtigere Annahme: Eine Position, deren Verlust
            // wir nicht sehen, löst keinen Zwangsverkauf aus, den wir nicht
            // begründen können.
            const preis = quotes.get(p.symbol)?.price ?? p.avgEntry;
            return {
              symbol: p.symbol,
              value: positionValue(p, preis),
              exposure: Math.abs(p.qty * preis),
            };
          }),
          cash,
        ),
      );
      if (zwangsschluss.size > 0) {
        marginCalls += 1;
        logger.warn(
          `Margin-Call ${userDoc.id}: ${zwangsschluss.size} Position(en) werden zwangsweise geschlossen`,
        );
      }

      for (const doc of posSnap.docs) {
        const pos = doc.data() as Position;
        const quote = quotes.get(pos.symbol);
        // Ohne Kurs kein Verkauf — auch nicht beim Margin-Call. Der Puls
        // versucht es in der nächsten Minute erneut und spätestens zur
        // Eröffnung des betroffenen Marktes geht die Position zu. Auf einem
        // Kurs von gestern zwangszuschließen wäre schlimmer als warten.
        if (!quote || !(quote.price > 0)) continue;
        const preis = quote.price;
        const cls = classify(pos.symbol);
        const isShort = pos.side === 'short';

        // Höchst-/Tiefstkurs VOR der Prüfung fortschreiben — der
        // nachziehende Stop misst gegen genau diesen Wert. Täte der Puls
        // das nicht, rechnete er mit einem Stand von bis zu fünf Minuten
        // vorher und zöge den Stop zu spät nach; der schnellere Takt wäre
        // dann für den Trailing-Stop wertlos.
        if (isShort) {
          const tief = Math.min(pos.lowWater ?? pos.avgEntry, preis);
          if (tief < (pos.lowWater ?? Infinity) - 1e-9) {
            pos.lowWater = tief;
            await doc.ref.set({ lowWater: tief }, { merge: true }).catch(() => undefined);
            waterMarks += 1;
          }
        } else {
          const hoch = Math.max(pos.highWater ?? pos.avgEntry, preis);
          if (hoch > (pos.highWater ?? 0) + 1e-9) {
            pos.highWater = hoch;
            await doc.ref.set({ highWater: hoch }, { merge: true }).catch(() => undefined);
            waterMarks += 1;
          }
        }

        // ATR bewusst NICHT übergeben: Der Puls holt keine Bars, und ein
        // erfundener Wert würde den volatilitätsadaptiven Stop verfälschen.
        // Ohne ihn fällt `riskExitReason` auf die Prozent-Marken zurück —
        // der ATR-Stop bleibt Sache des 5-min-Scans.
        // Der Margin-Call sticht jeden Stop: Er fragt nicht, wie diese eine
        // Position steht, sondern ob das Konto sie sich noch leisten kann.
        //
        // Im Momentum-Modus ist er das EINZIGE, was hier greift. Diese
        // Strategie hält bewusst ohne Stops durch Rücksetzer hindurch — ein
        // Prozent-Stop würde sie an genau den Bewegungen ausstoppen, über
        // die hinweg sie ihre Rendite verdient. Der Margin-Call bleibt, weil
        // er keine Strategie-Entscheidung ist, sondern eine Solvenzgrenze.
        const reason = zwangsschluss.has(pos.symbol)
          ? 'margin_call'
          : clamped.engine.mode === 'momentum'
            ? null
            : riskExitReason(pos, preis, {
                risk: resolveRisk(clamped.engine, cls),
                now,
              });
        if (!reason) continue;

        const r = await executeTrade(
          {
            uid: userDoc.id,
            symbol: pos.symbol,
            side: isShort ? 'buy' : 'sell',
            price: preis,
            source: 'engine',
            riskExit: reason,
            assetClass: cls,
          },
          clamped,
          // Lauf-Kennung des Pulses (M13): Minutengenau, damit ein
          // wiederholter Puls derselben Minute beim Broker als DIESELBE
          // Order ankommt und abgewiesen wird — statt ein zweites Mal
          // dieselbe Position glattzustellen.
          `puls-${now.toISOString().slice(0, 16)}Z`,
        );
        if (r.executed) {
          exits += 1;
          // Kauf-Pause setzen wie im Scan — sonst könnte der nächste
          // 5-min-Scan das eben ausgestoppte Symbol sofort zurückkaufen.
          // FELDWEISE, damit der parallel laufende Scan diesen Eintrag nicht
          // beim Zurückschreiben seiner eigenen Map überbügelt.
          await (userDoc.ref.update as (...a: unknown[]) => Promise<unknown>)(
            new FieldPath('engineCooldowns', pos.symbol),
            now.toISOString(),
          ).catch(() => undefined);
          logger.info(`Puls-Exit ${userDoc.id} ${pos.symbol} (${reason}${isShort ? ', short' : ''})`);
        }
      }
    } catch (err) {
      logger.warn(`riskPulse: User ${userDoc.id} übersprungen`, err);
    }
  }

  // Heartbeat nur, wenn tatsächlich etwas passiert ist — ein Schreibvorgang
  // je Minute wäre 1440 am Tag für die Information „nichts passiert".
  if (exits > 0 || waterMarks > 0) {
    await db
      .doc('meta/health')
      .set(
        { pulse: { at: now.toISOString(), watched: symbole.length, exits, waterMarks, marginCalls } },
        { merge: true },
      )
      .catch(() => undefined);
  }

  return { positions: alle.size, watched: symbole.length, exits, waterMarks, marginCalls };
}

/** Jede Minute — der schnelle Wächter über offene Positionen.
 *  256 MiB genügen: keine Bars, keine Indikatoren, keine Prognose. */
export const riskPulse = onSchedule(
  {
    schedule: '* * * * *',
    timeZone: 'America/New_York',
    memory: '256MiB',
    timeoutSeconds: 55, // kürzer als der Takt: Läufe dürfen sich nie stapeln
    retryCount: 0, // ein verpasster Puls ist in 60 s ohnehin wieder da
  },
  async () => {
    const res = await runPulse();
    logger.info(
      `Puls: ${res.watched}/${res.positions} beobachtet, ${res.exits} Ausstieg(e)${
        res.marginCalls > 0 ? `, ${res.marginCalls} Margin-Call(s)` : ''
      }${res.skipped ? ` — übersprungen (${res.skipped})` : ''}`,
    );
  },
);

/** Manueller Anstoß — nur im Emulator, wie die übrigen *Now-Endpunkte. */
export const pulseNow = onRequest(EMULATOR_TRIGGER_OPTS, async (_req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(403).json({ error: 'pulseNow ist nur im Emulator verfügbar' });
    return;
  }
  res.status(200).json(await runPulse());
});
