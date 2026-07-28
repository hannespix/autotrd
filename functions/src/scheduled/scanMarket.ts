/**
 * scanMarket — der zentrale Marktdaten-Scan (MILESTONES M2).
 *
 * Läuft alle 5 min via Cloud Scheduler, respektiert den US-Marktzeiten-Gate
 * (Port von reference/deploy/run_scan.sh: Mo–Fr 09:30–16:00 ET) und schreibt
 * geteilte Daten idempotent nach market/{symbol}/** — einmal für ALLE User
 * (ARCHITECTURE §2). Doc-IDs sind fachliche Schlüssel (Datum, Scan-Minute).
 *
 * Schreibdisziplin: Bars werden beim ersten Scan eines Symbols backgefüllt
 * (Marker `barsBackfilledAt` am Symbol-Doc), danach nur noch der letzte Bar
 * pro Scan — sonst wären es ~70 Writes je Symbol alle 5 Minuten.
 */

import { FieldPath, FieldValue, getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import {
  CATALOG,
  CLASS_LABELS,
  DEFAULT_STRATEGY,
  allSymbols,
  classify,
  isStrategy,
  marketOpenForClass,
  resolveName,
  resolveRisk,
  type Position,
  type Strategy,
  type StrategyDoc,
} from '../../../shared/src/index.js';
import { atrPct, buildVariants } from '../../../shared/src/index.js';
import { EMULATOR_TRIGGER_OPTS } from '../core/appcheck.js';
import { computeIndicatorSnapshot, computeSignal } from '../core/engine.js';
import { executePaperTrade, resolveBrokerMode, riskExitReason } from '../core/broker.js';
import { mayTrade } from '../core/access.js';
import {
  RISK_LIMITS,
  applyPredictionVote,
  buildRuleContext,
  clampStrategyRisk,
  cooldownActive,
  decideTree,
  minHoldActive,
  minuteOfDayEt,
  predictionVote,
  shadowEquity,
  shadowTrade,
  type ShadowBook,
} from '../core/rulesTrading.js';
import { accuracyWeightedVote } from '../../../shared/src/index.js';
import { runForecast, runIntradayForecast, type LiveForecast } from '../core/forecaster.js';
import { evaluateIntradayDue } from './evalForecasts.js';
import { stepFleet, type FleetState } from '../core/tuneFleet.js';
import { FLEET_SIZE } from './autoTune.js';
import {
  chunkBarsByYear,
  getDeepDailyBars,
  getIntradayBars,
  getMarketSnapshot,
  getQuickQuote,
  getSparkBatch,
  type SparkQuote,
} from '../core/marketData.js';

/** Mo–Fr, 09:30 ≤ t < 16:00 in America/New_York (Port des run_scan.sh-Gates). */
export function isUsMarketOpen(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const hm = parseInt(get('hour'), 10) * 100 + parseInt(get('minute'), 10);
  return hm >= 930 && hm < 1600;
}

/** meta/universe einmalig seeden (Katalog als Array-of-Maps — Firestore
 *  erlaubt keine verschachtelten Arrays). Idempotent. */
async function seedUniverse(): Promise<void> {
  const db = getFirestore();
  const ref = db.doc('meta/universe');
  if ((await ref.get()).exists) return;
  const classes: Record<string, unknown> = {};
  for (const [cls, groups] of Object.entries(CATALOG)) {
    classes[cls] = {
      label: CLASS_LABELS[cls] ?? cls,
      groups: Object.fromEntries(
        Object.entries(groups).map(([g, entries]) => [
          g,
          entries.map(([symbol, name]) => ({ symbol, name })),
        ]),
      ),
    };
  }
  await ref.set({ classes, seededAt: new Date().toISOString() });
  logger.info('meta/universe geseedet');
}

export interface ScanResult {
  scanId: string;
  scanned: string[];
  errors: Record<string, string>;
  trades: number;
  skipped?: string;
}

/** In-Memory-Marktbild eines Scans: 1 Fetch pro Symbol, N User-Auswertungen. */
interface SymbolData {
  closes: number[];
  price: number;
  forecast: LiveForecast | null;
  /** ATR(14) in Prozent des Kurses — Basis volatilitätsadaptiver Stops (MA6). */
  atrPct?: number | null;
  /** 5-min-Closes (~5 Handelstage) — Signal-Basis im 'intraday'-Zeitrahmen
   *  (Owner 26.07.: „Tradefrequenz deutlich erhöhen"). */
  closes5m?: number[];
  /** Kurzfrist-Prognose (nächste Stunde) in % — Forecast-Stimme im
   *  'intraday'-Zeitrahmen (die Tages-Prognose passt dort nicht). */
  intradayPct?: number | null;
}

/** Signal-Quelle je Zeitrahmen: 5-min-Closes, wenn gewünscht UND vorhanden
 *  (mind. ~35 Bars für RSI/MACD-Anlauf), sonst Tages-Closes als Fallback. */
export function signalCloses(data: SymbolData, timeframe: 'daily' | 'intraday'): number[] {
  if (timeframe === 'intraday' && (data.closes5m?.length ?? 0) >= 35) return data.closes5m!;
  return data.closes;
}

/**
 * Auto-Trading pro User (MILESTONES M4): Für jeden User mit
 * `settings.strategy.engine.running === true` werden die Signale gegen SEINE
 * Strategie-Parameter neu ausgewertet (Indikator-Mathe in-memory, keine
 * weiteren Fetches) und Paper-Trades transaktional ausgeführt; danach
 * Stop-Loss/Take-Profit über die offenen Positionen.
 */
async function executeUserTrades(marketData: Map<string, SymbolData>): Promise<number> {
  const db = getFirestore();
  let executed = 0;
  const users = await db
    .collection('users')
    .where('settings.strategy.engine.running', '==', true)
    .get();

  // Beweislast-Umkehr (Owner-Direktive 28.07.): Das Stimmgewicht der Prognose
  // hängt an ihrer REALISIERTEN Trefferquote — einmal je Scan gelesen, für
  // alle User angewandt. Der User konfiguriert das Basisgewicht; ob die
  // Prognose es führen darf, entscheidet die Evidenz. Je Zeitbasis die
  // passende Statistik: 5-min-Signale werden von der Kurzfrist-Prognose
  // gestimmt, Tages-Signale von der Tages-Prognose — die Trefferquote der
  // einen sagt nichts über die andere.
  type FcStats = { scored?: number | undefined; dirAccuracy?: number | null | undefined } | null;
  let fcDaily: FcStats = null;
  let fcIntraday: FcStats = null;
  try {
    const [d, i] = await Promise.all([
      db.doc('meta/forecastStats').get(),
      db.doc('meta/forecastStatsIntraday').get(),
    ]);
    fcDaily = {
      scored: d.get('scored') as number | undefined,
      dirAccuracy: d.get('dirAccuracy') as number | null | undefined,
    };
    fcIntraday = {
      scored: i.get('scored') as number | undefined,
      dirAccuracy: i.get('dirAccuracy') as number | null | undefined,
    };
  } catch {
    // nicht lesbar = keine Evidenz — accuracyWeightedVote(null) ⇒ Stimme 0
  }

  for (const userDoc of users.docs) {
    const uid = userDoc.id;
    const strategy = userDoc.get('settings.strategy') as Strategy | undefined;
    if (!strategy || !isStrategy(strategy)) continue;
    if (resolveBrokerMode(strategy) !== 'paper') continue; // Live bleibt verriegelt (M14)
    // Gate VOR der Risiko-Klammer, damit beide Pfade (Signal + Ausführung)
    // dasselbe gedeckelte Gewicht sehen.
    strategy.signals = {
      ...strategy.signals,
      forecastWeight: accuracyWeightedVote(
        strategy.signals.forecastWeight,
        (strategy.signals.timeframe ?? 'intraday') === 'intraday' ? fcIntraday : fcDaily,
      ).weight,
    };
    // Zugangsstufe (Owner 26.07.): Nicht freigeschaltete Konten dürfen den
    // Schalter zwar umlegen — gehandelt wird für sie trotzdem nicht. Die
    // Prüfung sitzt hier und nicht in der Query, weil ein fehlendes Feld
    // (Bestandskonto) als freigeschaltet gilt und Firestore darauf nicht
    // filtern kann.
    if (!mayTrade(userDoc.data())) continue;

    try {
      const positionsSnap = await userDoc.ref.collection('positions').get();
      const positions = new Map<string, Position>(
        positionsSnap.docs.map((d) => [d.id, d.data() as Position]),
      );
      // Risiko-Hülle GILT FÜR JEDEN TRADE dieses Users (Engine-Audit 26.07.):
      // Sie stand bisher erst weiter unten und deckte nur den Regelbaum-Pfad —
      // der Classic-Pfad kaufte mit ungeklammertem maxPositionPct, für den das
      // Schema kein Obergrenze kennt (100 % Einsatz wäre durchgegangen).
      const clamped = clampStrategyRisk(strategy);
      const now = new Date();
      // Zeitbasis der Signale (Owner 26.07., „Tradefrequenz erhöhen"):
      // 'intraday' rechnet auf 5-min-Kerzen — Signale drehen im Scan-Takt.
      const tf: 'daily' | 'intraday' = strategy.signals.timeframe ?? 'intraday';
      const cdMin = clamped.engine.cooldownMin ?? 15;

      // Entry-Cooldown nach Risk-Exits (MA3-Fund 26.07.): Ohne ihn kauft die
      // Konfluenz ein per Stop-Loss verkauftes Symbol im selben/nächsten Scan
      // sofort zurück — Stop-Loss feuert in fallenden Märkten, in denen RSI/
      // Bollinger „überverkauft = kaufen" rufen (Whipsaw); nach Take-Profit
      // wäre es eine Gebühren-Schleife. Persistiert am User-Doc, damit der
      // Cooldown Scans überlebt; Einträge > 1 Tag werden weggeräumt.
      //
      // Geschrieben wird FELDWEISE, nicht als ganze Map. Der Grund kam mit
      // dem 1-Minuten-Puls (28.07.): Der setzt ebenfalls Cooldowns, und ein
      // `update({ engineCooldowns })` hätte dessen Eintrag zwischen Lesen
      // und Schreiben dieses Scans einfach überschrieben — der Scan hätte
      // dann ein Symbol zurückgekauft, das der Puls Sekunden zuvor
      // ausgestoppt hat. Genau der Whipsaw, gegen den der Cooldown da ist.
      // Feldweise Updates sind reihenfolgeunabhängig; Abgelaufenes wird
      // explizit gelöscht statt durch Weglassen (Weglassen entfernt bei
      // merge nichts).
      const engineCooldowns: Record<string, string> = {
        ...((userDoc.get('engineCooldowns') as Record<string, string> | undefined) ?? {}),
      };
      const cooldownUpdates: unknown[] = [];
      for (const [sym, at] of Object.entries(engineCooldowns)) {
        if (!Number.isFinite(Date.parse(at)) || now.getTime() - Date.parse(at) > 86_400_000) {
          delete engineCooldowns[sym];
          cooldownUpdates.push(new FieldPath('engineCooldowns', sym), FieldValue.delete());
        }
      }

      // 1) Risiko-Exits zuerst (Port von _check_risk — vor neuen Signalen).
      // Seit MA2/MA6: klassen-aufgelöste Parameter, ATR-Option, nachziehender
      // Stop (dafür wird highWater bei jedem Scan fortgeschrieben) und
      // Zeitgrenze — alles in riskExitReason gebündelt.
      for (const [symbol, pos] of positions) {
        const data = marketData.get(symbol);
        if (!data) continue;
        const cls = classify(symbol);
        const isShort = pos.side === 'short';
        if (isShort) {
          // Tiefstkurs seit Short-Einstieg mitziehen (Basis des Short-Trailings)
          const trough = Math.min(pos.lowWater ?? pos.avgEntry, data.price);
          if (trough < (pos.lowWater ?? Infinity) - 1e-9) {
            pos.lowWater = trough;
            await userDoc.ref
              .collection('positions')
              .doc(symbol)
              .set({ lowWater: trough }, { merge: true })
              .catch(() => undefined);
          }
        } else {
          // Höchstkurs seit Einstieg mitziehen, BEVOR der Trailing-Stop prüft
          const peak = Math.max(pos.highWater ?? pos.avgEntry, data.price);
          if (peak > (pos.highWater ?? 0) + 1e-9) {
            pos.highWater = peak;
            await userDoc.ref
              .collection('positions')
              .doc(symbol)
              .set({ highWater: peak }, { merge: true })
              .catch(() => undefined);
          }
        }
        const reason = riskExitReason(pos, data.price, {
          risk: resolveRisk(clamped.engine, cls),
          atrPct: data.atrPct,
          now,
        });
        if (reason) {
          // Long schließt per Verkauf, Short per Eindecken (buy/Cover)
          const r = await executePaperTrade(
            { uid, symbol, side: isShort ? 'buy' : 'sell', price: data.price, source: 'engine', riskExit: reason, assetClass: cls },
            clamped,
          );
          if (r.executed) {
            executed += 1;
            positions.delete(symbol);
            engineCooldowns[symbol] = now.toISOString();
            cooldownUpdates.push(
              new FieldPath('engineCooldowns', symbol),
              now.toISOString(),
            );
            logger.info(`Risk-Exit ${uid} ${symbol} (${reason}${isShort ? ', short' : ''})`);
          }
        }
      }

      // 2) Regelbaum-Strategien (M10): publizierte Strategien mit Zuordnung
      // handeln ihre Symbole SELBST — der Classic-Pfad überspringt sie.
      // User-Prognosen (Chart-Pfeile): Opt-in übers Options-Modal (Feedback
      // 25.07.) — ohne settings.ui.predArrow === true zählt KEINE Prognose,
      // gespeicherte Pfeile bleiben aber erhalten (Reaktivierung möglich).
      const predArrowOn = userDoc.get('settings.ui.predArrow') === true;
      const predSnap = predArrowOn ? await userDoc.ref.collection('predictions').get() : null;
      const predictions = new Map(
        (predSnap?.docs ?? []).map((d) => [d.id, d.data() as import('../../../shared/src/index.js').UserPrediction]),
      );
      const todayIso = new Date().toISOString();

      const stratSnap = await userDoc.ref
        .collection('strategies')
        .where('status', '==', 'published')
        .get();
      const published = stratSnap.docs
        .map((d) => ({ ref: d.ref, doc: d.data() as StrategyDoc & { lastTrades?: Record<string, string> } }))
        .filter((s) => s.doc.compiled && (s.doc.symbols ?? []).length > 0);
      // Nur PAPER-Strategien besitzen ihre Symbole exklusiv — Shadow
      // beobachtet parallel (A/B) und blockt den Classic-Pfad nicht.
      const strategyOwned = new Set(
        published.filter((s) => (s.doc.mode ?? 'paper') === 'paper').flatMap((s) => s.doc.symbols),
      );
      const minuteEt = minuteOfDayEt(now);

      for (const { ref, doc } of published) {
        const isShadow = (doc.mode ?? 'paper') === 'shadow';
        // Shadow-Konto lokal führen; geschrieben wird EINMAL nach der Schleife
        let book: ShadowBook | null =
          isShadow && doc.shadow
            ? { balance: doc.shadow.balance, positions: { ...doc.shadow.positions } }
            : null;
        let bookChanged = false;
        const lastDirs: Record<string, 'buy' | 'sell' | 'hold'> = { ...(doc.lastDirs ?? {}) };
        let dirsChanged = false;

        for (const symbol of doc.symbols) {
          const data = marketData.get(symbol);
          if (!data) continue; // Klasse geschlossen oder Symbol nicht im Scan
          const pos = positions.get(symbol) ?? null;
          // Regelbaum rechnet auf derselben Zeitbasis wie die Konfluenz
          const closes = signalCloses(data, tf);
          const snapshot = computeIndicatorSnapshot(closes, data.price, strategy.indicators);
          const prevCloses = closes.slice(0, -1);
          const prevPrice = prevCloses[prevCloses.length - 1] ?? null;
          const ctx = buildRuleContext({
            price: data.price,
            snapshot,
            prevSnapshot:
              prevPrice !== null && prevCloses.length > 1
                ? computeIndicatorSnapshot(prevCloses, prevPrice, strategy.indicators)
                : null,
            prevPrice,
            closes,
            minuteOfDayEt: minuteEt,
            forecastPct: tf === 'intraday' ? (data.intradayPct ?? null) : (data.forecast?.predictedPct ?? null),
            position: pos
              ? {
                  open: true,
                  // Shorts verdienen am fallenden Kurs — unrealizedPct gespiegelt
                  unrealizedPct:
                    ((pos.side === 'short' ? pos.avgEntry - data.price : data.price - pos.avgEntry) / pos.avgEntry) * 100,
                }
              : { open: false },
          });
          const dir = decideTree(doc.compiled!, ctx);

          if (isShadow) {
            // shadowSignals NUR beim Entscheidungs-Wechsel (M11)
            if (dir !== (lastDirs[symbol] ?? 'hold')) {
              lastDirs[symbol] = dir;
              dirsChanged = true;
              if (dir !== 'hold') {
                await ref
                  .collection('shadowSignals')
                  .doc(`${new Date().toISOString().slice(0, 16)}Z_${symbol}`)
                  .set({ symbol, direction: dir, price: data.price, at: new Date().toISOString() });
              }
            }
            if (book) {
              // Duell-Fairness (MA4-Fund 26.07.): Das Shadow-Buch lebt unter
              // DENSELBEN Risiko-Regeln wie das echte Paper-Konto — vorher
              // kannte es weder Stop/Trailing/Zeitgrenze noch die Sizing-
              // Basis; Kennzahlen-Duell und „Befördern" verglichen Äpfel mit
              // Birnen. highWater wird wie beim echten Konto je Scan
              // fortgeschrieben, dann prüfen dieselben riskExitReason-Regeln.
              const sPos = book.positions[symbol];
              if (sPos) {
                const sShort = sPos.side === 'short';
                if (sShort) {
                  // Tiefstkurs fortschreiben (Short-Trailing, Parität R2)
                  const trough = Math.min(sPos.lowWater ?? sPos.avgEntry, data.price);
                  if (trough < (sPos.lowWater ?? Infinity) - 1e-9) {
                    book.positions[symbol] = { ...sPos, lowWater: trough };
                    bookChanged = true;
                  }
                } else {
                  const peak = Math.max(sPos.highWater ?? sPos.avgEntry, data.price);
                  if (peak > (sPos.highWater ?? 0) + 1e-9) {
                    book.positions[symbol] = { ...sPos, highWater: peak };
                    bookChanged = true;
                  }
                }
                const cls = classify(symbol);
                const reason = riskExitReason(
                  {
                    symbol,
                    qty: sPos.qty,
                    avgEntry: sPos.avgEntry,
                    stopLoss: null,
                    takeProfit: null,
                    openedAt: sPos.openedAt ?? now.toISOString(),
                    ...(sShort
                      ? { side: 'short' as const, lowWater: Math.min(sPos.lowWater ?? sPos.avgEntry, data.price) }
                      : { highWater: Math.max(sPos.highWater ?? sPos.avgEntry, data.price) }),
                  },
                  data.price,
                  { risk: resolveRisk(clamped.engine, cls), atrPct: data.atrPct, now },
                );
                if (reason) {
                  // Long schließt per Verkauf, Short per Eindecken (Parität)
                  const r = shadowTrade(book, symbol, sShort ? 'buy' : 'sell', data.price, clamped.engine.maxPositionPct);
                  if (r.executed) {
                    book = r.book;
                    bookChanged = true;
                    await ref.set({ lastTrades: { [symbol]: now.toISOString() } }, { merge: true });
                    await ref
                      .collection('shadowSignals')
                      .doc(`${now.toISOString().slice(0, 16)}Z_${symbol}_risk`)
                      .set({ symbol, direction: sShort ? 'buy' : 'sell', riskExit: reason, price: data.price, at: now.toISOString() });
                    continue; // Position ist zu — Baum-Entscheidung dieses Scans ist erledigt
                  }
                }
              }
              // Virtuelles Konto — Risiko-Hülle wie beim echten Handel
              const sizingCapital = (): number =>
                (clamped.broker.sizingBase ?? 'balance') === 'initial'
                  ? clamped.broker.initialCapital
                  : book!.balance;
              if (dir === 'buy' && book.positions[symbol]?.side === 'short') {
                // Kauf-Signal deckt den Shadow-Short ein (Cover)
                const r = shadowTrade(book, symbol, 'buy', data.price, clamped.engine.maxPositionPct);
                if (r.executed) {
                  book = r.book;
                  bookChanged = true;
                  await ref.set({ lastTrades: { [symbol]: now.toISOString() } }, { merge: true });
                }
              } else if (dir === 'buy' && !book.positions[symbol]) {
                if (Object.keys(book.positions).length >= RISK_LIMITS.maxOpenPositions) continue;
                if (cooldownActive(doc.lastTrades?.[symbol], now, cdMin)) continue;
                // Sizing-Parität (MA4): gleiche Basis wie der echte Broker —
                // Cash (Default) oder Startkapital, Deckung prüft der Cash.
                const r = shadowTrade(book, symbol, 'buy', data.price, clamped.engine.maxPositionPct, {
                  capital: sizingCapital(),
                  now,
                  fractional: classify(symbol) === 'crypto',
                });
                if (r.executed) {
                  book = r.book;
                  bookChanged = true;
                  // Cooldown-Parität: Auch Shadow-Entries stempeln lastTrades —
                  // vorher schrieb nur der Paper-Pfad und der Shadow-Cooldown
                  // war wirkungslos (Shadow durfte im 5-min-Takt handeln).
                  await ref.set({ lastTrades: { [symbol]: now.toISOString() } }, { merge: true });
                }
              } else if (dir === 'sell' && book.positions[symbol] && book.positions[symbol]?.side !== 'short') {
                const r = shadowTrade(book, symbol, 'sell', data.price, clamped.engine.maxPositionPct);
                if (r.executed) {
                  book = r.book;
                  bookChanged = true;
                  await ref.set({ lastTrades: { [symbol]: now.toISOString() } }, { merge: true });
                }
              } else if (dir === 'sell' && !book.positions[symbol] && strategy.signals.allowShort === true) {
                // Shadow-Short (R2): gleiche Entry-Guards wie der echte Pfad
                if (Object.keys(book.positions).length >= RISK_LIMITS.maxOpenPositions) continue;
                if (cooldownActive(doc.lastTrades?.[symbol], now, cdMin)) continue;
                const r = shadowTrade(book, symbol, 'sell', data.price, clamped.engine.maxPositionPct, {
                  capital: sizingCapital(),
                  now,
                  fractional: classify(symbol) === 'crypto',
                  openShort: true,
                });
                if (r.executed) {
                  book = r.book;
                  bookChanged = true;
                  await ref.set({ lastTrades: { [symbol]: now.toISOString() } }, { merge: true });
                }
              }
            }
            continue; // Shadow berührt NIE das echte Wallet
          }

          if (dir === 'buy' && pos?.side === 'short') {
            // Kauf-Signal deckt den Regelbaum-Short ein (Cover, Short R2);
            // Exits blockt der Cooldown NIE (Sicherheitsprinzip)
            const r = await executePaperTrade(
              { uid, symbol, side: 'buy', price: data.price, source: 'engine', assetClass: classify(symbol) },
              clamped,
            );
            if (r.executed) {
              executed += 1;
              positions.delete(symbol);
              await ref.set({ lastTrades: { [symbol]: now.toISOString() } }, { merge: true });
              logger.info(`Strategie-Cover ${uid} ${symbol} („${doc.name}") @ ${data.price}`);
            }
          } else if (dir === 'buy' && !pos) {
            // Entry-Guards der Risiko-Hülle: Positionslimit + Cooldowns
            // (je Strategie UND nach Risk-Exits desselben Wallets)
            if (positions.size >= RISK_LIMITS.maxOpenPositions) continue;
            if (cooldownActive(doc.lastTrades?.[symbol], now, cdMin)) continue;
            if (cooldownActive(engineCooldowns[symbol], now, cdMin)) continue;
            // assetClass durchreichen (MA3-Fund 26.07.): Ohne sie schrieb der
            // Broker die Stop/Take-LEVEL mit den GLOBALEN Prozenten fest —
            // die MA6-Klassen-Profile (Krypto 6/10 usw.) griffen beim Kauf
            // nie, und gespeicherte Level haben bewusst Vorrang (MA1).
            const r = await executePaperTrade(
              { uid, symbol, side: 'buy', price: data.price, source: 'engine', assetClass: classify(symbol) },
              clamped,
            );
            if (r.executed) {
              executed += 1;
              // lokaler Marker fürs Positionslimit/Dedup in diesem Scan
              positions.set(symbol, {
                symbol,
                qty: r.trade?.qty ?? 0,
                avgEntry: r.trade?.price ?? data.price,
                stopLoss: null,
                takeProfit: null,
                openedAt: now.toISOString(),
              });
              await ref.set({ lastTrades: { [symbol]: now.toISOString() } }, { merge: true });
              logger.info(`Strategie-Buy ${uid} ${symbol} („${doc.name}") @ ${data.price}`);
            }
          } else if (dir === 'sell' && pos && pos.side !== 'short') {
            // Exits blockt der Cooldown NIE (Sicherheitsprinzip) — die
            // Mindest-Haltedauer bremst dagegen sehr wohl, weil sie nur den
            // SIGNAL-Ausstieg betrifft. Stop/Trailing/Take sind in diesem
            // Scan bereits gelaufen und bleiben jederzeit scharf.
            if (minHoldActive(pos.openedAt, now, clamped.engine.minHoldMin ?? 0)) continue;
            const r = await executePaperTrade(
              { uid, symbol, side: 'sell', price: data.price, source: 'engine', assetClass: classify(symbol) },
              clamped,
            );
            if (r.executed) {
              executed += 1;
              positions.delete(symbol);
              await ref.set({ lastTrades: { [symbol]: now.toISOString() } }, { merge: true });
              logger.info(`Strategie-Sell ${uid} ${symbol} („${doc.name}") @ ${data.price}`);
            }
          } else if (dir === 'sell' && !pos && strategy.signals.allowShort === true) {
            // Regelbaum-Short (R2): Verkaufs-Signal ohne Position — gleiche
            // Entry-Guards wie beim Kauf, Level gespiegelt im Broker.
            if (positions.size >= RISK_LIMITS.maxOpenPositions) continue;
            if (cooldownActive(doc.lastTrades?.[symbol], now, cdMin)) continue;
            if (cooldownActive(engineCooldowns[symbol], now, cdMin)) continue;
            const r = await executePaperTrade(
              { uid, symbol, side: 'sell', price: data.price, source: 'engine', assetClass: classify(symbol), openShort: true },
              clamped,
            );
            if (r.executed) {
              executed += 1;
              positions.set(symbol, {
                symbol,
                qty: r.trade?.qty ?? 0,
                avgEntry: r.trade?.price ?? data.price,
                side: 'short',
                stopLoss: null,
                takeProfit: null,
                openedAt: now.toISOString(),
              });
              await ref.set({ lastTrades: { [symbol]: now.toISOString() } }, { merge: true });
              logger.info(`Strategie-Short ${uid} ${symbol} („${doc.name}") @ ${data.price}`);
            }
          }
        }

        if (bookChanged || dirsChanged) {
          const prices = new Map<string, number>();
          for (const sym of doc.symbols) {
            const d = marketData.get(sym);
            if (d) prices.set(sym, d.price);
          }
          const patch: Record<string, unknown> = { updatedAt: now.toISOString() };
          if (dirsChanged) patch.lastDirs = lastDirs;
          if (book && bookChanged) {
            patch.shadow = {
              ...doc.shadow,
              balance: Math.round(book.balance * 100) / 100,
              positions: book.positions,
              equity: shadowEquity(book, prices),
              updatedAt: now.toISOString(),
            };
          }
          await ref.set(patch, { merge: true });
        }
      }

      // 3) Konfluenz-Signale gegen die User-Strategie (inkl. Forecast-Vote);
      // Symbole mit zugeordneter publizierter Strategie gehören dieser (oben).
      //
      // Gehandelt wird ALLES, was der Scan geladen hat — nicht mehr die
      // handverlesene Watchlist (Owner-Frage 28.07.). Das Scan-Set kommt
      // aus dem Momentum-Ranking über den ganzen Katalog plus den offenen
      // Positionen; wer es zusätzlich auf eine Watchlist einschränkte,
      // schöbe eine unbegründete Vorauswahl vor eine begründete.
      for (const symbol of marketData.keys()) {
        if (strategyOwned.has(symbol)) continue;
        const data = marketData.get(symbol);
        if (!data) continue;
        // Positionskontext entscheidet über Ein- oder Ausstiegs-Regeln:
        // Der Ausstieg ist bewusst leichter (MA2) — ein verpasster Verkauf
        // kostet Geld, ein verpasster Kauf nur eine Chance.
        // Zeitbasis 'intraday': 5-min-Kerzen + Kurzfrist-Prognose als
        // Forecast-Stimme (die Tages-Prognose passt nicht zum 5-min-Signal).
        const pos = positions.get(symbol) ?? null;
        const sig = computeSignal(
          signalCloses(data, tf),
          data.price,
          strategy.indicators,
          strategy.signals,
          tf === 'intraday'
            ? (data.intradayPct != null ? { predictedPct: data.intradayPct } : null)
            : data.forecast,
          { hasPosition: pos !== null, ...(pos?.side === 'short' ? { positionSide: 'short' as const } : {}) },
        );
        // Prognose-Pfeil des Users als zusätzliche gewichtete Stimme
        const direction = applyPredictionVote(
          sig,
          predictionVote(predictions.get(symbol), data.price, todayIso),
        );
        const allowShort = strategy.signals.allowShort === true;
        // Ausführung IMMER mit der geklammerten Strategie (Audit 26.07.):
        // Positionsgröße und Stop-Level kommen aus der Risiko-Hülle.
        if (direction === 'buy' && pos?.side === 'short') {
          // Kauf-Signal auf offenen Short = Eindecken (Cover)
          const r = await executePaperTrade(
            { uid, symbol, side: 'buy', price: data.price, source: 'engine', assetClass: classify(symbol) },
            clamped,
          );
          if (r.executed) {
            executed += 1;
            positions.delete(symbol);
            logger.info(`Engine-Cover ${uid} ${symbol} @ ${data.price}`);
          }
        } else if (direction === 'buy' && !pos) {
          // Entry-Guards auch im Classic-Pfad (MA3-Fund 26.07.): Das
          // Positionslimit galt vorher nur für Regelbaum-Käufe — die
          // Konfluenz konnte beliebig viele Positionen öffnen. Und nach
          // einem Risk-Exit hält der Cooldown den Sofort-Rückkauf auf.
          if (positions.size >= RISK_LIMITS.maxOpenPositions) continue;
          if (cooldownActive(engineCooldowns[symbol], now, cdMin)) continue;
          const r = await executePaperTrade(
            { uid, symbol, side: 'buy', price: data.price, source: 'engine', assetClass: classify(symbol) },
            clamped,
          );
          if (r.executed) {
            executed += 1;
            // Map mitführen: Ein Symbol kann in der Watchlist doppelt stehen —
            // ohne das versuchte der Scan denselben Kauf zweimal (der Broker
            // lehnt transaktional ab, aber der Aufruf ist unnötig). Die Level
            // bleiben null: Risk-Exits liefen für diesen Scan bereits oben.
            positions.set(symbol, {
              symbol,
              qty: r.trade?.qty ?? 0,
              avgEntry: r.trade?.price ?? data.price,
              stopLoss: null,
              takeProfit: null,
              openedAt: r.trade?.executedAt ?? now.toISOString(),
            });
            logger.info(`Engine-Buy ${uid} ${symbol} @ ${data.price}`);
          }
        } else if (direction === 'sell' && pos && pos.side !== 'short') {
          // Signal-Ausstieg erst nach der Mindest-Haltedauer. Die Risiko-Exits
          // (Stop, Trailing, Take) sind oben in diesem Scan bereits gelaufen —
          // das Sicherheitsnetz bleibt also jederzeit scharf, gebremst wird
          // nur das Rausspucken durch eine gekippte Indikator-Stimme.
          if (minHoldActive(pos.openedAt, now, clamped.engine.minHoldMin ?? 0)) continue;
          const r = await executePaperTrade(
            { uid, symbol, side: 'sell', price: data.price, source: 'engine', assetClass: classify(symbol) },
            clamped,
          );
          if (r.executed) {
            executed += 1;
            positions.delete(symbol);
            logger.info(`Engine-Sell ${uid} ${symbol} @ ${data.price}`);
          }
        } else if (direction === 'sell' && !pos && allowShort) {
          // Leerverkauf (Opt-in): Verkaufs-Signal ohne Position eröffnet
          // einen Short — gleiche Entry-Guards wie beim Kauf (Limit,
          // Cooldown), gleiche Risiko-Hülle, Level gespiegelt im Broker.
          if (positions.size >= RISK_LIMITS.maxOpenPositions) continue;
          if (cooldownActive(engineCooldowns[symbol], now, cdMin)) continue;
          const r = await executePaperTrade(
            { uid, symbol, side: 'sell', price: data.price, source: 'engine', assetClass: classify(symbol), openShort: true },
            clamped,
          );
          if (r.executed) {
            executed += 1;
            positions.set(symbol, {
              symbol,
              qty: r.trade?.qty ?? 0,
              avgEntry: r.trade?.price ?? data.price,
              side: 'short',
              stopLoss: null,
              takeProfit: null,
              openedAt: r.trade?.executedAt ?? now.toISOString(),
            });
            logger.info(`Engine-Short ${uid} ${symbol} @ ${data.price}`);
          }
        }
      }

      // Risk-Exit-Cooldowns persistieren (ein Write je User und Scan, nur
      // bei Änderung). update() ersetzt GENAU dieses Feld durch die
      // bereinigte Map — set/merge würde weggeräumte Einträge liegen lassen,
      // set ohne merge das ganze User-Doc (Wallet!) plattmachen.
      if (cooldownUpdates.length > 0) {
        await (userDoc.ref.update as (...a: unknown[]) => Promise<unknown>)(
          ...cooldownUpdates,
        ).catch(() => undefined);
      }

      // Schatten-Flotte des Auto-Tuners (MT2): Jede Parameter-Variante rechnet
      // denselben Scan auf ihrem eigenen virtuellen Konto mit. Das kostet
      // KEINEN zusätzlichen Fetch — die Marktdaten liegen schon hier — und
      // liefert Out-of-Sample-Evidenz, aus der autoTune täglich entscheidet.
      // Ein Fehler hier darf den echten Handel niemals stören, deshalb der
      // eigene Fang.
      if (userDoc.get('settings.autoTune') !== false) {
        try {
          const variants = buildVariants(clamped, FLEET_SIZE);
          if (variants.length > 0) {
            const fleetRef = userDoc.ref.collection('tuning').doc('fleet');
            const vorher =
              ((await fleetRef.get()).get('variants') as FleetState | undefined) ?? {};
            // Die Flotte sieht GENAU dieselben Symbole wie der echte Pfad.
            // Das ist der ganze Zweck der Schatten-Rechnung: Eine Variante,
            // die auf einer anderen Symbolmenge liefe, wäre nicht
            // vergleichbar — und ein nicht vergleichbares Ergebnis ist
            // schlimmer als gar keines, weil es befördert werden könnte.
            const fleetSymbols = [...marketData.keys()];
            const { state } = stepFleet(variants, marketData, vorher, fleetSymbols, now);
            await fleetRef.set({ variants: state, updatedAt: now.toISOString() }, { merge: true });
          }
        } catch (err) {
          logger.warn(`Schatten-Flotte für ${uid} übersprungen`, err);
        }
      }
    } catch (err) {
      logger.error(`Auto-Trading-Fehler für ${uid}`, err);
    }
  }
  return executed;
}

/** Obergrenze des zentralen Scan-Sets (Kosten-Guard). */
const MAX_SCAN_SYMBOLS = 40;

/**
 * Scan-Set = Default-Watchlist ∪ alle User-Watchlists (M3: der Picker macht
 * Symbole wählbar; der nächste Scan versorgt sie zentral mit Daten).
 */
/**
 * Welche Symbole der Scan beobachtet — die Reihenfolge IST die Priorität,
 * weil `max` abschneidet.
 *
 * Pur gehalten, damit die Rangfolge prüfbar ist: Sie entscheidet, was
 * überhaupt handelbar ist. Ein Fehler hier fällt nirgends auf — es fehlt
 * einfach ein Symbol, und niemand vermisst, was er nie gesehen hat.
 *
 *  1. **Offene Positionen** — immer und zuerst (Verkaufs-Sicherheit 26.07.).
 *     Eine Position, die aus der Beobachtung fiele, verlöre jeden
 *     Exit-Pfad: Stop-Loss, Take-Profit, Konfluenz-Verkauf. Sie muss
 *     beobachtet bleiben, bis sie geschlossen ist — auch wenn ihr Symbol
 *     im Ranking auf Platz 150 steht.
 *  2. **Die Rangliste** des täglichen Momentum-Laufs über den ganzen
 *     Katalog. Bis 27.07. standen hier die handverlesenen Watchlists der
 *     Nutzer — eine Vorauswahl ohne jede Begründung.
 *  3. **Defaults** als Boden. Greift am ersten Tag (noch kein Ranking) und
 *     wenn der Marktfilter die Rangliste kurz hält.
 *  4. **Katalog** als letzter Boden — nur, wenn 1–3 nichts Offenes hergeben.
 *
 * ── Marktzeit gehört in die AUSWAHL, nicht dahinter (Audit-Befund A1) ───────
 *
 * Bis 28.07. wählte diese Funktion die globalen Top-N und `runScan` warf
 * danach alles weg, dessen Klasse gerade geschlossen ist. Das Ergebnis war
 * live messbar: `lastRunSkipped: market_closed` um 12:35 UTC — obwohl Krypto
 * rund um die Uhr handelt und im Katalog steht. Die Default-Liste enthält
 * nur US-Aktien, also tat der Scan außerhalb 13:30–20:00 UTC gar nichts:
 * rund 70 % der Zeit plus Wochenenden.
 *
 * Der Fehler verschwindet nicht mit der ersten Rangliste. Sind deren Top-40
 * überwiegend Aktien — was bei einem aktienlastigen Katalog der Normalfall
 * ist —, bleibt der Scan nachts fast leer. Deshalb filtert `isOpen` schon
 * BEIM Füllen: Das Kontingent geht an die bestplatzierten Symbole, die
 * gerade auch handelbar sind.
 *
 * Positionen bleiben ausdrücklich UNGEFILTERT. Ob ihre Börse offen ist,
 * entscheidet später der Handelspfad; hier ausgesiebt zu werden hieße, eine
 * offene Position aus den Augen zu verlieren — genau das, was Punkt 1
 * verhindert.
 */
export function selectScanSymbols(args: {
  positions: string[];
  ranking: string[];
  defaults: string[];
  /** Letzter Boden (ganzer Katalog), falls 1–3 nichts Offenes liefern. */
  catalog?: string[];
  max: number;
  /** Ist die Asset-Klasse dieses Symbols gerade handelbar? Default: alles. */
  isOpen?: (symbol: string) => boolean;
}): string[] {
  const offen = args.isOpen ?? ((): boolean => true);
  const set = new Set<string>();
  for (const sym of args.positions) set.add(sym); // ungedeckelt: siehe 1.
  for (const gruppe of [args.ranking, args.defaults, args.catalog ?? []]) {
    for (const sym of gruppe) {
      if (set.size >= args.max) break;
      if (sym && offen(sym)) set.add(sym);
    }
  }
  return [...set];
}

async function collectScanSymbols(now: Date): Promise<string[]> {
  const db = getFirestore();

  let positions: string[] = [];
  try {
    const posSnap = await db.collectionGroup('positions').select().get();
    positions = posSnap.docs.map((d) => d.id);
  } catch (err) {
    logger.warn('Positions-Symbole nicht lesbar — Scan ohne Positions-Union', err);
  }

  // Bewertet werden ALLE Katalog-Symbole — das tut `momentumRun` täglich
  // über die volle Tages-Historie. Was hier ausgewählt wird, ist etwas
  // anderes: welche Symbole der 5-Minuten-Scan intraday BEOBACHTET. Beides
  // gleichzusetzen wäre teuer und brächte nichts — 166 Symbole alle fünf
  // Minuten mit 5-min-Bars, RSI, MACD und Bollinger zu holen, kostet das
  // Vielfache und liefert für Rang 120 eine Information, auf die niemand
  // handelt. Breit bewerten, schmal beobachten.
  let ranking: string[] = [];
  try {
    const top = (await db.doc('meta/momentum').get()).get('top') as
      | Array<{ symbol?: unknown }>
      | undefined;
    ranking = (top ?? [])
      .map((e) => e?.symbol)
      .filter((sym): sym is string => typeof sym === 'string' && sym.length > 0);
  } catch (err) {
    logger.warn('Momentum-Ranking nicht lesbar', err);
  }

  const symbols = selectScanSymbols({
    positions,
    ranking,
    defaults: [...DEFAULT_STRATEGY.watchlist],
    catalog: allSymbols(),
    max: MAX_SCAN_SYMBOLS,
    isOpen: (sym) => marketOpenForClass(classify(sym), now),
  });
  logger.info(
    `Scan-Set: ${symbols.length} Symbole (${positions.length} Positionen, ${ranking.length} im Ranking)`,
  );
  return symbols;
}

/**
 * Wie viele Tageskerzen je Scan exakt nachgezogen werden.
 *
 * Die Kurse kommen seit dem Batch-Umbau für den GANZEN Katalog aus einem
 * Spark-Request-Bündel. Was Spark nicht liefert, ist die Tageskerze mit
 * Open/High/Low/Volume — dafür braucht es weiter einen Chart-Fetch je Symbol.
 * Der ist reine Historie (Sparklines, Mini-Charts) und darf deshalb langsam
 * rotieren: 10 Symbole je Scan = voller Katalog gut jede Stunde.
 */
const BAR_CHUNK = 10;

/**
 * Katalog-Versorgung — seit 28.07. BATCH statt Rotation.
 *
 * Owner-Frage: „kann das tool nicht alles immer parallel beobachten? markt ist
 * ja dynamisch und ändert sich stetig!" Vorher nicht: `getQuickQuote` kostet
 * einen Yahoo-Fetch je Symbol, also lief der Katalog in 15er-Häppchen mit
 * einem 50-min-Frische-Gate durch — ein Symbol war im schlechtesten Fall eine
 * Stunde alt, und das Momentum-Ranking sah entsprechend alte Kurse.
 *
 * Jetzt: EIN Spark-Bündel (9 Requests für 166 Symbole, gemessen 2,5 s) je
 * Scan. Jedes Symbol des Katalogs ist damit alle 5 Minuten frisch.
 *
 * Geschrieben wird trotzdem nur, was sich bewegen KANN: Symbole mit
 * geschlossener Asset-Klasse überspringt die Schleife. Das ist der ganze
 * Kostenhebel — Firestore-Writes sind teurer als Yahoo-Fetches, und ein
 * geschlossener Markt liefert bis zur Eröffnung denselben Kurs.
 */
async function supplyCatalog(
  scannedSet: Set<string>,
  now: Date,
): Promise<{ fresh: number; open: number }> {
  const db = getFirestore();
  const catalog = allSymbols().filter((s) => !scannedSet.has(s));
  if (catalog.length === 0) return { fresh: 0, open: 0 };

  // Nur offene Klassen: ein geschlossener Markt kann keinen neuen Kurs haben.
  const offen = catalog.filter((s) => marketOpenForClass(classify(s), now));
  const quotes: Map<string, SparkQuote> =
    offen.length > 0 ? await getSparkBatch(offen) : new Map();

  const stateRef = db.doc('meta/catalogSupply');
  const cursor = ((await stateRef.get()).get('barCursor') as number | undefined) ?? 0;

  const batch = db.batch();
  let fetched = 0;
  for (const sym of offen) {
    const q = quotes.get(sym);
    if (!q) continue; // dieser Chunk hat gepatzt — nächster Scan in 5 min
    batch.set(
      db.collection('market').doc(sym),
      {
        symbol: sym,
        name: resolveName(sym),
        assetClass: classify(sym),
        quote: { price: q.price, changePct: q.changePct, updatedAt: now.toISOString() },
      },
      { merge: true },
    );
    fetched++;
  }

  // Tages-Tier: exakte Kerzen (OHLCV) rotierend nachziehen — Spark kennt nur
  // Closes. Läuft über den GANZEN Katalog, auch über geschlossene Klassen:
  // Deren Schlusskerze entsteht ja gerade erst nach Handelsschluss.
  const barSyms: string[] = [];
  for (let n = 0; n < BAR_CHUNK; n++) barSyms.push(catalog[(cursor + n) % catalog.length]!);
  for (const sym of new Set(barSyms)) {
    try {
      const qq = await getQuickQuote(sym);
      batch.set(db.collection('market').doc(sym).collection('bars').doc(qq.lastBar.date), {
        ...qq.lastBar,
      });
      batch.set(
        db.collection('market').doc(sym),
        { lastBarDate: qq.lastBar.date },
        { merge: true },
      );
    } catch (err) {
      logger.warn(`Katalog-Tageskerze ${sym}`, err); // nächste Runde erneut
    }
  }

  batch.set(
    stateRef,
    {
      barCursor: (cursor + BAR_CHUNK) % catalog.length,
      updatedAt: now.toISOString(),
      lastFetched: fetched,
      catalogSize: catalog.length,
      openSize: offen.length,
    },
    { merge: true },
  );
  await batch.commit();
  return { fresh: fetched, open: offen.length };
}

/** Ein kompletter Scan-Zyklus über die zentrale Watchlist. */
export async function runScan(force = false): Promise<ScanResult> {
  const now = new Date();
  const scanId = now.toISOString().slice(0, 16) + 'Z'; // Minute = idempotent
  const scanSet = await collectScanSymbols(now);
  // Depot-Vision (2026-07-24): gescannt wird je Symbol, dessen ASSET-KLASSE
  // gerade offen ist — Krypto 24/7, Forex/Rohstoffe ~24/5, Rest US-Zeiten.
  //
  // Das Filtern steht seit dem Audit-Befund A1 (28.07.) NICHT mehr allein da:
  // `collectScanSymbols` wählt bereits nur Offenes aus. Hier bleibt es als
  // zweiter Riegel — und für die Positionen, die die Auswahl bewusst
  // ungefiltert durchlässt. Ohne die Auswahl davor war dieses Filter der
  // Grund, warum der Scan ~70 % der Zeit nichts tat: Es warf weg, was die
  // globale Top-N-Wahl vorher blind eingesammelt hatte.
  const symbols = force
    ? scanSet
    : scanSet.filter((s) => marketOpenForClass(classify(s), now));
  if (symbols.length === 0) {
    logger.info(`Alle Märkte geschlossen — Scan übersprungen (${scanId})`);
    // Heartbeat auch im No-Op: „Scheduler lebt" ≠ „Markt offen" (M7-Monitoring)
    await getFirestore()
      .doc('meta/health')
      .set({ lastRunAt: now.toISOString(), lastRunSkipped: 'market_closed' }, { merge: true })
      .catch(() => undefined);
    return { scanId, scanned: [], errors: {}, trades: 0, skipped: 'market_closed' };
  }

  await seedUniverse();
  const db = getFirestore();
  const scanned: string[] = [];
  const errors: Record<string, string> = {};
  const marketData = new Map<string, SymbolData>();
  // Intraday-Selbstdiagnose (Chart-Feedback): landet im öffentlichen
  // meta/health, weil Cloud-Logging ohne GCP-Konsole unsichtbar ist.
  let intradayOk = 0;
  let intradayError: string | null = null;

  // Genauigkeitsgewichtetes Forecast-Vote (Prognose 2.0 Teil 4): Das
  // Stimmgewicht der Prognose folgt ihrer REALISIERTEN Kante über den
  // Münzwurf — einmal je Scan aus der öffentlichen Lernstatistik gelesen.
  // Startwert 0, nicht das Basisgewicht: Ist die Statistik nicht lesbar,
  // gibt es keine Evidenz — und ohne Evidenz stimmt die Prognose nicht mit
  // (Beweislast-Umkehr 28.07., siehe accuracyWeightedVote).
  let fcVote = { weight: 0, factor: null as number | null };
  try {
    const statsSnap = await db.doc('meta/forecastStats').get();
    fcVote = accuracyWeightedVote(DEFAULT_STRATEGY.signals.forecastWeight, {
      scored: statsSnap.get('scored') as number | undefined,
      dirAccuracy: statsSnap.get('dirAccuracy') as number | null | undefined,
    });
  } catch (err) {
    logger.warn('forecastStats nicht lesbar — Prognose stimmt nicht mit', err);
  }
  const effSignals = { ...DEFAULT_STRATEGY.signals, forecastWeight: fcVote.weight };

  for (const symbol of symbols) {
    try {
      const snap = await getMarketSnapshot(symbol, DEFAULT_STRATEGY.signals.period);
      const closes = snap.bars.map((b) => b.close);
      const lastDate = snap.bars[snap.bars.length - 1]!.date;

      const symRef = db.collection('market').doc(symbol);
      const symDoc = await symRef.get();
      const batch = db.batch();

      // Prognose als reine Preis-Regression + Shadow-Grid
      let forecast: LiveForecast | null = null;
      try {
        forecast = await runForecast(symbol, closes, lastDate);
      } catch (err) {
        logger.warn(`Forecast-Fehler ${symbol}`, err);
      }
      // ATR(14) in % — Basis für volatilitätsadaptive Stops (MA6). Wird nur
      // berechnet, nicht erzwungen: Ohne atrStopMult bleibt alles wie gehabt.
      const atrPctVal = atrPct(snap.bars.map((b) => ({ high: b.high, low: b.low, close: b.close })), 14);
      marketData.set(symbol, { closes, price: snap.price, forecast, atrPct: atrPctVal });

      const sig = computeSignal(
        closes,
        snap.price,
        DEFAULT_STRATEGY.indicators,
        effSignals,
        forecast,
      );

      batch.set(
        symRef,
        {
          name: resolveName(symbol),
          assetClass: classify(symbol),
          quote: {
            price: snap.price,
            changePct: snap.changePct,
            updatedAt: now.toISOString(),
          },
          source: snap.source,
          // Live-Prognose fürs Chart-Overlay (Punkte + Band + Kennwerte)
          forecast: forecast
            ? {
                points: forecast.points,
                band: forecast.band,
                lookback: forecast.lookback,
                predictedPct: Math.round(forecast.predictedPct * 100) / 100,
                baseDate: lastDate,
                calib: forecast.calib,
              }
            : null,
        },
        { merge: true },
      );

      // Bars: Erst-Backfill komplett, danach nur der letzte Bar.
      // v2 (Chart-Feedback 24.07.): Historie 1y statt 3mo — Bestandssymbole
      // werden über den Versions-Marker einmalig neu backgefüllt.
      const backfilled = symDoc.get('barsBackfillV') === 2;
      const barsToWrite = backfilled ? snap.bars.slice(-1) : snap.bars;
      for (const bar of barsToWrite) {
        batch.set(symRef.collection('bars').doc(bar.date), {
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
        });
      }
      if (!backfilled) {
        batch.set(
          symRef,
          { barsBackfillV: 2, barsBackfilledAt: now.toISOString() },
          { merge: true },
        );
      }

      // Tiefe Historie (Chart-Audit 2, 25.07.): einmalig ~5 Jahre Tages-Bars
      // als EIN Doc je Jahr (ohlcDaily/{JAHR}) — nahtloses Rausscrollen im
      // Chart bei ~1 Read je Jahr. Additiv + idempotent (Versions-Marker);
      // die bars-Collection (rollierendes Jahr) bleibt unangetastet.
      if (symDoc.get('deepBackfillV') !== 1) {
        try {
          const deep = await getDeepDailyBars(symbol);
          for (const [year, days] of chunkBarsByYear(deep)) {
            batch.set(
              symRef.collection('ohlcDaily').doc(year),
              { days, updatedAt: now.toISOString() },
              { merge: true },
            );
          }
          batch.set(symRef, { deepBackfillV: 1, deepBackfilledAt: now.toISOString() }, { merge: true });
        } catch (e) {
          logger.warn(`deepBackfill ${symbol}`, e); // nächster Scan versucht es erneut
        }
      }

      // Intraday (5m): Yahoo liefert ~5 Handelstage. Erst-Backfill alle Tage,
      // danach nur der jüngste Tag (1 Chunk-Doc je ET-Tag, idempotent).
      try {
        const intraday = await getIntradayBars(symbol);
        const days = [...intraday.keys()].sort();
        // 5-min-Closes ins Marktbild: Signal-Basis des 'intraday'-Zeitrahmens
        const md = marketData.get(symbol);
        if (md) md.closes5m = days.flatMap((d) => intraday.get(d) ?? []).map((b) => b.c);
        const writeDays = symDoc.get('intradayBackfilledAt') ? days.slice(-1) : days;
        for (const day of writeDays) {
          batch.set(symRef.collection('ohlc5m').doc(day), {
            date: day,
            bars: intraday.get(day),
            updatedAt: now.toISOString(),
          });
        }
        if (!symDoc.get('intradayBackfilledAt')) {
          batch.set(symRef, { intradayBackfilledAt: now.toISOString() }, { merge: true });
        }
        intradayOk += 1;

        // Intraday-Kurzfrist-Prognose (Prognose 2.0 Teil 2): Projektion der
        // nächsten Stunde, bei JEDEM Scan neu berechnet (maximale Update-Rate);
        // Shadow-Gitter loggt nur bei offenem Markt (Session-Gate im Forecaster).
        try {
          const flat = days.flatMap((d) => intraday.get(d) ?? []);
          const ifc = await runIntradayForecast(
            symbol,
            flat,
            marketOpenForClass(classify(symbol), now),
          );
          if (md) md.intradayPct = ifc?.predictedPct ?? null;
          batch.set(
            symRef,
            {
              forecastIntraday: ifc
                ? {
                    points: ifc.points,
                    band: ifc.band,
                    lookback: ifc.lookback,
                    predictedPct: Math.round(ifc.predictedPct * 100) / 100,
                    baseT: ifc.points[0]!.t - 300,
                    updatedAt: now.toISOString(),
                    calib: ifc.calib,
                  }
                : null,
            },
            { merge: true },
          );
        } catch (err) {
          logger.warn(`Intraday-Forecast-Fehler ${symbol}`, err);
        }
      } catch (err) {
        logger.warn(`Intraday-Fehler ${symbol}`, err);
        intradayError ??= `${symbol}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 180);
      }

      // Indikator-Snapshot des letzten Handelstags (1 Doc/Tag, überschreibend).
      // `date` zusätzlich als Feld: Firestore kann nicht absteigend über
      // Doc-IDs sortieren (kein descending key scan) — Clients sortieren
      // deshalb über dieses Feld.
      batch.set(symRef.collection('indicators').doc(lastDate), {
        ...sig.snapshot,
        date: lastDate,
      });

      // Konfluenz-Signal dieses Scans
      batch.set(symRef.collection('signals').doc(scanId), {
        direction: sig.direction,
        confluence: sig.confluence,
        buyVotes: sig.buyVotes,
        sellVotes: sig.sellVotes,
        requiredConfluence: sig.requiredConfluence,
        votes: sig.votes,
        price: sig.price,
        at: now.toISOString(),
        // Transparenz: effektives Prognose-Stimmgewicht dieses Scans
        forecastVote: {
          base: Math.trunc(DEFAULT_STRATEGY.signals.forecastWeight),
          weight: fcVote.weight,
          factor: fcVote.factor,
        },
      });

      await batch.commit();
      scanned.push(symbol);
    } catch (err) {
      errors[symbol] = err instanceof Error ? err.message : String(err);
      logger.error(`Scan-Fehler ${symbol}`, err);
    }
  }

  // Auto-Trades pro User (1 Marktdaten-Fetch oben, N Auswertungen hier).
  // Geguarded: Ein Fehler hier darf den Heartbeat nicht verhindern — sonst
  // bleibt meta/health stehen und die Ursache ist ohne GCP-Konsole unsichtbar.
  let trades = 0;
  let lastError: string | null = null;
  try {
    trades = await executeUserTrades(marketData);
  } catch (err) {
    lastError = `trades: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400);
    logger.error('Trade-Block fehlgeschlagen', err);
  }

  // Katalog-Versorgung (alle Marktgruppen, rotierender Chunk) — geguarded,
  // damit ein Yahoo-/Firestore-Schluckauf nie den Kern-Scan gefährdet.
  let catalogQuotes = 0;
  let catalogOpen = 0;
  try {
    const supply = await supplyCatalog(new Set(scanned), now);
    catalogQuotes = supply.fresh;
    catalogOpen = supply.open;
  } catch (err) {
    lastError = lastError ?? `catalog: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400);
    logger.warn('Katalog-Versorgung fehlgeschlagen', err);
  }

  // Intraday-Prognosen bewerten (Prognose 2.0 Teil 2): Kurzfrist-Horizonte
  // realisieren binnen einer Stunde — huckepack im Scan statt täglich 16:30.
  let intradayScored = 0;
  // Die Zwischenstände (offen/fällig/verfallen/noch nicht realisiert) landen
  // mit im Heartbeat: Eine 0 bei „bewertet" allein sagt nicht, WORAN es lag —
  // genau daran hing der Befund vom 27.07., als die Zahl tagelang stand,
  // während gleichzeitig Prognosen entstanden.
  let intradayEval: Record<string, number> | null = null;
  try {
    const res = await evaluateIntradayDue();
    intradayScored = res.scored;
    intradayEval = {
      pending: res.pending,
      due: res.due,
      expired: res.expired,
      unrealized: res.unrealized,
    };
  } catch (err) {
    lastError = lastError ?? `evalIntraday: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400);
    logger.warn('Intraday-Eval fehlgeschlagen', err);
  }

  // Heartbeat für Monitoring-Alerts (SETUP.md §J): meta/health ist öffentlich
  // lesbar (meta-Rules) und enthält bewusst KEINE sensiblen Daten.
  await db
    .doc('meta/health')
    .set(
      {
        lastScanAt: now.toISOString(),
        lastScanId: scanId,
        lastRunAt: now.toISOString(),
        lastRunSkipped: null,
        symbolsOk: scanned.length,
        symbolsFailed: Object.keys(errors).length,
        // Was gerade beobachtet wird — die Oberfläche zeigt genau diese
        // Symbole an. Ohne die Liste im Heartbeat müsste sie raten oder
        // eine eigene Auswahl treffen, und dann zeigte das Dashboard etwas
        // anderes, als die Engine handelt.
        watched: scanned,
        intradayOk,
        intradayError,
        intradayScored,
        intradayEval,
        trades,
        // Katalog-Beobachtung (Owner-Frage 28.07. „alles immer parallel"):
        // `catalogQuotes` = in DIESEM Scan frisch bekurste Katalog-Symbole,
        // `catalogOpen` = wie viele überhaupt einen offenen Markt hatten.
        // Stehen die beiden auseinander, hat ein Spark-Chunk gepatzt — das
        // wäre sonst unsichtbar, weil fehlende Kurse einfach alte bleiben.
        catalogQuotes,
        catalogOpen,
        lastError,
        lastErrorAt: lastError ? now.toISOString() : null,
      },
      { merge: true },
    )
    .catch((err) => logger.warn('Heartbeat-Write fehlgeschlagen', err));

  logger.info(`Scan ${scanId}: ${scanned.length}/${symbols.length} Symbole ok, ${trades} Trade(s)`);
  return { scanId, scanned, errors, trades };
}

/** Alle 5 Minuten; der Gate macht außerhalb der Marktzeiten einen No-Op.
 *  512 MiB statt Default 256 (Live-OOM 25.07.: „Memory limit exceeded with
 *  259–274 MiB" — 5J-Backfill + Katalog-Versorgung + volle Watchlist brauchen
 *  Luft); 180 s Timeout für den Erst-Backfill mehrerer Symbole. */
export const scanMarket = onSchedule(
  {
    schedule: 'every 5 minutes',
    timeZone: 'America/New_York',
    retryCount: 0,
    memory: '512MiB',
    timeoutSeconds: 180,
    // Kein KI-Secret mehr: Der Scan ruft seit 28.07. keine Claude-API auf —
    // Der Scan ruft kein Sprachmodell mehr auf (MILESTONES M6).
  },
  async () => {
    try {
      await runScan(false);
    } catch (err) {
      // Selbstdiagnose ohne GCP-Konsole: Die Fehlermeldung (nie Secrets —
      // unsere Fehlerpfade loggen keine Keys) landet im öffentlichen
      // meta/health, damit ein roter Lauf von außen erklärbar ist. Der
      // Fehler wird rethrown, damit Cloud Logging + Monitoring ihn sehen.
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 400);
      logger.error('runScan fehlgeschlagen', err);
      await getFirestore()
        .doc('meta/health')
        .set({ lastError: `scan: ${msg}`, lastErrorAt: new Date().toISOString() }, { merge: true })
        .catch(() => undefined);
      throw err;
    }
  },
);

/**
 * Manueller Trigger — NUR im Emulator (lokale Verifikation, MILESTONES M2
 * Abnahme). In Produktion hart 403, damit niemand Scan-Kosten erzeugen kann.
 */
export const scanNow = onRequest(EMULATOR_TRIGGER_OPTS, async (req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') {
    res.status(403).json({ error: 'scanNow ist nur im Emulator verfügbar' });
    return;
  }
  const force = req.query.force === '1';
  const result = await runScan(force);
  res.status(200).json(result);
});
