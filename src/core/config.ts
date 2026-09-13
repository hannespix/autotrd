/**
 * Konfiguration: YAML-Datei + Umgebung (.env). Validiert mit zod — ein
 * Auto-Trader darf mit einer halb verstandenen Config nicht starten.
 *
 * Echtgeld-Doppel-Guard (nicht verhandelbar):
 *   broker.mode = 'live'  UND  ALPACA_ALLOW_LIVE=1  UND  Live-Key (AK…)
 * Fehlt eines davon ⇒ Paper. Ein Live-Key gegen Paper wird abgelehnt,
 * damit niemand "aus Versehen" mit dem falschen Konto arbeitet.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { TIMEFRAMES, type TimeframeMin } from './types.ts';
import { normalizeUserSymbol } from '../alpaca/symbols.ts';
import { BAR_ADJUSTMENTS } from '../alpaca/types.ts';

const pct = (max: number) => z.number().min(0).max(max);

/** Aufgelöstes Universum: kanonische Schreibweise, ohne Duplikate. */
export interface ResolvedUniverse {
  assetClass: 'us_equity' | 'crypto';
  /** Was tatsächlich gehandelt wird. */
  symbols: string[];
  /** Obergrenze der nächtlichen Auswahl. */
  maxSymbols: number;
  benchmark?: string;
  /** Pool der nächtlichen Auswahl; enthält immer mindestens `symbols`. */
  candidates?: string[];
}

export const ConfigSchema = z.object({
  broker: z
    .object({
      mode: z.enum(['paper', 'live']).default('paper'),
      /** Datenfeed für Backtest UND Live — immer derselbe, sonst misst man etwas anderes als man handelt. */
      feed: z.enum(['iex', 'sip']).default('iex'),
      /**
       * Bereinigung der TAGESBARS (Alpaca `adjustment`). `raw` bleibt der
       * Default: Preisbars, wie sie gehandelt wurden — ohne Ausschüttungen
       * und Splits. `all` rechnet beides heraus. Für Signale auf Anleihe- und
       * Dividenden-ETFs (TLT, IEF, LQD, HYG) ist das die richtige Reihe:
       * Roh fehlen ihnen 3–6 % Rendite im Jahr, und im Momentum-Vergleich
       * mit Aktien-ETFs fallen sie systematisch zu schwach aus; auch die
       * Benchmark SPY liegt roh zu niedrig (Red-Team 09.09.2026, M7).
       *
       * Was der Schalter NICHT tut: Minutenbars bleiben immer roh (aus ihnen
       * aggregiert die Engine die Bars für die Ausführung, und die läuft zu
       * echten Kursen), Streams sind unberührt. Je Bereinigung gibt es einen
       * eigenen Bars-Cache (`data/store.ts`, `barStoreRoot`), damit sich
       * bereinigte und rohe Tagesbars nie mischen.
       */
      adjustment: z.enum(BAR_ADJUSTMENTS).default('raw'),
    })
    .default({ mode: 'paper', feed: 'iex', adjustment: 'raw' }),
  universe: z
    .object({
      assetClass: z.enum(['us_equity', 'crypto']).default('us_equity'),
      symbols: z.array(z.string().min(1)).min(1).max(50),
      /** Benchmark für Marktfilter (z. B. SPY). Wird mitgeladen, nie gehandelt. */
      benchmark: z.string().min(1).optional(),
      /**
       * Pool, aus dem die nächtliche Auswahl (`autotrd universe`) die
       * `maxSymbols` liquidesten wählt. Leer ⇒ `symbols` bleibt fest.
       * Der Pool wird von Hand gepflegt und nur mit Commit geändert — die
       * Auswahl darin läuft automatisch, aber ausschließlich nach Liquidität.
       */
      candidates: z.array(z.string().min(1)).max(300).optional(),
      /** Wie viele Symbole die Auswahl behält (IEX-Basis: höchstens 30 inkl. Benchmark). */
      maxSymbols: z.number().int().min(1).max(30).default(30),
    })
    // Kanonische Alpaca-Schreibweise (BRK-B → BRK.B, btcusd → BTC/USD) und Duplikate raus —
    // sonst bucht ein Fill unter „BTC/USD", während die Entscheidung „BTCUSD" ohne Position sieht.
    .transform((u): ResolvedUniverse => {
      const norm = (s: string) => normalizeUserSymbol(s, u.assetClass);
      const symbols = [...new Set(u.symbols.map(norm))];
      const out: ResolvedUniverse = { assetClass: u.assetClass, symbols, maxSymbols: u.maxSymbols };
      if (u.benchmark !== undefined) out.benchmark = norm(u.benchmark);
      // Der Pool enthält immer mindestens das aktuelle Universum: Sonst könnte eine
      // Auswahl Symbole verlieren, die die Config gerade handelt.
      if (u.candidates !== undefined) out.candidates = [...new Set([...symbols, ...u.candidates.map(norm)])];
      return out;
    }),
  /** Strategie-Zeitrahmen in Minuten (1440 = Tagesbars). */
  timeframe: z
    .number()
    .refine((n): n is TimeframeMin => (TIMEFRAMES as readonly number[]).includes(n), {
      message: `timeframe muss einer von ${TIMEFRAMES.join(', ')} sein`,
    })
    .default(5),
  session: z
    .object({
      /** Keine Einstiege in den ersten X Minuten nach Open (Eröffnungsrauschen). */
      noEntryFirstMin: z.number().int().min(0).max(390).default(5),
      /** Keine Einstiege in den letzten X Minuten vor Close. */
      noEntryLastMin: z.number().int().min(0).max(390).default(30),
      /** Intraday-Strategien: Glattstellen X Minuten vor Close. */
      flattenBeforeCloseMin: z.number().int().min(0).max(120).default(5),
    })
    .default({ noEntryFirstMin: 5, noEntryLastMin: 30, flattenBeforeCloseMin: 5 }),
  risk: z
    .object({
      /** Risiko je Trade in % der Equity (Distanz Einstand ↔ Stop). */
      riskPerTradePct: pct(5).default(0.5),
      /** Maximale Positionsgröße in % der Equity. */
      maxPositionPct: pct(100).default(20),
      maxPositions: z.number().int().min(1).max(50).default(4),
      /** Brutto-Exposure (Summe |Positionen|) in % der Equity. */
      maxGrossExposurePct: pct(400).default(100),
      /** Tages-Notbremse: ab diesem Tagesverlust alles glattstellen und bis zum nächsten Handelstag halten. */
      maxDailyLossPct: pct(50).default(2),
      /** Drawdown-Sperre vom Equity-Hoch: Halt bis manuelles `resume`. */
      maxDrawdownPct: pct(90).default(10),
      allowShort: z.boolean().default(false),
      /**
       * Volatilitätsziel für das PORTFOLIO (risk/volziel.ts): Der Faktor
       * skaliert das Sizing-BUDGET beider Semantiken (Risiko je Trade und
       * Allokation) mit Ziel-Vola / realisierter Vola der eigenen
       * Equity-Kurve. Die Deckel (`maxPositionPct`, `maxGrossExposurePct`,
       * `maxPositions`, Bargeld) bleiben harte Obergrenzen — der Faktor
       * hebelt keinen davon aus.
       *
       * `enabled: false` ist Vorgabe und heißt: Faktor 1,0, also exakt das
       * Verhalten ohne dieses Feld. Das ist Absicht — eine Änderung am
       * Sizing darf kein bestehendes Messergebnis still verschieben; wer sie
       * einschaltet, registriert das vorher (§4a) und misst neu.
       */
      volTarget: z
        .object({
          enabled: z.boolean().default(false),
          /** Zielschwankung des Depots in % p. a. */
          zielVolPct: z.number().min(0.1).max(100).default(10),
          /** Halbwertszeit der EWMA-Gewichte in Handelstagen. */
          halbwertszeitTage: z.number().int().min(1).max(500).default(20),
          /** Untere Grenze des Faktors. */
          minFaktor: z.number().min(0).max(10).default(0.25),
          /** Obere Grenze des Faktors — auch bei Vola 0 wird nie mehr skaliert. */
          maxFaktor: z.number().min(0).max(10).default(2),
          /** Darunter gilt Faktor 1,0 („Aufwärmphase") — geraten wird nicht. */
          minBeobachtungen: z.number().int().min(1).max(2000).default(60),
        })
        .default({ enabled: false, zielVolPct: 10, halbwertszeitTage: 20, minFaktor: 0.25, maxFaktor: 2, minBeobachtungen: 60 })
        .refine((v) => v.maxFaktor >= v.minFaktor, { message: 'risk.volTarget.maxFaktor muss ≥ minFaktor sein' }),
      /**
       * Notbremsen je STUFE (`alpha` = Alpha-Champion, `basis` = Basis-Stufe,
       * core/basisTier.ts). `null` heißt „der globale Wert daneben gilt", und
       * das ist die Vorgabe für jeden der vier Werte: Ohne ausdrückliche Zahl
       * verhält sich alles wie bisher (ein Konto, eine Bremse). Die Werte
       * einer Stufe entscheiden nur über die Positionen und Einstiege DIESER
       * Stufe; Positionen ohne Stufe (Fallback-Strategie, adoptierter
       * Bestand) bleiben immer beim globalen Wert.
       *
       * Warum es das gibt (§5a.16, V3): Die Tagesbremse 2 % stellt ein voll
       * investiertes ETF-Depot an einem gewöhnlichen Minus-Tag glatt; bei
       * einer Monatsstrategie kostet ein solcher Tag einen Monat
       * Marktabwesenheit, und der Drawdown je Einheit Exposure wird dadurch
       * SCHLECHTER (15,95 % gegen 12,06 %). Eine Bremse, die im gemessenen
       * Normalfall auslöst, ist keine Sicherung.
       *
       * Was das NICHT ist: ein Weg, die Bremse global zu lockern. Jede Stufe
       * trägt ihre eigene, vorher festgelegte Zahl, und die Konto-Bremse
       * bleibt als letzter Halt darüber (risk/limits.ts, `kontoGrenzen`).
       */
      tiers: z
        .object({
          alpha: z
            .object({ maxDailyLossPct: pct(50).nullable().default(null), maxDrawdownPct: pct(90).nullable().default(null) })
            .default({ maxDailyLossPct: null, maxDrawdownPct: null }),
          basis: z
            .object({ maxDailyLossPct: pct(50).nullable().default(null), maxDrawdownPct: pct(90).nullable().default(null) })
            .default({ maxDailyLossPct: null, maxDrawdownPct: null }),
        })
        .default({ alpha: { maxDailyLossPct: null, maxDrawdownPct: null }, basis: { maxDailyLossPct: null, maxDrawdownPct: null } }),
      /**
       * Wiederaufbau einer Zielallokation nach einer Zwangs-Glattstellung
       * (core/logic.ts). Nur für Wahlen mit Allokations-Sizing (Basis-Stufe):
       * Wird ihr Buch von einer Notbremse glattgestellt, darf das Symbol am
       * nächsten erlaubten Tag wieder aufgebaut werden, statt bis zum
       * nächsten Entscheidungsfenster der Strategie zu warten (bei
       * `regime_allocation` ein Monat, §5a.16).
       *
       * Vorgabe aus: Das ändert Entscheidungen und gehört vor dem Lauf
       * registriert (§4a), nicht still in eine laufende Messung.
       */
      wiederaufbau: z
        .object({
          enabled: z.boolean().default(false),
          /** Nach so vielen Kalendertagen verfällt ein Wiederaufbau-Ziel ungenutzt. */
          maxAlterTage: z.number().int().min(1).max(60).default(5),
        })
        .default({ enabled: false, maxAlterTage: 5 }),
      /**
       * Geldmarkt-Parken (Treasury, risk/parken.ts): Kapital, das keine
       * Strategie braucht, liegt in einem kurzlaufenden Staatspapier statt
       * unverzinst auf dem Konto. Keine Handelsidee — kein Signal, kein
       * Kursziel, keine Kante; sie entfernt eine Verzerrung der Messung
       * (Läufe #46/#47: ΔSharpe ≈ −r_f/σ trifft gering investierte
       * Kandidaten achtmal härter als den voll investierten Maßstab).
       *
       * `enabled: false` ist Vorgabe: Ohne Config und ohne Parkposition
       * ändert sich bitgleich nichts. Wer sie einschaltet, registriert das
       * vorher (§4a) und misst neu.
       *
       * Das Parksymbol gehört der Treasury ALLEIN — es darf nicht im
       * Handelsuniversum stehen (Prüfung unten in `finalize`), sonst gäbe es
       * zwei Positionen mit zwei Herkünften in einem Symbol.
       *
       * Bereinigung: In rohen Tagesbars (`broker.adjustment: 'raw'`, Vorgabe)
       * trägt der Kurs eines ausschüttenden Geldmarkt-ETFs den Zins NICHT.
       * Gemessen wird das Parken nur mit `adjustment: 'all'`.
       */
      cashParking: z
        .object({
          enabled: z.boolean().default(false),
          /** Parksymbol (z. B. BIL); null ⇒ aus. Darf keine Strategie führen. */
          symbol: z.string().min(1).nullable().default(null),
          /**
           * Band: erst ab dieser Abweichung (in Prozentpunkten der Equity)
           * von der Zielquote wird umgeschichtet, und höchstens einmal je
           * Handelstag. Ein Umschichten bei jeder kleinen Abweichung wäre
           * genau die Krankheit des Vorgängersystems (CLAUDE.md §2).
           */
          bandPct: pct(100).default(5),
          /**
           * Bargeld, das ungeparkt bleibt (in % der Equity): Es deckt
           * Gebühren und den Einstieg am nächsten Morgen, ohne dass dafür
           * erst verkauft werden muss. Der Freikauf funktioniert auch ohne
           * Puffer — er spart nur Umschichtungen und damit Kosten.
           */
          bufferPct: pct(100).default(2),
        })
        .default({ enabled: false, symbol: null, bandPct: 5, bufferPct: 2 })
        .refine((v) => !v.enabled || (v.symbol !== null && v.symbol.trim().length > 0), {
          message: 'risk.cashParking.enabled: true ohne risk.cashParking.symbol — ohne Parksymbol gibt es nichts zu parken.',
        }),
      pdt: z
        .object({
          /** Pattern-Day-Trader-Regel respektieren (unter minEquity max. maxDayTrades in 5 Handelstagen). */
          respect: z.boolean().default(true),
          minEquity: z.number().min(0).default(25_000),
          maxDayTrades: z.number().int().min(0).max(3).default(3),
        })
        .default({ respect: true, minEquity: 25_000, maxDayTrades: 3 }),
    })
    .default({
      riskPerTradePct: 0.5,
      maxPositionPct: 20,
      maxPositions: 4,
      maxGrossExposurePct: 100,
      maxDailyLossPct: 2,
      maxDrawdownPct: 10,
      allowShort: false,
      // zod v4 reicht einen Default UNGEPRÜFT durch: Was hier fehlt, fehlt zur
      // Laufzeit, obwohl der Typ es verspricht. Also jeden Unterblock nennen.
      volTarget: { enabled: false, zielVolPct: 10, halbwertszeitTage: 20, minFaktor: 0.25, maxFaktor: 2, minBeobachtungen: 60 },
      tiers: { alpha: { maxDailyLossPct: null, maxDrawdownPct: null }, basis: { maxDailyLossPct: null, maxDrawdownPct: null } },
      wiederaufbau: { enabled: false, maxAlterTage: 5 },
      cashParking: { enabled: false, symbol: null, bandPct: 5, bufferPct: 2 },
      pdt: { respect: true, minEquity: 25_000, maxDayTrades: 3 },
    }),
  strategy: z
    .object({
      /** Fallback-Strategie, wenn kein Champion (optimize) vorliegt. */
      id: z.string().min(1).default('trend_donchian'),
      params: z.record(z.string(), z.number()).default({}),
      /** Ohne Champion nur handeln, wenn ausdrücklich erlaubt (Paper-Erkundung). */
      allowWithoutChampion: z.boolean().default(false),
      /**
       * Basis-Stufe handeln: Trägt die Champion-Datei einen Block `basis` mit
       * `pass: true` und passendem Zeitrahmen, handelt die Engine dessen Korb
       * mit dessen Parametern und Allokations-Sizing (`positionPct`) — für
       * Symbole, die kein Alpha-Champion führt (core/basisTier.ts). Vorgabe an
       * (Owner-Anweisung: von Anfang an aktiv); auf der Plattform gilt der
       * globale Schalter (`meta/engineConfig`) UND der Nutzer-Schalter
       * `settings.auto.basis` — beide müssen an sein. Aus heißt: keine NEUEN
       * Basis-Einstiege; eine offene Basis-Position führt die Basis-Strategie
       * zu Ende (eigene Exits, Broker-Stop bleibt; core/basisTier.ts,
       * Prüfbefund M6/M8) — keine Zwangs-Liquidation.
       */
      basis: z.boolean().default(true),
    })
    .default({ id: 'trend_donchian', params: {}, allowWithoutChampion: false, basis: true }),
  optimizer: z
    .object({
      strategies: z.array(z.string().min(1)).min(1).default(['trend_donchian', 'momentum_pullback', 'mean_reversion']),
      /** Historie in Kalendertagen, die geladen/bewertet wird. */
      /**
       * Obergrenze 4000 (≈ 11 Jahre) — die harte Grenze steht darunter in
       * `parseConfig` und hängt am ZEITRAHMEN: Tagesbars sind billig (30
       * Symbole × 11 Jahre ≈ 83 000 Bars), 5-Minuten-Bars nicht (dieselbe
       * Tiefe wären ~9 Mio. Bars). Die alte pauschale 2000 verbot deshalb
       * beides gleichzeitig und stand einer Messung im Weg, die einen
       * Bärenmarkt ins Fenster holen soll.
       */
      lookbackDays: z.number().int().min(30).max(4000).default(400),
      /** In-Sample-Fenster (Kalendertage). */
      isDays: z.number().int().min(20).default(120),
      /** Out-of-Sample-Fenster (Kalendertage). */
      oosDays: z.number().int().min(5).default(30),
      /** Schrittweite (Kalendertage); = oosDays ⇒ lückenlose OOS-Kette. */
      stepDays: z.number().int().min(1).default(30),
      /** Sperrzone zwischen IS und OOS in Bars (0 = automatisch: Warmup + max. Haltedauer). */
      embargoBars: z.number().int().min(0).default(0),
      /** Zufalls-Stichproben je Fold aus dem Parameterraum. */
      samples: z.number().int().min(4).max(5000).default(150),
      seed: z.number().int().default(42),
      minOosTrades: z.number().int().min(1).default(60),
      /** Anteil der Folds, die netto positiv sein müssen. */
      minFoldPositiveShare: z.number().min(0).max(1).default(0.6),
      objective: z.enum(['sortino', 'sharpe', 'return_over_dd']).default('sortino'),
      /** Kosten-Stressfaktor: Kandidat muss auch bei ×Faktor bestehen. */
      stressCostMultiplier: z.number().min(1).default(1.5),
      /** Nie zur Auswahl benutzte Schlusstage (nur Bericht). */
      holdoutDays: z.number().int().min(0).default(60),
      /** Champion nur ersetzen, wenn Kandidat um diesen Faktor besser ist. */
      promotionMargin: z.number().min(0).default(0.1),
      /** PSR der verketteten OOS-Tagesrenditen (gegen SR 0) muss diesen Wert erreichen. */
      minPsrOos: z.number().min(0).max(1).default(0.9),
      /** Deflated Sharpe (In-Sample) zusätzlich als hartes Gate (sonst nur im Bericht). */
      dsrIsGate: z.boolean().default(false),
      /**
       * Symbol, dessen Tagesrendite als RISIKOLOSER ZINS gilt — ein
       * Geldmarktpapier (z. B. `BIL`, 1–3 Monate T-Bills). Gesetzt, rechnen
       * `probabilistic_sharpe_oos` und `beats_market` auf Überschussrenditen
       * (r − r_f derselben Tage), auf BEIDEN Seiten oder auf keiner.
       *
       * Warum es das gibt (Befund B2 vom 12.09.2026,
       * `docs/wissen/vorregistrierung/2026-09-13-sharpe-gegen-zins.md`): Ein
       * Sharpe gegen null ist Ertrag über NULL je Schwankung. Solange nur
       * Aktien im Korb sind, ist das für alle gleich falsch. Mit einem
       * Geldmarktpapier im Korb — BIL trägt bei `adjustment: all` genau den
       * kurzen Zins und schwankt fast nicht — **wird Bargeld als Kante
       * verbucht**. Das kippt, sobald das Volatilitätsziel einen solchen
       * Sleeve hochskaliert.
       *
       * Vorgabe `null` = wie bisher, sr0 = 0. Bewusst so: Eine stille
       * Umstellung verschöbe alle bisherigen Messergebnisse, ohne dass ein
       * Bericht es sagt. Fehlt die Reihe (Symbol nicht geladen, zu viele
       * Lücken), fällt die Rechnung auf null zurück — und die Notiz des
       * Gates sagt es laut.
       *
       * Das Symbol wird als INFRASTRUKTUR geladen (`fetchSymbols` in
       * src/app.ts) — seit 13.09.2026 muss es dafür NICHT mehr im
       * Kandidatenpool stehen. Damit darf es dasselbe Papier sein wie
       * `risk.cashParking.symbol`, das umgekehrt nicht im Pool stehen DARF
       * (Doppelführung). Sind beide gleich, gibt es zwischen Zins und
       * geparkter Kasse keinen Spread — Laufzeit und Kostenquote sind
       * dieselben. Im Pool stehen darf es weiterhin: Ein Geldmarktpapier im
       * Korb ist genau der Fall, für den diese Zeile gebaut wurde.
       */
      riskFreeSymbol: z.string().min(1).nullable().default(null),
      /**
       * Höchstanteil des OOS-Nettos, den EIN einzelner Fold tragen darf.
       *
       * Die Lücke, die das schließt: Der TSLA-Champion vom 07.09. bestand
       * alle acht Gates — 103 OOS-Trades, +958 $, 5 von 7 Folds positiv,
       * PSR 0,95. Von den +958 $ stammten aber +919 $ aus EINEM Monat
       * (96 %). Ohne diesen Fold blieben +39 $ über 91 Trades, also nichts.
       * Der unberührte Holdout war entsprechend negativ (−232 $, PF 0,73).
       *
       * Kein Gate schaute darauf. `fold_positive_share` zählt Folds, nicht
       * ihr Gewicht; PSR misst die Renditereihe, nicht ihre Verteilung über
       * die Fenster. Ein Ergebnis, das an einem Monat hängt, ist aber keine
       * Kante, sondern ein Ereignis.
       */
      maxFoldNetShare: z.number().min(0).max(1).default(0.5),
      /**
       * Gepoolt bewerten: EIN Parametersatz je Strategie über das GANZE
       * Universum in einem Simulationslauf (ein Konto, ein Positionslimit),
       * statt je Symbol getrennt.
       *
       * Warum: Je Symbol fragt der Optimierer „hat die Strategie eine Kante
       * auf LTC?" — bei 33 OOS-Trades gegen ein Gate von 60 unbeantwortbar.
       * Gepoolt lautet die Frage „hat sie eine Kante in dieser Assetklasse?"
       * und hat bei 30 Symbolen rund dreißigmal so viele Trades. Zugleich
       * fällt ein ungezählter Freiheitsgrad weg: „bestes Symbol aus dreißig"
       * ist selbst eine Auswahl, die heute niemand deflationiert.
       */
      pooled: z.boolean().default(false),
      /**
       * Korb-Zugehörigkeit je Fold.
       *
       * `point_in_time`: Für jeden Fold wird der Korb zu dessen OOS-Beginn aus
       * `universe.candidates` gewählt — mit Daten bis dahin, Hysterese Fold
       * für Fold, wie nachts Nacht für Nacht (dieselbe `waehleUniverse`).
       * IS-Suche und OOS des Folds laufen auf diesem Korb; das ist genau der
       * Live-Prozess: Der nächtliche Lauf sucht die Parameter des HEUTIGEN
       * Korbs auf dem letzten Jahr. Der Maßstab (Korb liegenlassen) folgt mit.
       *
       * `fixed`: der Korb der Config über das ganze Fenster — die Auswahl von
       * heute, rückwärts angewandt. Am 09.09.2026 kippte genau das ein Urteil:
       * dieselbe Strategie über dieselben Jahre bei 0,71 / −0,18 / 0,04, je
       * nachdem, welcher Endkorb rückwärts galt.
       *
       * Ohne Kandidatenpool oder ungepoolt wirkt der Schalter nicht; der
       * Bericht sagt es dann.
       */
      foldMembership: z.enum(['point_in_time', 'fixed']).default('point_in_time'),
      /**
       * Festkandidaten: vorregistrierte Parametersätze, die OHNE Suche durch
       * dieselben Folds (Korb je Fold), denselben Holdout und dieselben Gates
       * laufen wie die gesuchten Strategien und in derselben Liste um die
       * Beförderung konkurrieren — kein Sonderweg nach oben. `params` sind
       * Abweichungen von den Strategie-Defaults und müssen im `paramSpace`
       * liegen (sonst ein Fehler-Eintrag der Einheit, kein Absturz); `label`
       * ist der Name im Bericht. Ohne Suche gibt es keine Trials: Der
       * Deflated Sharpe ist bei ihnen „nicht anwendbar" (wie beim
       * Amtsinhaber), alle anderen Gates gelten in voller Schärfe.
       *
       * `tier` trennt zwei Latten, beide im Code (Prüfbefund K1/M15,
       * 09.09.2026): `alpha` (Vorgabe) ist das Obige. `basis` ist die
       * Basis-Allokation — Marktexposition mit Trendfilter als Standard
       * statt „nichts": EINE durchgehende Simulation über die ganze
       * OOS-Kette (Positionen über Fold-Grenzen, ein Buch, ein Peak, kein
       * IS-Fenster), gemessen an der Gate-Gruppe `basis` gegen den
       * liegengelassenen Korb (`optimizer.basis`). Ein Basis-Kandidat läuft
       * NICHT durch die zehn Alpha-Gates und wird nie Alpha-Champion; sein
       * Ergebnis steht als eigener Block `basis` in der Champion-Datei.
       * Höchstens ein Basis-Kandidat je Config, nur auf festem Korb.
       */
      fixedCandidates: z
        .array(
          z.object({
            strategy: z.string().min(1),
            params: z.record(z.string(), z.number()).default({}),
            label: z.string().min(1).optional(),
            tier: z.enum(['alpha', 'basis']).default('alpha'),
          }),
        )
        .default([]),
      /**
       * Basis-Latte: die Gate-Gruppe `basis` für Festkandidaten mit
       * `tier: basis` (robustness.ts, `basisGates`). Das ist die ausführbare
       * Form der Vorregistrierung — Schwellen, die nach dem Lauf geändert
       * werden, sind eine neue Version, keine Korrektur. Der Maßstab ist
       * Kaufen-und-Halten des Korbs, gleichgewichtet, ohne Kosten, über
       * DIESELBE Range wie die durchgehende Simulation; SPY nur im Bericht.
       *
       * Warum je Einheit Exposure (Prüfbefund K2): Eine Basis, die die
       * halbe Zeit in Kasse steht, hat automatisch den halben Drawdown —
       * ein roher MaxDD-Vergleich misst dann Exposure, nicht Regel. Netto
       * bei Kosten × `stressCostMultiplier` gehört zum Netto-Gate.
       */
      basis: z
        .object({
          /** MaxDD / mittlere Exposure ≤ (1 − dieser Anteil) × MaxDD des Korbs liegenlassen. */
          minDrawdownReduction: z.number().min(0).max(1).default(0.25),
          /** Sharpe p. a. ≥ dieser Faktor × Sharpe des Korbs liegenlassen (Korb ≤ 0 ⇒ Basis > 0 genügt). */
          minSharpeRatio: z.number().min(0).default(0.9),
          /** Gebühren gesamt / |Netto| höchstens dieser Anteil. */
          maxCostShare: z.number().min(0).default(0.1),
          /**
           * Sizing-Semantik der Basis (Prüfbefund K4): Position = dieser
           * Anteil der Equity je Symbol (`SizingSpec` allocation), im
           * Optimierer UND in der Engine — `riskPerTradePct` ist für die Basis
           * ohne Wirkung. 20 % entsprechen der Vorregistrierung V2 (Risiko
           * 4 % bei Stop 20 %); die Messung mit positionPct 20 liefert
           * dieselben Stückzahlen wie 4 %/20 %-Stop (test/backtest/allokation).
           * Der Wert steht im Block `basis` der Champion-Datei und gilt dort.
           */
          positionPct: z.number().gt(0).max(100).default(20),
        })
        .default({ minDrawdownReduction: 0.25, minSharpeRatio: 0.9, maxCostShare: 0.1, positionPct: 20 }),
      /**
       * Eigener Korb der Basis-Allokation. Leer (Vorgabe): Der Basis-Kandidat
       * wird auf der Einheit des Laufs gemessen — nur bei festem Korb. Gesetzt:
       * Der Basis-Kandidat bekommt eine EIGENE Einheit „Basis (n Symbole)" mit
       * genau diesen Symbolen, festem Korb (keine Zugehörigkeit je Fold),
       * eigener Bars-Ladung (`fetchSymbols` lädt sie mit) und der Benchmark
       * wie bisher; die Alpha-Einheiten bleiben unverändert und dürfen ihren
       * Korb je Fold behalten. So misst die Plattform ihren Alpha-Korb mit
       * Korb je Fold und die Basis auf ihrem vorregistrierten Korb — in einem
       * Lauf. Der Block `basis` der Champion-Datei nennt diese Symbole.
       * Kein Tor: Der Korb ist Teil der Vorregistrierung, nicht der Bewertung.
       */
      basisUniverse: z.array(z.string().min(1)).max(50).default([]),
      /**
       * Ensembles: mehrere Sleeves als EINE Einheit, gemessen in EINER
       * Portfolio-Simulation über dieselben Folds, mit denselben Kosten,
       * demselben Stress und durch dieselben zehn Alpha-Gates
       * (`optimize/ensemble.ts`, Vorregistrierung
       * `docs/wissen/vorregistrierung/2026-09-12-ensemble.md`).
       *
       * Warum es das gibt: Der Optimierer messe jede Familie EINZELN und
       * verwerfe jede EINZELN. `momentum_pullback` hat Trades und Ertrag,
       * aber keine Beständigkeit (`fold_positive_share` 0,500,
       * `fold_concentration` 0,647); `vigilant_allocation` hat Beständigkeit,
       * aber 27 statt 60 Trades. Genau die zwei Mängel, die diese Gates
       * messen, bessert Diversifikation mechanisch — wenn die Quellen
       * wirklich unabhängig sind. Sind sie es nicht, besteht das Ensemble
       * nicht, und das ist die richtige Antwort.
       *
       * KEINE dritte Latte (§0.9): Ein Ensemble ist ein KANDIDAT für die
       * bestehende Alpha-Latte. Kein Gate, keine Schwelle wird dafür
       * angefasst, und es gibt keine Suche — Zusammensetzung, Parameter und
       * Gewichtsregel stehen vor dem Lauf fest. Die Gewichtsregel ist eine
       * REGEL, kein Parameter: `equal` oder `inverse_vol` (Anteil ∝ 1/σ über
       * ein Fenster von 60 Handelstagen; die 60 sind vorregistriert und
       * stehen als Konstante im Code, nicht hier).
       */
      ensembles: z
        .array(
          z.object({
            /** Name im Bericht und im Journal — je Config eindeutig. */
            label: z.string().min(1),
            /** `equal`: jeder Sleeve derselbe Anteil. `inverse_vol`: Anteil ∝ 1/σ der eigenen Renditen (Fenster 60 Handelstage, fest). */
            weighting: z.enum(['equal', 'inverse_vol']).default('equal'),
            sleeves: z
              .array(
                z.object({
                  strategy: z.string().min(1),
                  /** Vorregistrierte Abweichungen von den Strategie-Defaults; müssen im `paramSpace` liegen. */
                  params: z.record(z.string(), z.number()).default({}),
                  label: z.string().min(1).optional(),
                  /**
                   * `korb`: der liquiditätsgewählte Korb je Fold der Einheit
                   * (Punkt-in-Zeit, wie jeder Aktien-Kandidat). `fixed`: genau
                   * die Symbole aus `symbols` — die Bühne, die ein defensiver
                   * Sleeve braucht, weil der nach Dollarumsatz rangierte Korb
                   * bauartbedingt kein defensives Papier enthält (Lauf #43).
                   */
                  universe: z.enum(['korb', 'fixed']).default('korb'),
                  symbols: z.array(z.string().min(1)).max(50).default([]),
                }),
              )
              .min(2),
          }),
        )
        .max(8)
        .default([]),
    })
    .default({
      strategies: ['trend_donchian', 'momentum_pullback', 'mean_reversion'],
      lookbackDays: 400,
      isDays: 120,
      oosDays: 30,
      stepDays: 30,
      embargoBars: 0,
      samples: 150,
      seed: 42,
      minOosTrades: 60,
      minFoldPositiveShare: 0.6,
      objective: 'sortino',
      stressCostMultiplier: 1.5,
      holdoutDays: 60,
      promotionMargin: 0.1,
      minPsrOos: 0.9,
      dsrIsGate: false,
      riskFreeSymbol: null,
      maxFoldNetShare: 0.5,
      pooled: false,
      foldMembership: 'point_in_time',
      fixedCandidates: [],
      basis: { minDrawdownReduction: 0.25, minSharpeRatio: 0.9, maxCostShare: 0.1, positionPct: 20 },
      basisUniverse: [],
      ensembles: [],
    }),
  costs: z
    .object({
      /** Slippage je Seite in Basispunkten (Marktorder gegen den Spread). */
      slippageBps: z.number().min(0).default(3),
      /** Halber Spread je Seite in Basispunkten. */
      spreadBps: z.number().min(0).default(2),
      /** SEC-Gebühr auf Verkaufserlöse (Satz, jährlich angepasst). */
      secFeeRate: z.number().min(0).default(0.0000278),
      /** FINRA TAF je verkaufter Aktie, gedeckelt. */
      finraTafPerShare: z.number().min(0).default(0.000166),
      finraTafMax: z.number().min(0).default(8.3),
      /** Krypto-Taker-Gebühr in %. */
      cryptoTakerPct: z.number().min(0).default(0.25),
      /** Leihkosten Short p. a. in %. */
      shortBorrowAnnualPct: z.number().min(0).default(1),
    })
    .default({
      slippageBps: 3,
      spreadBps: 2,
      secFeeRate: 0.0000278,
      finraTafPerShare: 0.000166,
      finraTafMax: 8.3,
      cryptoTakerPct: 0.25,
      shortBorrowAnnualPct: 1,
    }),
  engine: z
    .object({
      /** Abgleich Buch ↔ Broker alle X Sekunden. */
      reconcileEverySec: z.number().int().min(10).default(60),
      /** Karenz nach Bucket-Ende, bis die letzte Minuten-Bar da ist. */
      barGraceSec: z.number().int().min(0).max(60).default(4),
      /** Ohne frische Daten (Sekunden) keine neuen Einstiege. */
      maxDataAgeSec: z.number().int().min(10).default(180),
      /** Nach X Fehlern in Folge Halt (errors). */
      maxConsecutiveErrors: z.number().int().min(1).default(5),
      /** Fremde Positionen beim Broker (nicht im Buch): adopt = übernehmen mit Schutz-Stop, halt = keine Einstiege. */
      onOrphan: z.enum(['adopt', 'halt']).default('halt'),
    })
    .default({ reconcileEverySec: 60, barGraceSec: 4, maxDataAgeSec: 180, maxConsecutiveErrors: 5, onOrphan: 'halt' }),
  notify: z
    .object({
      telegram: z.boolean().default(false),
    })
    .default({ telegram: false }),
  status: z
    .object({
      /** 0 = kein HTTP-Status. */
      httpPort: z.number().int().min(0).max(65535).default(0),
    })
    .default({ httpPort: 0 }),
  paths: z
    .object({
      /** State, Journal, Bars-Cache, Champion, Reports. AUTOTRD_HOME überschreibt. */
      home: z.string().min(1).default('./var'),
    })
    .default({ home: './var' }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type RiskConfig = Config['risk'];
export type SessionConfig = Config['session'];
export type CostConfig = Config['costs'];
export type OptimizerConfig = Config['optimizer'];
/** Ein Festkandidat aus `optimizer.fixedCandidates`. */
export type FixedCandidateConfig = OptimizerConfig['fixedCandidates'][number];
/** Schwellen der Basis-Latte (`optimizer.basis`). */
export type BasisConfig = OptimizerConfig['basis'];
/** Eine Ensemble-Einheit (`optimizer.ensembles`) — mehrere Sleeves, EINE Simulation, dieselben zehn Gates. */
export type EnsembleConfig = OptimizerConfig['ensembles'][number];
/** Ein Sleeve einer Ensemble-Einheit. */
export type SleeveConfig = EnsembleConfig['sleeves'][number];
/** Rohform VOR den Defaults — was eine YAML-Datei oder ein Test hinschreibt. */
export type ConfigInput = z.input<typeof ConfigSchema>;
export type OptimizerInput = NonNullable<ConfigInput['optimizer']>;
export type FixedCandidateInput = NonNullable<OptimizerInput['fixedCandidates']>[number];

/* ───────────────────────── Umgebung ───────────────────────── */

export interface Env {
  ALPACA_API_KEY: string;
  ALPACA_SECRET_KEY: string;
  ALPACA_ALLOW_LIVE: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  AUTOTRD_HOME: string;
}

/** Minimaler .env-Parser (KEY=VALUE, #-Kommentare, optionale Anführungszeichen). Überschreibt vorhandene Variablen NICHT. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function loadEnv(dotenvPath = '.env', base: NodeJS.ProcessEnv = process.env): Env {
  const merged: Record<string, string | undefined> = { ...base };
  if (existsSync(dotenvPath)) {
    const parsed = parseDotenv(readFileSync(dotenvPath, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (merged[k] === undefined || merged[k] === '') merged[k] = v;
    }
  }
  return {
    ALPACA_API_KEY: merged.ALPACA_API_KEY ?? '',
    ALPACA_SECRET_KEY: merged.ALPACA_SECRET_KEY ?? '',
    ALPACA_ALLOW_LIVE: merged.ALPACA_ALLOW_LIVE ?? '0',
    TELEGRAM_BOT_TOKEN: merged.TELEGRAM_BOT_TOKEN ?? '',
    TELEGRAM_CHAT_ID: merged.TELEGRAM_CHAT_ID ?? '',
    AUTOTRD_HOME: merged.AUTOTRD_HOME ?? '',
  };
}

/* ───────────────────────── Laden & Guards ───────────────────────── */

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Ausschließlichkeit des Parksymbols (risk/parken.ts): Es gehört der Treasury
 * ALLEIN. Führte eine Strategie dasselbe Symbol, lägen zwei Positionen mit
 * zwei Herkünften in einem Symbol — zwei Besitzer einer Menge, zwei
 * Exit-Regeln, und §0.6 (Idempotenz an der logischen Einheit) hätte keine
 * Einheit mehr. Zur Laufzeit fängt `decide()` den Fall (Rückzug, letzte
 * Verteidigungslinie), aber der Regelfall gehört beim Start abgelehnt: laut
 * ist billiger als still.
 *
 * Geprüft wird gegen JEDE Liste, aus der eine Strategie ein Symbol bekommt —
 * nicht nur gegen `universe.symbols`/`universe.candidates`: Auch der eigene
 * Korb der Basis-Allokation (`optimizer.basisUniverse`) und die
 * vorregistrierten Sleeve-Universen eines Ensembles (`optimizer.ensembles`)
 * werden gehandelt. Ein Geldmarkt-Pol im Sleeve hieße genau die
 * Doppelführung, die dieser Absatz verhindert (config/ensemble-1440.yaml
 * hält BIL im defensiven Sleeve — deshalb kann BIL DORT nicht geparkt
 * werden, und deshalb gibt es config/parken-1440.yaml ohne Ensemble).
 *
 * Das ZINSSYMBOL (`optimizer.riskFreeSymbol`) steht bewusst nicht unter
 * dieser Regel: Es erzeugt keine Position, sondern nur eine Renditereihe,
 * also gibt es nichts, was zwei Besitzer haben könnte. Es DARF gehandelt
 * werden (genau der Fall, für den es gebaut wurde: ein Geldmarktpapier im
 * Korb, gegen dessen Zins gemessen wird — Befund B2), und es darf seit
 * 13.09.2026 auch außerhalb des Pools stehen, weil `fetchSymbols` es eigens
 * lädt. Ist es DASSELBE Symbol wie das Parksymbol, gilt für beide die Regel
 * hier — ein Symbol, eine Rolle.
 */
function pruefeParksymbol(cfg: Config): void {
  const park = cfg.risk.cashParking.symbol;
  if (park === null) return;
  const rolle = cfg.optimizer.riskFreeSymbol === park ? 'Park- und Zinssymbol' : 'Parksymbol';
  const fundorte: string[] = [];
  if (cfg.universe.symbols.includes(park)) fundorte.push('universe.symbols');
  if (cfg.universe.candidates?.includes(park)) fundorte.push('universe.candidates');
  if (cfg.optimizer.basisUniverse.includes(park)) fundorte.push('optimizer.basisUniverse');
  for (const e of cfg.optimizer.ensembles) {
    for (const s of e.sleeves) {
      if (s.symbols.includes(park)) fundorte.push(`optimizer.ensembles „${e.label}" · ${s.strategy}`);
    }
  }
  if (fundorte.length > 0) {
    throw new ConfigError(
      `risk.cashParking.symbol ${park} (${rolle}) steht im Handelsuniversum: ${fundorte.join(', ')} — ` +
        'das Parksymbol ist Infrastruktur und darf keine Strategie führen, sonst gäbe es zwei Positionen mit zwei Herkünften in einem Symbol. ' +
        'Seine Bars lädt `fetch` eigens (src/app.ts, `fetchSymbols`); es gehört in KEINE dieser Listen.',
    );
  }
  if (cfg.universe.benchmark === park) {
    throw new ConfigError(`risk.cashParking.symbol ${park} ist zugleich universe.benchmark — der Maßstab wird nicht gehandelt, das Parksymbol schon.`);
  }
}

export function parseConfig(raw: unknown): Config {
  const res = ConfigSchema.safeParse(raw ?? {});
  if (!res.success) {
    const msg = res.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('\n  ');
    throw new ConfigError(`Config ungültig:\n  ${msg}`);
  }
  const cfg = res.data;
  if (cfg.optimizer.stepDays !== cfg.optimizer.oosDays) {
    // Größer ⇒ Lücken in der OOS-Kette; kleiner ⇒ dieselben OOS-Tage zählen mehrfach
    // (Red-Team: bei step 10 / oos 30 wären Trades und PSR-n um ×2,75 aufgeblasen).
    throw new ConfigError('optimizer.stepDays muss gleich optimizer.oosDays sein (lückenlose, überlappungsfreie OOS-Kette).');
  }
  // EIN Basis-Block in der Champion-Datei, EIN Basis-Kandidat je Config: Zwei
  // Basis-Kandidaten hießen „die bessere von zweien" — das wäre eine Suche
  // durch die Hintertür, die die Vorregistrierung gerade ausschließt.
  const basisKandidaten = cfg.optimizer.fixedCandidates.filter((fc) => fc.tier === 'basis');
  if (basisKandidaten.length > 1) {
    throw new ConfigError(
      `optimizer.fixedCandidates: höchstens EIN Festkandidat mit tier: basis (gefunden ${basisKandidaten.length}) — ` +
        'eine zweite Variante ist eine neue Vorregistrierung, kein Vergleich im selben Lauf.',
    );
  }
  // Der eigene Basis-Korb: kanonische Schreibweise wie das Universum, ohne
  // Duplikate — und nur mit Basis-Kandidat. Ein Korb ohne Kandidat misst
  // nichts und stünde stumm in der Config; laut ist besser.
  if (cfg.optimizer.basisUniverse.length > 0) {
    if (basisKandidaten.length === 0) {
      throw new ConfigError('optimizer.basisUniverse ohne Festkandidat mit tier: basis — ein Basis-Korb ohne Basis-Kandidat misst nichts.');
    }
    cfg.optimizer.basisUniverse = [...new Set(cfg.optimizer.basisUniverse.map((s) => normalizeUserSymbol(s, cfg.universe.assetClass)))];
    // Der Korb der Basis gehört in den Kandidatenpool (Prüfbefund M11): Was der
    // Block `basis` der Champion-Datei später als Korb nennt, muss aus dem Pool
    // stammen, den nur ein Commit ändert — sonst schriebe der Optimierer das
    // gehandelte Universum am Pool vorbei. `candidates` enthält immer
    // `symbols`; ohne Pool (Config ohne `candidates`) ist der Korb eine eigene
    // Einheit und wird nicht geprüft.
    if (cfg.universe.candidates) {
      const pool = new Set(cfg.universe.candidates);
      const fremd = cfg.optimizer.basisUniverse.filter((s) => !pool.has(s));
      if (fremd.length > 0) {
        throw new ConfigError(
          `optimizer.basisUniverse außerhalb des Kandidatenpools (universe.candidates ∪ universe.symbols): ${fremd.join(', ')} — ` +
            'der Basis-Korb muss aus dem Pool stammen, den nur ein Commit ändert.',
        );
      }
    }
  }
  // Zins- und Parksymbol sind INFRASTRUKTUR: `fetchSymbols` (app.ts) lädt sie
  // eigens, neben Universum, Benchmark und Kandidatenpool. Hier wird nur die
  // Schreibweise vereinheitlicht; geprüft wird am Ende (`pruefeParksymbol`),
  // wenn auch Basis-Korb und Sleeves normiert sind.
  //
  // Bis zum 13.09.2026 MUSSTE `optimizer.riskFreeSymbol` im Kandidatenpool
  // stehen, weil `fetch` sonst seine Bars nicht lud. Zusammen mit der
  // Ausschließlichkeit des Parksymbols (das NICHT im Pool stehen darf) hieß
  // das: Zins- und Parksymbol konnten nie dasselbe Papier sein, und die
  // Differenz ihrer Laufzeit und Kostenquote wäre in die Überschussrendite
  // gelaufen. Seit die Bars eigens geladen werden, dürfen sie gleich sein
  // (Vorgabe BIL) — und dann gibt es zwischen ihnen keinen Spread.
  if (cfg.optimizer.riskFreeSymbol !== null) {
    cfg.optimizer.riskFreeSymbol = normalizeUserSymbol(cfg.optimizer.riskFreeSymbol, cfg.universe.assetClass);
  }
  if (cfg.risk.cashParking.symbol !== null) {
    cfg.risk.cashParking.symbol = normalizeUserSymbol(cfg.risk.cashParking.symbol, cfg.universe.assetClass);
  }
  // Ensembles: Die Zusammensetzung IST die Vorregistrierung, also muss sie
  // eindeutig sein. Jede Regel hier schließt eine stille Mehrdeutigkeit aus,
  // die hinterher wie ein Messergebnis aussähe.
  const ensembleLabels = new Set<string>();
  for (const e of cfg.optimizer.ensembles) {
    if (ensembleLabels.has(e.label)) {
      throw new ConfigError(`optimizer.ensembles: das Label „${e.label}" kommt zweimal vor — Ensembles werden im Bericht und im Journal über ihr Label geführt.`);
    }
    ensembleLabels.add(e.label);
    // Eine Strategie je Ensemble höchstens einmal: `korbSchluessel` (core/logic.ts)
    // trennt die Sleeves zwar schon über die Parameter, aber die Zurechnung von
    // Trades und Netto im Bericht läuft über die Strategie-ID — zweimal dieselbe
    // ID hieße, zwei Sleeves nicht mehr auseinanderhalten zu können.
    const ids = e.sleeves.map((s) => s.strategy);
    const doppelt = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (doppelt.length > 0) {
      throw new ConfigError(
        `optimizer.ensembles „${e.label}": die Strategie ${[...new Set(doppelt)].join(', ')} steht mehrfach in den Sleeves — ` +
          'Beitrag und Trades je Sleeve werden über die Strategie-ID zugerechnet und wären dann nicht trennbar.',
      );
    }
    // Höchstens EIN Sleeve auf dem liquiditätsgewählten Korb: Zwei würden sich
    // um dieselben Symbole streiten, und ein Symbol kann in einer Simulation
    // nur EINE Strategie tragen (`SimInput.strategyFor`).
    const aufKorb = e.sleeves.filter((s) => s.universe === 'korb');
    if (aufKorb.length > 1) {
      throw new ConfigError(
        `optimizer.ensembles „${e.label}": ${aufKorb.length} Sleeves auf dem Korb (universe: korb) — ` +
          'ein Symbol kann in einer Simulation nur eine Strategie tragen; höchstens ein Sleeve darf den Korb bekommen.',
      );
    }
    const belegt = new Map<string, string>();
    for (const s of e.sleeves) {
      if (s.universe === 'korb') {
        if (s.symbols.length > 0) {
          throw new ConfigError(`optimizer.ensembles „${e.label}" · ${s.strategy}: universe: korb UND symbols gesetzt — der Korb je Fold kommt aus universe.candidates, nicht aus einer Liste.`);
        }
        continue;
      }
      if (s.symbols.length === 0) {
        throw new ConfigError(`optimizer.ensembles „${e.label}" · ${s.strategy}: universe: fixed ohne symbols — ein Sleeve ohne Universum misst nichts.`);
      }
      s.symbols = [...new Set(s.symbols.map((x) => normalizeUserSymbol(x, cfg.universe.assetClass)))];
      for (const sym of s.symbols) {
        const anderer = belegt.get(sym);
        if (anderer !== undefined) {
          throw new ConfigError(
            `optimizer.ensembles „${e.label}": ${sym} steht bei ${anderer} UND bei ${s.strategy} — ` +
              'ein Symbol gehört genau einem Sleeve; wer es zweimal nennt, misst nicht, was er zu messen glaubt.',
          );
        }
        belegt.set(sym, s.strategy);
      }
      // Dieselbe Regel wie für `basisUniverse` (Prüfbefund M11): Was gehandelt
      // wird, stammt aus dem Pool, den nur ein Commit ändert — und `fetch` lädt
      // nur, was im Pool steht.
      if (cfg.universe.candidates) {
        const pool = new Set(cfg.universe.candidates);
        const fremd = s.symbols.filter((x) => !pool.has(x));
        if (fremd.length > 0) {
          throw new ConfigError(
            `optimizer.ensembles „${e.label}" · ${s.strategy}: ${fremd.join(', ')} steht nicht im Kandidatenpool ` +
              '(universe.candidates ∪ universe.symbols) — der Sleeve-Korb muss aus dem Pool stammen, den nur ein Commit ändert, sonst lädt `fetch` seine Bars nicht.',
          );
        }
      }
    }
  }
  pruefeParksymbol(cfg);
  // Tiefe Historie nur dort, wo sie billig ist. Intraday bleibt bei 2000 Tagen:
  // 4000 Tage × 78 Bars × 30 Symbole wären rund 9 Mio. Bars je Lauf — der
  // Optimierer liefe ins Speicherlimit, und zwar erst nach dem Datenladen.
  if (cfg.timeframe !== 1440 && cfg.optimizer.lookbackDays > INTRADAY_LOOKBACK_MAX) {
    throw new ConfigError(
      `optimizer.lookbackDays ${cfg.optimizer.lookbackDays} ist für Zeitrahmen ${cfg.timeframe} min zu tief ` +
        `(höchstens ${INTRADAY_LOOKBACK_MAX}). So viel Intraday-Historie sprengt den Speicher; für tiefe Messungen Tagesbars nehmen.`,
    );
  }
  return cfg;
}

/** Tiefste Historie, die ein Intraday-Zeitrahmen laden darf (Kalendertage). */
export const INTRADAY_LOOKBACK_MAX = 2000;

export function loadConfigFile(path: string): Config {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new ConfigError(`Config-Datei nicht gefunden: ${abs}`);
  const text = readFileSync(abs, 'utf8');
  const raw: unknown = parseYaml(text);
  return parseConfig(raw);
}

export type EffectiveMode = 'paper' | 'live';

export interface ModeResolution {
  mode: EffectiveMode;
  /** Warum ggf. auf Paper herabgestuft wurde. */
  reasons: string[];
}

/**
 * Der Doppel-Guard. Gibt NIE 'live' zurück, wenn nicht alle drei Bedingungen
 * erfüllt sind. Wirft, wenn ein Live-Key gegen Paper laufen würde.
 */
export function resolveMode(cfg: Config, env: Env): ModeResolution {
  const reasons: string[] = [];
  const wantsLive = cfg.broker.mode === 'live';
  const allow = env.ALPACA_ALLOW_LIVE === '1';
  const key = env.ALPACA_API_KEY;
  const isLiveKey = key.startsWith('AK');
  const isPaperKey = key.startsWith('PK');

  let mode: EffectiveMode = 'paper';
  if (wantsLive && allow && isLiveKey) {
    mode = 'live';
  } else {
    if (wantsLive && !allow) reasons.push('ALPACA_ALLOW_LIVE ist nicht 1 — Paper.');
    if (wantsLive && allow && !isLiveKey) reasons.push('Kein Live-Key (AK…) — Paper.');
  }
  if (mode === 'paper' && isLiveKey) {
    throw new ConfigError(
      'Live-Key (AK…) konfiguriert, aber Betrieb wäre Paper. Paper-Keys (PK…) eintragen oder alle drei Live-Bedingungen erfüllen.',
    );
  }
  if (mode === 'paper' && key && !isPaperKey) {
    reasons.push('Key-Präfix unbekannt (weder PK noch AK) — wird als Paper behandelt.');
  }
  return { mode, reasons };
}

export function homeDir(cfg: Config, env: Env): string {
  return resolve(env.AUTOTRD_HOME || cfg.paths.home);
}
