/**
 * autotrd — geteilte Typen (Firestore-Schema + Strategie).
 *
 * EINZIGE WAHRHEIT für das Strategie-Schema: FLACH, wie in CLAUDE.md §2 —
 * broker / watchlist / engine / indicators / signals. Niemals verschachteln
 * (strategy.type/indices/risk_management/execution ist die bekannte kaputte
 * Alt-Variante). Frontend UND Functions importieren von hier.
 */

import { MIN_EDGE_MULTIPLE } from './costGate.js';

// ── Strategie (users/{uid}.settings.strategy) ────────────────────────────────

export interface BrokerConfig {
  provider: 'paper' | 'alpaca';
  /** 'live' wird nur wirksam mit serverseitigem Freigabe-Flag (M8). */
  mode: 'paper' | 'live';
  initialCapital: number;
  paperTrading: boolean;
  /**
   * Basis der Positionsgröße (Owner-Feedback 26.07.: „Cash, der nicht
   * arbeitet, bringt nichts"): 'balance' = maxPositionPct vom VERFÜGBAREN
   * Cash — das Wallet arbeitet weiter, auch wenn schon Positionen offen
   * sind. 'initial' = fixe Tranche vom Startkapital (Referenz-Verhalten);
   * scheitert still, sobald der Rest-Cash die Tranche nicht mehr deckt.
   * Fehlend = 'balance' (der Sinn eines Auto-Traders ist, dass er handelt).
   */
  sizingBase?: 'initial' | 'balance';
  /**
   * Hebel der Kaufkraft (Owner-Wunsch 28.07.). Fehlend oder 1 = KEIN Hebel,
   * also strikt bar gedeckt wie bisher; die Risiko-Hülle klemmt bei
   * MAX_LEVERAGE (3). Wirksam wird er nur bei hoher Überzeugung
   * (`effectiveLeverage`, Owner-Vorgabe: „nur wenn der Algorithmus sich sehr
   * sicher ist") und immer zusammen mit Nachschussgrenze und Margin-Zinsen —
   * siehe margin.ts, warum diese drei Dinge untrennbar sind.
   */
  leverage?: number;
}

/**
 * Risiko-Parameter einer Position. Getrennt vom Rest der EngineConfig, weil
 * sie ab MA6 auch PRO ASSET-KLASSE gelten können (Krypto schwankt anders als
 * ein Index) — `engine.byClass.crypto.stopLossPct` überschreibt dann global.
 */
export interface RiskConfig {
  stopLossPct: number;
  takeProfitPct: number;
  /**
   * Nachziehender Stop in % vom höchsten Kurs seit Einstieg (0 = aus).
   * Der wichtigste Ausstiegs-Mechanismus für Trendphasen: Ein starres
   * Take-Profit verkauft zu früh, ein starrer Stop lässt Gewinne
   * zurücklaufen. Greift zusätzlich zu Stop/Take.
   */
  trailingStopPct?: number;
  /**
   * Stop-Abstand als Vielfaches der ATR(14) statt fixer Prozent (0 = aus).
   * Passt sich automatisch an Instrument UND Marktphase an: bei 2 % Stop
   * ist BTC (±4 % Tagesrange) reines Rauschen, ein Index (±0,6 %) dagegen
   * ein echtes Signal. Hat Vorrang vor stopLossPct, wenn gesetzt.
   */
  atrStopMult?: number;
  /** Take-Profit als ATR-Vielfaches (0 = aus, sonst Vorrang vor takeProfitPct). */
  atrTakeMult?: number;
  /** Zwangsausstieg nach N Kalendertagen Haltedauer (0 = aus) — bindet sonst Kapital. */
  maxHoldDays?: number;
}

export interface EngineConfig extends RiskConfig {
  checkIntervalMin: number;
  maxPositionPct: number;
  /** Auto-Trading-Schalter (Dashboard Start/Stop). */
  running: boolean;
  /**
   * Kauf-Pause nach einem Verkauf desselben Symbols in Minuten (Whipsaw-
   * Schutz). Fehlend = 60; die Risiko-Hülle klemmt auf 5–1440 — unter dem
   * 5-min-Scan-Takt wäre die Pause wirkungslos. Kleiner = mehr Trades.
   */
  cooldownMin?: number;
  /**
   * Mindest-Haltedauer in Minuten, bevor ein SIGNAL-Ausstieg greifen darf.
   * Fehlend = 60, 0 schaltet sie ab; die Hülle klemmt auf 0–1440.
   *
   * Stop-Loss, Trailing-Stop und Take-Profit bleiben davon UNBERÜHRT — eine
   * Haltefrist darf das Sicherheitsnetz niemals aushebeln. Sie bremst nur
   * den Signal-Ausstieg, der sonst jede Position im nächsten Rauschen
   * wieder ausspuckt (Owner-Auswertung 27.07.).
   */
  minHoldMin?: number;
  /**
   * Gleichzeitig offene Positionen (Owner-Frage 28.07.: „kann man die Anzahl
   * der maximal aktiven Trades irgendwo einstellen? habe es nicht in den
   * Optionen gefunden"). Konnte man nicht — der Wert stand fest im Code.
   * Fehlend = 10 (bisheriges Verhalten); die Hülle klemmt auf 1–30.
   */
  maxOpenPositions?: number;
  /**
   * Welche Maschine dieses Wallet handelt (Hantel-Umbau 28.07.).
   *
   * 'confluence' (Default, bisheriges Verhalten): der 5-Minuten-Scan aus
   * RSI/MACD/Bollinger + Prognose bzw. der Regelbaum.
   *
   * 'momentum': Cross-Sectional Momentum über den ganzen handelbaren
   * Katalog — Top 8 gleichgewichtet, WÖCHENTLICH umgeschichtet, mit
   * SMA200-Marktfilter. Der Scan lässt dieses Wallet dann komplett in Ruhe.
   *
   * Warum es ein Entweder-oder ist und kein Nebeneinander: Zwei Maschinen
   * auf einem Wallet würden sich gegenseitig die Positionen wegverkaufen —
   * der Scan sähe eine Momentum-Position ohne Signal und schlösse sie.
   * Die gemischte Aufteilung (Hantel) braucht eine Besitzkennzeichnung je
   * Position — die gibt es seit 04.08. als `Position.core`, siehe `corePct`.
   */
  mode?: 'confluence' | 'momentum';
  /**
   * KERN-SATELLIT (Owner-Direktive 04.08.: „eine stabile sichere Art und
   * Weise langsam eine positive Performance zu erreichen"): Anteil des
   * Eigenkapitals in %, der als ruhiger Momentum-SOCKEL geführt wird.
   *
   * Der Anlass war eine Messung, keine Idee. Am 04.08. stand der
   * Momentum-Schatten bei +4,0 % seit dem 28.07. — mit NULL Trades im
   * letzten Lauf —, während die vier Konfluenz-Konten zwischen −3,2 % und
   * −6,3 % lagen. Die Konfluenz-Engine war dabei brutto sogar leicht
   * positiv (+122 $); erlegt haben sie die Gebühren (2.865 $ auf 471
   * Trades). Kosten sind prozentual, also hilft keine größere Position —
   * nur weniger und größere Bewegungen. Genau das ist der Sockel.
   *
   * Mechanik: `momentumRun` schichtet `equity × corePct/100` monatlich in
   * die Top-Momentum-Werte (SMA200-Marktfilter: im Abwärtsmarkt Cash) und
   * stempelt die Positionen mit `core: true`. Der 5-Minuten-Scan fasst
   * diese Positionen NICHT an — weder Exit noch Positionslimit. Was der
   * Sockel bindet, fehlt der aktiven Engine als Cash; sie schrumpft also
   * von selbst mit, ohne dass irgendwo eine zweite Grenze gepflegt werden
   * müsste.
   *
   * 0 = aus (reine Konfluenz, bisheriges Verhalten). Die Hülle klemmt auf
   * 0–90 — ein Rest bleibt immer für den aktiven Teil und die Gebühren.
   */
  corePct?: number;
  /**
   * Anteil des Eigenkapitals, der bei einem ausgelösten Stop verloren gehen
   * darf, in % (0 = aus, dann gilt die klassische Prozent-Tranche).
   *
   * Schaltet die Positionsgröße von „10 % des Depots" auf „gleicher
   * Risikobeitrag je Position" um: Ein ruhiger Titel bekommt dann eine
   * größere Tranche als ein volatiler, und beide verlieren im Stop-Fall
   * denselben Betrag. `maxPositionPct` bleibt als harte Obergrenze stehen.
   * Typisch 0,5 bis 1. Siehe riskSizing.ts.
   */
  riskPerTradePct?: number;
  /**
   * Bis zu welchem Stand der Exit-Umbau (MX, 09.08.) an diesem Konto
   * gelaufen ist. Fehlend = nie. Siehe `exitUmbauPlan` am Dateiende: Das
   * Feld ist der Grund, warum die Migration genau einmal greift und eine
   * spätere Lockerung durch den Nutzer stehen bleibt.
   */
  exitUmbauStand?: number;
  /**
   * Risiko-Overrides je Asset-Klasse (Katalog-Schlüssel aus universe.ts:
   * crypto, indices, stocks_us, …). Fehlende Felder erben von oben.
   */
  byClass?: Record<string, Partial<RiskConfig>>;
  /**
   * Kapital-Regler je Anlageklasse (04.08.): 0 = aus, 1 = normal,
   * bis 1,5 = verstärkt. Fehlende Klassen gelten als 1.
   *
   * Warum ein Regler und kein Schalter: Die Klassen-Messung vom 04.08.
   * zeigt Kanten von −0,41 % bis +0,81 % je gehandeltem Dollar — dazwischen
   * liegt alles. Ein Faktor kann das abbilden, ein Schalter nicht. Er läuft
   * über denselben `sizeFactor` wie das Überzeugungs-Sizing und ist mit ihm
   * gemeinsam gedeckelt; zusammen können sie die Klumpengrenze also nicht
   * aushebeln.
   *
   * WICHTIG: Gewicht 0 stoppt nur die AUSFÜHRUNG. Signale und Schatten-P&L
   * entstehen weiter, damit eine abgeschaltete Klasse messbar bleibt und
   * sich zurückverdienen kann. Ohne das wäre jedes Abschalten endgültig —
   * dieselbe Zirkularität wie beim Live-Reife-Gate.
   */
  classWeights?: Record<string, number>;
  /**
   * Auto-Regler: zieht `classWeights` selbsttätig nach, wenn die gemessene
   * Kante es belegt (`shared/src/classAdvisor.ts`).
   *
   * **Standard AN seit 09.08. (Owner-Go).** Vorher aus — die Umstellung hat
   * einen konkreten Anlass: Die Erkenntnis-Chronik führte am 09.08. belegt,
   * dass `etf_thematic` über 58 Trades −0,76 % je Dollar verliert, und der
   * Bericht schlug vor, die Klasse zu drosseln. Nur passierte nichts, weil
   * jemand den Vorschlag hätte anklicken müssen. Eine Messung, die niemanden
   * erreicht, ist keine Verbesserung — und der Owner-Auftrag lautet
   * „minimale User-Interaktion".
   *
   * Der Regler bleibt dabei so vorsichtig wie zuvor: Er bewegt sich in
   * Schritten von 0,25 statt zu springen, rührt eine Klasse ohne Beleg gar
   * nicht an, protokolliert jede Bewegung in `classLog`, und der Schatten
   * misst weiter — eine abgeschaltete Klasse kann zurückkommen.
   *
   * `undefined` zählt als AN; wer ihn nicht will, wählt ihn im Options-Modal
   * ausdrücklich ab (`false`). Diese Lesart ist der Grund, warum es keine
   * Standard-Konstante gibt: Ein fehlendes Feld soll dasselbe bedeuten wie
   * ein neu angelegtes Konto.
   */
  classAutoTune?: boolean;
  /**
   * Tages-Verlustgrenze in Prozent des Vortags-Eigenkapitals (M12).
   *
   * Der Stop-Loss schützt eine Position; diese Grenze schützt den Tag. 0 oder
   * fehlend = aus. Bei Erreichen werden EINSTIEGE gesperrt; bestehende
   * Ausstiege laufen weiter (siehe `shared/src/circuitBreaker.ts`).
   */
  dailyLossLimitPct?: number;
  /**
   * Beim Auslösen zusätzlich alle Positionen schließen? Standard aus — ein
   * Zwangsverkauf realisiert Buchverluste zum schlechtesten Zeitpunkt.
   */
  flattenOnBreach?: boolean;
}

export interface RsiConfig {
  enabled: boolean;
  window: number;        // 14
  thresholdBuy: number;  // 30
  thresholdSell: number; // 70
}

export interface MacdConfig {
  enabled: boolean;
  crossoverBuy: boolean;
}

export interface BollingerConfig {
  enabled: boolean;
  bbBreakoutPct: number; // 95
}

export interface IndicatorsConfig {
  rsi: RsiConfig;
  macd: MacdConfig;
  bollinger: BollingerConfig;
}

export interface SignalsConfig {
  /** Stimmen, die ein EINSTIEG braucht. */
  minConfluence: number;
  period: string; // z. B. '3mo'
  useForecast: boolean;
  forecastWeight: number;
  forecastThresholdPct: number;
  /**
   * Stimmen, die ein AUSSTIEG aus einer offenen Position braucht
   * (Default: eine weniger als der Einstieg, mindestens 1).
   *
   * Bewusst asymmetrisch: Ein verpasster Einstieg kostet eine Chance, ein
   * verpasster Ausstieg kostet Geld. Vorher galt dieselbe Schwelle für
   * beides — zusammen mit der Gleichstandsregel blockierten RSI und
   * Bollinger (die in fallenden Märkten „überverkauft, also kaufen" sagen)
   * genau dann den Verkauf, wenn er nötig gewesen wäre.
   */
  exitConfluence?: number;
  /**
   * Darf die Prognose die Konfluenz IM ALLEINGANG reißen? Default false.
   *
   * Mit forecastWeight 2 und minConfluence 2 entschied bisher die Prognose
   * allein — die „Konfluenz aus drei Indikatoren" war ein Etikett. Bei
   * false wird ihr Gewicht beim Einstieg auf (minConfluence − 1) gedeckelt,
   * mindestens eine echte Indikator-Stimme muss also dazukommen. Beim
   * AUSSTIEG zählt sie immer voll (Risiko-Asymmetrie).
   */
  forecastSolo?: boolean;
  /**
   * Zeitbasis der Signal-Berechnung (Owner-Auftrag 26.07.: „Tradefrequenz
   * deutlich erhöhen"): 'intraday' rechnet RSI/MACD/Bollinger und den
   * Regelbaum auf 5-MINUTEN-Kerzen — Signale drehen dann im Takt des
   * 5-min-Scans statt alle paar Tage. 'daily' ist die ruhige Tages-Sicht.
   * Fehlend = 'intraday' (der Sinn eines Auto-Traders ist, dass er handelt);
   * die Prognose-Stimme nutzt dann die Kurzfrist-Prognose (nächste Stunde).
   * Ehrlicher Hinweis: Mehr Trades = mehr Gebühren (0,1 % + Slippage je
   * Ausführung) — Paper-Trading ist der Ort, das gefahrlos zu erleben.
   */
  timeframe?: 'daily' | 'intraday';
  /**
   * Leerverkäufe erlauben (Owner-Wunsch 26.07.): Ein VERKAUFS-Signal ohne
   * Position eröffnet dann einen Short (verdient am fallenden Kurs), ein
   * KAUF-Signal deckt ihn ein. Default false — bewusst Opt-in: Beim Short
   * sind Verluste theoretisch unbegrenzt (der Kurs kann beliebig steigen);
   * im Paper-Trading begrenzen Stop-Loss und die 25-%-Notbremse real.
   */
  allowShort?: boolean;
  /**
   * Wie viel die erwartete Bewegung über den Handelskosten liegen muss
   * (Befund 28.07.). Fehlend = MIN_EDGE_MULTIPLE (3); 0 schaltet die
   * Kostenschwelle ab.
   *
   * Der Grund steht in costGate.ts: Über 297 Live-Trades waren die Gebühren
   * das 2,7-Fache des Brutto-Ergebnisses. Wir haben um Beträge gehandelt,
   * die in der Größenordnung der Reibung lagen.
   */
  minEdgeMultiple?: number;
  /**
   * Kostenschwelle mit EINFANGQUOTE rechnen (04.08.).
   *
   * Die bisherige Schwelle vergleicht die erwartete BEWEGUNG mit den Kosten
   * und ließ deshalb praktisch alles durch — Bewegung ist aber kein Gewinn.
   * Mit dieser Option zählt stattdessen der Anteil der Bewegung, den die
   * Signale der jeweiligen Anlageklasse erfahrungsgemäß einfangen
   * (`captureForClass`).
   *
   * Standard AN seit dem 13.08. (Task 94, Owner-Direktive „Kosten
   * Minimierung"): AUS war die richtige Vorsicht, solange die Schwelle mit
   * falschen ATR-Einheiten ohnehin nie blocken KONNTE und der
   * Schattenzähler deshalb nichts aussagte. Beides hat sich geändert — die
   * Einheiten stimmen (costGate, HOCH-4-Fix), der Schattenzähler
   * (`entryGate.kante_wuerde_blocken`) schlug sofort an, und die
   * Klassen-Attribution belegt live, was die Schwelle verhindert hätte:
   * Krypto −625 $ bei 1 316 $ Gebühren, Forex −245 $, Kante −0,15 bis
   * −0,32 %. `false` bleibt das ausdrückliche Opt-out je Konto.
   */
  captureGate?: boolean;
  /**
   * News-Veto (News-Rückkehr 29.07.): Frische harte Ereignisse (Earnings,
   * Klage, Guidance, M&A, Führungswechsel) sperren NEUE Einstiege in das
   * Symbol für einige Stunden — um solche Termine springen Kurse, und die
   * technische Analyse ist genau dann am wenigsten wert. Ausstiege bleiben
   * immer frei. Quellen sind gratis RSS-Feeds plus Wortlisten-Lexikon;
   * es fließt kein einziger KI-Token. Fehlend = an (das Veto kann Trades
   * nur verhindern, nie erzeugen — die sichere Voreinstellung ist AN).
   */
  newsVeto?: boolean;
  /**
   * Regime-Ampel Stufe 2 (04.08.): Der gemessene Marktzustand sperrt
   * Einstiege, die gegen ihn laufen — im Aufwärtstrend keine Shorts, im
   * Stress gar keine neuen Einstiege. Begründung samt Messung an
   * `regimeEntryBlocked` in regime.ts.
   *
   * Fehlend = an. Dieselbe Logik wie beim News-Veto: Die Regel kann Trades
   * nur verhindern, nie erzeugen — die sichere Voreinstellung ist AN.
   */
  regimeGate?: boolean;
}

export interface Strategy {
  broker: BrokerConfig;
  /** Katalog-Symbole (yfinance-Konventionen: '^NDX', 'BTC-USD', 'EURUSD=X'). */
  watchlist: string[];
  engine: EngineConfig;
  indicators: IndicatorsConfig;
  signals: SignalsConfig;
}

/** Watchlist-Obergrenze je User — Kosten-Guard: jedes Symbol kostet bei
 *  jedem 5-min-Scan echte Fetches/Writes (global deckelt MAX_SCAN_SYMBOLS). */
/** Engine-Volltiefe je Symbol (5-min-Scan: Kurs+Indikatoren+News+Intraday) —
 *  der Deckel begrenzt Fetches/Writes, NICHT die Daten (Katalog-Versorgung
 *  liefert allen ~166 Symbolen Kurse+Tageskerzen). 25.07. von 12 auf 20
 *  angehoben (User-Wunsch; Kosten skalieren linear und bleiben klein). */
export const MAX_WATCHLIST = 20;

/**
 * Obergrenze für `engine.maxOpenPositions`.
 *
 * Warum überhaupt eine: Offene Positionen werden dem Scan-Set UNGEDECKELT
 * hinzugefügt (eine Position ohne frischen Kurs verlöre ihren Stop-Loss) —
 * die Zahl treibt also direkt die Fetch- und Schreiblast jedes Scans. Und der
 * 1-Minuten-Puls beobachtet 60 Symbole über ALLE Konten; wer allein 50
 * Positionen hält, drängt die der anderen aus dem schnellen Ausstieg.
 *
 * 30 ist der Kompromiss: mehr als genug für ein breit gestreutes Depot
 * (bei 3 % je Position wäre es voll investiert), ohne dass ein einzelnes
 * Konto den Takt für alle anderen bestimmt.
 */
export const MAX_OPEN_POSITIONS_CAP = 30;
/** Voreinstellung, wenn `engine.maxOpenPositions` fehlt (Altbestand). */
export const DEFAULT_MAX_OPEN_POSITIONS = 10;

/**
 * Obergrenze für `engine.corePct` (Kern-Satellit, 04.08.).
 *
 * 90 statt 100: Ein Rest muss immer beim aktiven Teil bleiben. Bei 100 %
 * hätte das Konto kein Cash mehr für Gebühren, für den Nachkauf beim
 * Rebalancing und für jeden manuellen Trade — der Sockel wäre dann kein
 * Sockel mehr, sondern das ganze Haus. Wer das will, stellt `mode` auf
 * 'momentum'; das ist der ehrliche Schalter dafür.
 */
export const CORE_PCT_CAP = 90;
/**
 * Voreinstellung des Sockel-Anteils für NEUE Konten.
 *
 * 60 % ist keine gerundete Meinung, sondern folgt der Messung vom 04.08.:
 * Der Momentum-Sockel stand bei +4,0 % (6 Tage, null Trades im letzten
 * Lauf), die aktive Konfluenz bei −3,2 bis −6,3 % — brutto war sie dabei
 * +122 $, die Gebühren (2.865 $ auf 471 Trades) haben sie erlegt. Das
 * Kapital gehört also mehrheitlich in den ruhigen Teil, ohne den aktiven
 * abzuschaffen: Er bleibt die Suchmaschine für die seltenen guten
 * Gelegenheiten und darf sich weiter beweisen.
 *
 * Bestandskonten ohne das Feld bleiben bei 0 (kein Sockel) — eine
 * Kapitalumschichtung passiert nie stillschweigend.
 */
export const DEFAULT_CORE_PCT = 60;

export const DEFAULT_STRATEGY: Strategy = {
  broker: {
    provider: 'paper',
    mode: 'paper',
    initialCapital: 25_000,
    paperTrading: true,
    sizingBase: 'balance',
    // Hebel bewusst AUS im Standard: Er verstärkt Verluste genauso wie
    // Gewinne, und ein Konto, das ihn nie eingeschaltet hat, soll auch nie
    // liquidiert werden können.
    leverage: 1,
  },
  // Nur HANDELBARES (Befund 28.07.): Hier stand `^NDX` — der Nasdaq-100-
  // INDEX, den kein Broker verkauft. Seit dem Handelbarkeits-Filter fällt er
  // ohnehin aus der Tiefenanalyse, stand aber weiter als Voreinstellung in
  // jedem neuen Konto und sah aus wie ein Vorschlag. SPY statt dessen: breiter
  // US-Markt, echtes Instrument, und keine Dopplung zu QQQ (das IST bereits
  // der Nasdaq-100 als ETF).
  watchlist: ['QQQ', 'SPY', 'AAPL', 'TSLA'],
  engine: {
    checkIntervalMin: 5,
    maxPositionPct: 10,
    stopLossPct: 2,
    takeProfitPct: 4,
    // Nachziehender Stop ist AN (3 %): Ohne ihn schließt eine Position nur
    // beim starren Take-Profit oder beim Stop — in Trendphasen also fast nie.
    trailingStopPct: 3,
    /* Bleibt bei 0 (unbegrenzt) — und das ist ein Fund aus dem Exit-Umbau
     * vom 09.08., kein Versehen.
     *
     * Der erste Entwurf setzte hier 10 Tage: Wenn der Signal-Ausstieg
     * schwerer feuert, sollte eine Position, die weder Ziel noch Stop
     * erreicht, nicht ewig Kapital binden. Die Testsuite hat sofort
     * widersprochen — mehrere Exit-Tests meldeten `max_hold` statt `null`.
     *
     * Der Grund dahinter wiegt schwerer als der Nutzen: `maxHoldDays` misst
     * die Haltedauer AB EINSTIEG, nicht ab Einführung. Eine Obergrenze
     * einzuschalten hieße also, beim nächsten Scan jede Position zu
     * schließen, die älter ist als die neue Grenze — ein Massenverkauf
     * quer durch alle Konten, mit Gebühren auf jede einzelne Position, und
     * das ohne jeden Bezug zu ihrer Aussicht.
     *
     * Wer eine Frist will, setzt sie im Options-Modal bewusst. Der
     * gemessene Hebel ist ohnehin ein anderer (der Signal-Ausstieg). */
    maxHoldDays: 0,
    running: false,
    // Kauf-Pause und Mindest-Haltedauer standen auf „maximale Frequenz"
    // (15 min bzw. gar nicht). Die Auswertung zweier Testkonten am 27.07.
    // zeigte, warum das nicht trägt: Ø-Gewinn 0,49 %, Ø-Verlust 0,36 %,
    // bei 0,30 % Roundtrip-Kosten — die Reibung fraß 54 % bzw. 86 % des
    // Verlusts. Mehr Frequenz hilft nur, wenn jeder Trade Luft über der
    // Kostenschwelle hat.
    cooldownMin: 60,
    /* 60 → 1440 (Owner-Go 09.08.), und die Begründung ist eine Rechnung.
     *
     * Aus 317 Trades: Trefferquote 32,5 %, Gewinn/Verlust-Verhältnis 1,18.
     * Daraus folgt ein Erwartungswert von −0,29 Verlusteinheiten je Trade
     * und ein KELLY-EINSATZ VON −24,6 % — der optimale Einsatz ist negativ,
     * jede Erhöhung von Kapital, Hebel oder Frequenz vergrößert also den
     * erwarteten Verlust. Ein System in diesem Zustand kann man nicht
     * größer machen, nur reparieren.
     *
     * Wo es klemmt, sagt die Ausstiegs-Statistik eindeutig: 275 von 317
     * Trades (86,8 %) enden am Signal, und dort gewinnt nur jeder vierte
     * (26,9 %). Wer dagegen sein ZIEL erreicht, gewinnt ausnahmslos —
     * 26 von 26 —, aber nur acht Prozent kommen je dort an. Die
     * Richtungslogik ist nicht das Problem (die Signale treffen mit 52,8 %
     * über 523 Messungen besser als der Zufall); der Ausstieg schneidet die
     * Gewinner ab, bevor sie welche werden.
     *
     * Bei `timeframe: 'daily'` ist ein Tagessignal die Einheit — es 60
     * Minuten später durch eine gekippte Stimme zu widerrufen, verwirft die
     * Information, bevor sie sich zeigen konnte. Ein Tag Mindesthaltedauer
     * gibt ihr genau eine Kerze Zeit.
     *
     * NEBENEFFEKT, bewusst in Kauf genommen: `costGate` rechnet die
     * erwartete Bewegung aus ATR × √Kerzen und benutzt dafür die
     * Mindesthaltedauer. Mit 1440 statt 60 Minuten steigt die erwartete
     * Bewegung, die Kostenschwelle lässt also mehr durch. Das ist keine
     * Aufweichung, sondern die korrekte Physik: Wer länger hält, hat
     * tatsächlich mehr Bewegung zur Verfügung.
     */
    minHoldMin: 1440,
    maxOpenPositions: 10,
    mode: 'confluence', // Momentum ist Opt-in — siehe EngineConfig.mode
    // Kern-Satellit (04.08.): NEUE Konten starten mit ruhigem Sockel.
    // Begründung samt Messung an DEFAULT_CORE_PCT.
    corePct: DEFAULT_CORE_PCT,
    /* Tages-Notbremse für NEUE Konten (04.08.).
     *
     * Ein Sicherheitsnetz, das standardmäßig aus ist, schützt niemanden —
     * und der Moment, in dem jemand es einschalten würde, ist genau der,
     * in dem er es vergisst.
     *
     * Warum 5 %: Bei zehn Positionen à 10 % und 3 % Stop kostet ein
     * vollständiges Ausstoppen rund 3 % des Depots. 5 % ist damit „ein
     * schlechter Tag plus Luft" — eng genug, um eine Verlustserie zu
     * stoppen, weit genug, um an einem normalen Tag nie zu greifen.
     *
     * BESTANDSKONTEN bleiben unberührt (fehlendes Feld = aus). Eine
     * Sperre rückwirkend über fremde Konten zu legen, wäre eine
     * Kapitalentscheidung ohne Auftrag; sie steht in den Einstellungen
     * und ist ein Klick.
     */
    dailyLossLimitPct: 5,
    // Volatilitäts-Realismus (MA6): Krypto und Rohstoffe brauchen weitere
    // Stops, sonst ist jeder normale Tagesausschlag ein Zwangsverkauf.
    // Werte grob an typischen Tagesranges orientiert; per UI änderbar.
    byClass: {
      crypto: { stopLossPct: 6, takeProfitPct: 10, trailingStopPct: 7 },
      commodities: { stopLossPct: 4, takeProfitPct: 7, trailingStopPct: 5 },
      forex: { stopLossPct: 1, takeProfitPct: 2, trailingStopPct: 1.5 },
      indices: { stopLossPct: 1.5, takeProfitPct: 3, trailingStopPct: 2.5 },
      rates_bonds: { stopLossPct: 1, takeProfitPct: 2, trailingStopPct: 1.5 },
    },
  },
  indicators: {
    rsi: { enabled: true, window: 14, thresholdBuy: 30, thresholdSell: 70 },
    macd: { enabled: true, crossoverBuy: true },
    bollinger: { enabled: true, bbBreakoutPct: 95 },
  },
  signals: {
    minConfluence: 2,
    period: '1y',
    useForecast: true,
    forecastWeight: 2,
    forecastThresholdPct: 0.5,
    /* 1 → 2 (30.07.) → 3 (09.08., Owner-Go). Zweite Verschärfung derselben
     * Stelle, und diesmal in die Asymmetrie hinein.
     *
     * Bei 2 war der Ausstieg genauso leicht wie der Einstieg: Dieselben zwei
     * Stimmen, die eine Position eröffnen, schließen sie wieder. Auf einem
     * Markt, der sich nicht bewegt hat, genügt dafür ein Rauschen — und die
     * Messung zeigt, was dabei herauskommt: 86,8 % aller Trades enden am
     * Signal, mit 26,9 % Trefferquote.
     *
     * Bei 3 muss der Markt deutlicher widersprechen: entweder alle drei
     * Indikatoren, oder die Prognose (Gewicht 2, beim AUSSTIEG immer voll
     * gezählt) plus eine echte Indikator-Stimme. Einsteigen bei zwei,
     * aussteigen erst bei drei — die Position bekommt den Zweifel.
     *
     * Das Sicherheitsnetz bleibt davon unberührt: Stop, Trailing-Stop und
     * Take-Profit laufen in JEDEM Scan vor dieser Prüfung. Gebremst wird
     * ausschließlich das Rausspucken durch eine gekippte Indikator-Stimme,
     * nie der Schutz vor Verlusten. */
    exitConfluence: 3,
    forecastSolo: false, // Prognose braucht eine zweite Stimme zum Einstieg
    // 'daily' seit 30.07. — die 5-min-Voreinstellung ist an der Realität
    // gescheitert: 525 Trades in zwei Handelstagen nach dem Reset, 97 %
    // davon am Signal-Ausstieg gestorben (Trefferquote dort 16,8 %),
    // Gebühren das 4,7-Fache des Brutto-Ergebnisses, Profitfaktor 0,18.
    // Auf 5-min-Kerzen kippt die Konfluenz im Rauschen; die Kostenschwelle
    // prüft erwartete BEWEGUNG, nicht erwarteten GEWINN — sie kann ein
    // Signal ohne Kante nicht retten. Bestandskonten behalten ihren
    // gespeicherten Wert; der Einstellungs-Prüfer legt ihnen den Wechsel
    // mit genau dieser Messung nahe.
    timeframe: 'daily',
    allowShort: false, // Leerverkäufe bewusst Opt-in (Options-Modal + ⓘ)
    minEdgeMultiple: MIN_EDGE_MULTIPLE, // Kostenschwelle AN (Befund 28.07.)
    newsVeto: true, // Einstiegs-Sperre bei frischen Hard-Events (News-Rückkehr 29.07.)
    // Einfangquote zählt mit (13.08., Task 94). Der Scan wertet `!== false`,
    // Bestandskonten ohne Feld sind also ebenfalls AN — der Eintrag hier
    // dokumentiert den Standard und macht ihn im gespeicherten Doc sichtbar.
    captureGate: true,
  },
};

/* ── Risiko-Auflösung je Asset-Klasse (MA6) ──────────────────────────────── */

/**
 * Effektive Risiko-Parameter für ein Symbol: globale Engine-Werte, von den
 * Klassen-Overrides (`engine.byClass[assetClass]`) feldweise überschrieben.
 * Pure Funktion — Engine, Backtest und UI müssen dieselbe Antwort bekommen.
 */
export function resolveRisk(engine: EngineConfig, assetClass?: string | null): RiskConfig {
  const base: RiskConfig = {
    stopLossPct: engine.stopLossPct,
    takeProfitPct: engine.takeProfitPct,
    ...(engine.trailingStopPct !== undefined ? { trailingStopPct: engine.trailingStopPct } : {}),
    ...(engine.atrStopMult !== undefined ? { atrStopMult: engine.atrStopMult } : {}),
    ...(engine.atrTakeMult !== undefined ? { atrTakeMult: engine.atrTakeMult } : {}),
    ...(engine.maxHoldDays !== undefined ? { maxHoldDays: engine.maxHoldDays } : {}),
  };
  const over = assetClass ? engine.byClass?.[assetClass] : undefined;
  if (!over) return base;
  const out: RiskConfig = { ...base };
  for (const k of ['stopLossPct', 'takeProfitPct', 'trailingStopPct', 'atrStopMult', 'atrTakeMult', 'maxHoldDays'] as const) {
    const v = over[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

/**
 * Mindesthalte-Böden je Anlageklasse (Hebel 1c des Rund-um-die-Uhr-Umbaus,
 * Owner 15.08.).
 *
 * Krypto: 2 Kalendertage. Die Zahl kommt aus der Messung, nicht aus
 * Geschmack: 146 Krypto-Trades zahlten 1.316 $ Gebühren auf +691 $ brutto —
 * die Klasse stirbt am UMSCHLAG, nicht an der Richtung. Ein Boden von zwei
 * Tagen halbiert die maximale Roundtrip-Frequenz gegenüber dem globalen
 * Default (1 Tag) und gibt jeder Position die √2-fache erwartete Bewegung
 * je Gebührenpaar (Random Walk, s. costGate).
 *
 * Der Boden bremst ausschließlich den SIGNAL-Ausstieg (minHoldActive) —
 * Stop, Trailing und Ziel laufen in jedem Scan davor und bleiben jederzeit
 * scharf. Er ist damit eine Anti-Umschlag-Bremse, kein Exit-Hindernis.
 *
 * Er greift auch dann, wenn User oder Auto-Tuner den globalen Wert senken:
 * Der Tuner optimiert über ALLE Klassen — genau dann braucht die
 * gebührenteuerste Klasse ihren eigenen Boden.
 */
export const KLASSEN_MINDESTHALTE: Record<string, number> = {
  crypto: 2880,
};

/**
 * Wirksame Mindest-Haltedauer eines Symbols: der User-Wert, auf den
 * Klassen-Boden ANGEHOBEN. Nur anhebend — der Boden kann den User-Wert nie
 * senken, und Klassen ohne Boden behalten exakt den User-Wert (auch 0 =
 * „Signal-Ausstieg sofort erlaubt").
 */
export function wirksameMindesthalte(
  minHoldMin: number | undefined,
  assetClass: string | undefined | null,
): number {
  const user =
    Number.isFinite(minHoldMin) && (minHoldMin as number) > 0 ? (minHoldMin as number) : 0;
  const boden = KLASSEN_MINDESTHALTE[(assetClass ?? '').toLowerCase()] ?? 0;
  return Math.max(user, boden);
}

/* ── Paper-Ausführungskosten (Realismus, User-Wunsch 25.07.) ────────────────
 * Gleiche Konditionen wie der Backtest: 0,1 % Kommission + 5 bp Slippage je
 * Seite. Angewendet als EFFEKTIVER Preis (buy teurer, sell billiger) in
 * executePaperTrade UND shadowTrade — Live-Buch und Schatten-Buch bleiben
 * im A/B-Duell vergleichbar. */
export const PAPER_COMMISSION_PCT = 0.001;
export const PAPER_SLIPPAGE_BPS = 5;
export const PAPER_FEE_RATE = PAPER_COMMISSION_PCT + PAPER_SLIPPAGE_BPS / 10_000;

/** Effektiver Ausführungspreis der Paper-Strecke (Kommission + Slippage). */
export function paperEffectivePrice(price: number, side: 'buy' | 'sell'): number {
  return side === 'buy' ? price * (1 + PAPER_FEE_RATE) : price * (1 - PAPER_FEE_RATE);
}

/* ── Klassenechte Kosten (Owner-Direktive 28.07.: „Kosten Minimierung") ─────
 *
 * Der Pauschalsatz oben (0,105 % je Seite) stammt aus der ersten
 * Paper-Strecke und ist für JEDE Klasse gleich — das ist an zwei Stellen
 * falsch, und beide verzerren die Auswertung:
 *
 *  - US-Aktien und ETFs kosten bei Alpaca **keine Kommission**. Wir haben
 *    sie dreimal zu teuer simuliert und damit funktionierende Aktien-
 *    Strategien künstlich schlechtgerechnet.
 *  - Krypto kostet dort **mehr** als 0,1 % je Seite. Die Auswertung vom
 *    27.07. lief fast nur auf Krypto — wir haben also ausgerechnet dort
 *    zu günstig gerechnet, wo die Engine tatsächlich handelte.
 *
 * Die Sätze sind bewusst eher pessimistisch als optimistisch: Eine
 * Strategie, die unter zu hoch angesetzten Kosten besteht, besteht auch
 * real. Umgekehrt gilt das nicht.
 */
export const CLASS_FEE_RATE: Record<string, number> = {
  stocks_us: 0.0005, // 0 Kommission, ~5 bp Slippage
  etf_sectors: 0.0005,
  etf_regions: 0.0005,
  etf_thematic: 0.0005,
  stocks_global: 0.0015, // Auslandsbörsen: Gebühr + weiterer Spread
  crypto: 0.0025, // Alpaca Krypto ~25 bp je Seite
  forex: 0.0003,
  commodities: 0.001, // Futures/Rohstoff-Proxys
  indices: 0.0005, // über ETF-Proxys handelbar
  rates_bonds: 0.0005,
};

/**
 * Dieselben Sätze, aufgeteilt in Kommission und Slippage (04.08.).
 *
 * Warum die Aufteilung überhaupt gespeichert wird: Steuerlich sind das zwei
 * verschiedene Dinge. Die Kommission ist Anschaffungsnebenkosten und mindert
 * den Gewinn; die Slippage ist Teil des erzielten Ausführungspreises. Aus der
 * SUMME allein lässt sich das später nicht mehr trennen — und schon gar nicht,
 * nachdem eine der Konstanten hier einmal geändert wurde.
 *
 * Die Zahlen folgen den Konditionen, gegen die wir messen: US-Aktien und ETFs
 * kosten bei Alpaca keine Kommission (nur Spread), Krypto kostet dort
 * Kommission und praktisch keinen zusätzlichen Abschlag.
 */
export interface FeeParts {
  /** Kommission je Seite — Anschaffungsnebenkosten, gewinnmindernd. */
  commission: number;
  /** Marktbedingter Ausführungsabschlag je Seite — Teil des Preises. */
  slippage: number;
}

export const CLASS_FEE_PARTS: Record<string, FeeParts> = {
  stocks_us: { commission: 0, slippage: 0.0005 },
  etf_sectors: { commission: 0, slippage: 0.0005 },
  etf_regions: { commission: 0, slippage: 0.0005 },
  etf_thematic: { commission: 0, slippage: 0.0005 },
  stocks_global: { commission: 0.001, slippage: 0.0005 },
  crypto: { commission: 0.0025, slippage: 0 },
  forex: { commission: 0, slippage: 0.0003 },
  commodities: { commission: 0.0005, slippage: 0.0005 },
  indices: { commission: 0, slippage: 0.0005 },
  rates_bonds: { commission: 0, slippage: 0.0005 },
};

/** Kommission/Slippage einer Klasse; unbekannt ⇒ Pauschalsatz aufgeteilt. */
export function feePartsForClass(assetClass?: string | null): FeeParts {
  const parts = assetClass ? CLASS_FEE_PARTS[assetClass] : undefined;
  return parts ?? { commission: PAPER_COMMISSION_PCT, slippage: PAPER_SLIPPAGE_BPS / 10_000 };
}

/** Gebührensatz JE SEITE für eine Asset-Klasse; unbekannt ⇒ Pauschalsatz. */
export function feeRateForClass(assetClass?: string | null): number {
  if (!assetClass) return PAPER_FEE_RATE;
  return CLASS_FEE_RATE[assetClass] ?? PAPER_FEE_RATE;
}

/* ── Maker-Sätze: was ein EINSTIEG wirklich kostet (17.08.) ─────────────────
 *
 * Seit Hebel 1b (15.08.) gehen Krypto-EINSTIEGE als Limit-Order zum
 * Entscheidungskurs raus (`broker.ts`, `alpacaOrder`). Alpaca berechnet dafür
 * den Maker-Satz — Tier 1: 0,15 % statt 0,25 % Taker. Exits bleiben Market
 * und zahlen weiter Taker; das ist Absicht und darf nie anders werden.
 *
 * ── Warum das nicht einfach `CLASS_FEE_RATE` ersetzt ──────────────────────
 *
 * Das BUCH soll konservativ bleiben. `effectivePriceForClass` bucht bewusst
 * den Taker-Satz auf beide Seiten („lieber zu viel Reibung einplanen als zu
 * wenig", s. broker.ts) — ein Limit, das im Wartefenster nicht füllt, wird
 * storniert, und ein Buch, das sich den günstigeren Satz gutschreibt, sähe
 * besser aus als die Realität. An diesem Buch hängen Trade-Filter, A/B-Duell
 * und Auto-Tuner. Es wird hier NICHT angefasst.
 *
 * Was diese Sätze bekommen, ist die MESSUNG: Der Signal-Schatten entscheidet,
 * ob eine abgeschaltete Klasse zurückkommen darf, und zieht dafür die
 * Roundtrip-Kosten ab. Rechnet er mit 2 × Taker, verlangt er von der
 * Signalquelle eine Reibung, die live nicht mehr anfällt — bei Krypto 0,50 %
 * statt 0,40 %. Eine Messung, die teurer rechnet als die Ausführung, hält
 * eine Klasse aus, die sich verdient hätte.
 */
export const CLASS_MAKER_FEE_RATE: Record<string, number> = {
  // Alpaca Krypto Tier 1: Maker 0,15 %. Nur hier eingetragen, weil nur hier
  // der Einstieg tatsächlich als Limit-Order läuft — ein Satz für eine
  // Order-Art, die es nicht gibt, wäre eine geschenkte Kostensenkung.
  crypto: 0.0015,
};

/**
 * Gebührensatz der EINSTIEGSSEITE: Maker, wo der Einstieg als Limit-Order
 * läuft, sonst derselbe Satz wie bisher.
 */
export function entryFeeRateForClass(assetClass?: string | null): number {
  const maker = assetClass ? CLASS_MAKER_FEE_RATE[assetClass] : undefined;
  return maker ?? feeRateForClass(assetClass);
}

/**
 * Roundtrip-Kosten einer Klasse: Einstieg (Maker, wo Limit läuft) + Ausstieg
 * (immer Taker, weil Exits Market bleiben).
 *
 * Bewusst eine eigene Funktion statt `feeRateForClass(k) * 2`: Der Faktor 2
 * war die stille Annahme, beide Seiten kosteten dasselbe. Seit Hebel 1b
 * stimmt sie für Krypto nicht mehr, und ein `* 2` an fünf Stellen wäre fünf
 * Gelegenheiten, die Korrektur an vier davon zu vergessen.
 */
export function roundtripFeeRateForClass(assetClass?: string | null): number {
  return entryFeeRateForClass(assetClass) + feeRateForClass(assetClass);
}

/** Effektiver Ausführungspreis mit klassenechtem Satz. */
export function effectivePriceForClass(
  price: number,
  side: 'buy' | 'sell',
  assetClass?: string | null,
): number {
  const rate = feeRateForClass(assetClass);
  return side === 'buy' ? price * (1 + rate) : price * (1 - rate);
}

/**
 * Buchungspreis bei einem ECHTEN Broker-Fill (M13) — nur Kommission.
 *
 * `effectivePriceForClass` schätzt zwei Dinge auf einmal: die Kommission, die
 * der Broker berechnet, und die Slippage, also den Abstand zwischen gesehenem
 * Kurs und tatsächlicher Ausführung. Kommt ein echter Fill zurück, ist die
 * Slippage keine Schätzung mehr — sie IST der Unterschied zwischen `req.price`
 * und dem gemeldeten Kurs. Sie ein zweites Mal aufzuschlagen würde sie doppelt
 * buchen und jede Kanten-Messung um bis zu 5 Basispunkte je Seite verzerren.
 *
 * Die Kommission bleibt drin, obwohl das Alpaca-Papierkonto keine berechnet.
 * Das ist bewusst konservativ: Das Buch soll die Kosten zeigen, die bei
 * Echtgeld anfallen — sonst sähe die Kante im Papierbetrieb besser aus als
 * sie ist, und genau daran hängen Trade-Filter, A/B-Duell und Auto-Tuner.
 */
export function effectivePriceFromFill(
  fillPrice: number,
  side: 'buy' | 'sell',
  assetClass?: string | null,
): number {
  const c = feePartsForClass(assetClass).commission;
  return side === 'buy' ? fillPrice * (1 + c) : fillPrice * (1 - c);
}

// ── Geteilte Marktdaten (market/{symbol}/**, nur Functions schreiben) ────────

export interface Quote {
  price: number;
  changePct: number;
  updatedAt: string; // ISO
}

/** Doc-ID: YYYY-MM-DD */
export interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Doc-ID: YYYY-MM-DD */
export interface IndicatorSnapshot {
  rsi: number | null;
  macd: { line: number; signal: number; histogram: number } | null;
  bollinger: { upper: number; middle: number; lower: number; pctB: number } | null;
}

export type SignalDirection = 'buy' | 'sell' | 'hold';

/** Doc-ID: scanId (ISO-Timestamp des Scans) */
export interface SignalDoc {
  direction: SignalDirection;
  confluence: number;
  votes: Partial<Record<'rsi' | 'macd' | 'bollinger' | 'forecast', SignalDirection>>;
  price: number;
}

/**
 * Doc-ID: `${baseDate}_${w}_${lookback}` — der fachliche Schlüssel ersetzt den
 * SQLite-UNIQUE-Index (idempotente Writes, keine Doppel-Logs).
 * evalForecasts bewertet NUR wenn der letzte Horizont-Tag strikt vor heute
 * liegt UND sein Close realisiert ist (Lookahead-Gate — niemals aufweichen!).
 */
export interface ForecastDoc {
  baseDate: string; // YYYY-MM-DD
  baseClose: number;
  lookback: number;
  horizonDays: number;
  dailyVol: number;
  points: Array<{ time: string; value: number }>;
  /** Prognostizierte Änderung zum Horizont-Ende in % (für den Engine-Vote). */
  predictedPct: number;
  madeAt: string;
  /** false bis zur Bewertung — Query-Feld für evalForecasts. */
  evaluated: boolean;
  evaluatedAt?: string;
  maePct?: number;
  dirHit?: boolean;
  nPoints?: number;
  /**
   * Sentiment-Schatten (News-Rückkehr 29.07.): Vorzeichen der News-Lage zum
   * Prognosezeitpunkt (−1/0/1). Stimmt NICHT mit — die Bewertung zählt nur
   * nach meta/sentimentStats, ob das Vorzeichen die Richtung getroffen hätte.
   * Erst wenn diese realisierte Quote die Beweislast trägt, darf ein
   * späterer Umbau daraus eine Stimme machen.
   */
  sentSign?: number;
  /** News-Sentiment (−1..1) zum Prognosezeitpunkt — Rohwert zum sentSign. */
  sentVal?: number;
}

// ── User-Daten (users/{uid}/**) ──────────────────────────────────────────────

export interface Wallet {
  paperBalance: number;
  currency: 'USD';
  updatedAt: string;
  /** Schnittmarke des letzten Resets — Kennzahlen gelten „seit hier". */
  resetAt?: string;
  /**
   * Kapitalbasis der Gesamt-P&L: Equity − baseCapital ist die einzige
   * Gesamtzahl, die NICHT davon abhängt, wie viele Trade-Seiten die
   * Oberfläche gerade geladen hat (Owner-Fund 29.07.: „Gesamt-P&L ändert
   * sich, wenn ich ältere Trades anzeige"). Wird beim Anlegen und bei jedem
   * Reset gestempelt; Bestandskonten ohne das Feld fallen auf
   * broker.initialCapital zurück.
   */
  baseCapital?: number;
}

/** Doc-ID: symbol */
export interface Position {
  symbol: string;
  qty: number;
  avgEntry: number;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: string;
  /**
   * Höchster Kurs seit Einstieg — Bezugspunkt des nachziehenden Stops.
   * Wird bei jedem Scan fortgeschrieben; fehlt er (Altbestand), gilt der
   * Einstand, der Trailing-Stop startet dann konservativ.
   * Bei SHORT-Positionen ist das Pendant `lowWater` zuständig.
   */
  highWater?: number | null;
  /**
   * Leerverkauf (Owner-Wunsch 26.07., „auch schorten"): 'short' verdient am
   * FALLENDEN Kurs. Fehlend = 'long' (additiv, Altbestand bleibt gültig).
   * Beim Short sind Stop (über dem Einstand) und Take (darunter) gespiegelt.
   */
  side?: 'long' | 'short';
  /** Tiefster Kurs seit Short-Einstieg — Bezugspunkt des Short-Trailings. */
  lowWater?: number | null;
  /**
   * Steckbrief des Einstiegs (Trade-Filter 31.07.): Anlageklasse ×
   * Zeitrahmen × Signal-Signatur × Seite (× Regime). Beim ÖFFNEN gestempelt,
   * beim Schließen zählt der realisierte P&L in die globale Lernstatistik
   * (meta/tradeFilter) — kein Lookahead: nur geschlossene Trades füttern sie.
   */
  bucket?: string;
  /**
   * SOCKEL-Position des Kern-Satelliten (04.08., siehe `engine.corePct`).
   *
   * Diese Kennzeichnung ist die Besitzgrenze zwischen den zwei Maschinen auf
   * EINEM Wallet: `true` heißt „gehört dem Momentum-Sockel". Der
   * 5-Minuten-Scan lässt solche Positionen vollständig in Ruhe — kein
   * Signal-Exit, kein Stop, kein Trailing, und sie zählen nicht gegen
   * `maxOpenPositions`. Sonst verkaufte der Scan beim nächsten Rauschen
   * genau das weg, was der Sockel ruhig halten soll.
   *
   * Fehlend = normale Position der aktiven Engine (Altbestand bleibt gültig).
   */
  core?: boolean;
  /**
   * Diese Position liegt WIRKLICH beim Broker (M13, 05.08.).
   *
   * Die Kennzeichnung trennt zwei Dinge, die sonst verschmelzen und dabei
   * echtes Geld kosten würden:
   *
   *   1. Sie entscheidet, ob der SCHLIESSENDE Auftrag geroutet wird. Eine
   *      Position, die vor dem Verbinden im eigenen Buch entstand, kennt der
   *      Broker nicht — ein Verkaufsauftrag dafür würde dort keinen Bestand
   *      auflösen, sondern einen LEERVERKAUF eröffnen. Genau einmal falsch
   *      geroutet, und das Konto trägt ein Risiko, das niemand wollte.
   *
   *   2. Sie ist die Grundlage des Abgleichs. Verglichen wird nur, was beide
   *      Seiten führen sollten; sonst meldete jedes Konto mit Altbestand
   *      dauerhaft Drift, und die Meldung wäre wertlos.
   *
   * Fehlend = reine Buch-Position (Normalfall, Altbestand bleibt gültig).
   */
  broker?: boolean;
  /** Order-Kennung des ÖFFNENDEN Fills beim Broker — Brücke ins Depot. */
  brokerOrderId?: string;
  /**
   * Schutz-Stop beim BROKER (Bracket Stufe 1, 06.08.).
   *
   * Eine echte GTC-Stop-Order im Depot, die die 5-MINUTEN-LÜCKE schließt:
   * Bisher prüfte nur der Scan die Stops — zwischen zwei Scans war die
   * Position beim Broker ungeschützt. Der Schutz-Stop spiegelt die
   * PROZENT-Stops der Engine (Stop-Loss + Trailing, den engeren von
   * beiden) und wird vom Scan nachgezogen; die Engine bleibt die primäre
   * Exit-Instanz. WICHTIG: Vor jedem eigenen Exit MUSS die Order storniert
   * werden — Alpaca reserviert die Stücke für die offene Stop-Order, ein
   * Verkauf daran vorbei wird abgelehnt. Fehlend = kein Broker-Stop
   * (Buch-Position, Bruchstück, ATR-only oder Anlage fehlgeschlagen).
   */
  schutz?: { orderId: string; stopPreis: number; qty: number } | null;
}

export interface Trade {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  executedAt: string;
  source: 'engine' | 'manual';
  paper: boolean;
  /* ── Nachvollziehbarkeit (04.08.) ────────────────────────────────────────
   * Alle folgenden Felder sind optional: Altbestand bleibt ohne sie gültig.
   * Sie stehen hier, weil sie sich später NICHT mehr rekonstruieren lassen —
   * eine Katalog-Änderung verschiebt die Anlageklasse rückwirkend, und eine
   * geänderte Gebühren-Konstante macht jede nachträgliche Aufteilung falsch. */
  /** Anlageklasse ZUM ZEITPUNKT des Trades (nicht die heutige). */
  assetClass?: string;
  /** Notierungswährung des Instruments — der Kontostand ist in USD geführt. */
  currency?: string;
  /** Kommissionssatz je Seite (Anschaffungsnebenkosten). */
  commissionRate?: number;
  /** Slippage-Satz je Seite (Teil des Ausführungspreises). */
  slippageRate?: number;
  /** Gesamte Ausführungskosten dieses Trades in Kontowährung. */
  fee?: number;
  /* ── Anschaffungsbezug, nur an SCHLIESSENDEN Trades ───────────────────── */
  /** Einstandskurs der geschlossenen Position. */
  entryPrice?: number;
  /** Eröffnungszeitpunkt der geschlossenen Position (ISO). */
  acquiredAt?: string;
  /**
   * Haltedauer in Tagen. Heute noch aus Kauf/Verkauf paarbar — aber nur,
   * WEIL Nachkauf verboten und jeder Verkauf ganz ist. Sobald es Teilverkäufe
   * gibt, ist die Zuordnung alter Trades nicht mehr eindeutig.
   */
  holdingDays?: number;
}

/* ── Exit-Umbau (MX, Owner-Go 09.08.) ────────────────────────────────────
 *
 * Die neuen Voreinstellungen oben gelten für NEUE Konten. Bestandskonten
 * haben ihre Werte gespeichert und behielten sonst genau die Einstellung,
 * die zu Kelly = −24,6 % geführt hat — der Umbau träfe niemanden, der ihn
 * nötig hat.
 *
 * Warum das eine Migration rechtfertigt: Der Zusammenhang ist gemessen,
 * nicht vermutet (275 von 317 Trades sterben am Signal, Trefferquote dort
 * 26,9 %, gegenüber 26 von 26 gewonnenen Ziel-Exits), und der Owner hat das
 * sofortige Scharfschalten ausdrücklich angeordnet.
 *
 * Sie greift trotzdem so zurückhaltend wie möglich:
 *   · Sie VERSCHÄRFT nur. Wer bereits länger hält oder mehr Gegenstimmen
 *     verlangt als der neue Standard, behält seinen Wert.
 *   · Sie läuft genau einmal je Konto (`exitUmbauStand`) und rührt danach
 *     nichts mehr an. Wer den Ausstieg anschließend wieder lockert, tut das
 *     bewusst, und diese Entscheidung bleibt stehen.
 *   · Sie fasst kein Sicherheitsnetz an: Stop, Trailing-Stop und Take-Profit
 *     bleiben unverändert und laufen in jedem Scan vor der Signalprüfung.
 */

/** Stand der Exit-Migration. Höher zählen ⇒ sie läuft je Konto erneut. */
export const EXIT_UMBAU_STAND = 1;

/** Zielwerte des Umbaus — dieselben Zahlen wie in DEFAULT_STRATEGY. */
export const EXIT_UMBAU_ZIEL = {
  minHoldMin: 1440,
  exitConfluence: 3,
} as const;

export interface ExitUmbauPlan {
  minHoldMin?: number;
  exitConfluence?: number;
}

/**
 * Was an diesem Konto zu ändern wäre — `null`, wenn nichts zu tun ist.
 *
 * Pur und ohne Firestore, damit die Entscheidung testbar bleibt: Sie
 * verändert fremde Handelseinstellungen, und das ist nichts, was man an
 * einer Stelle treffen sollte, die man nur im Live-Betrieb beobachten kann.
 */
export function exitUmbauPlan(
  engine: Partial<EngineConfig> | undefined,
  signals: Partial<SignalsConfig> | undefined,
  stand = EXIT_UMBAU_STAND,
): ExitUmbauPlan | null {
  if ((engine?.exitUmbauStand ?? 0) >= stand) return null;
  const plan: ExitUmbauPlan = {};

  // Nur anheben. `?? 0` ist Absicht: Ein fehlender Wert ist der schwächste
  // denkbare und wird angehoben, nicht als „bewusst so gewählt" gelesen.
  if ((engine?.minHoldMin ?? 0) < EXIT_UMBAU_ZIEL.minHoldMin) {
    plan.minHoldMin = EXIT_UMBAU_ZIEL.minHoldMin;
  }
  // maxHoldDays wird BEWUSST nicht angefasst — siehe DEFAULT_STRATEGY:
  // Die Frist misst ab Einstieg, ihre Einführung schlösse also schlagartig
  // jede ältere Position quer durch alle Konten.
  // Fehlt der Wert, greift in der Engine `minConfluence - 1` — bei der
  // Voreinstellung also EINE Gegenstimme. Genau der Zustand, der die
  // Positionen zerschneidet.
  if ((signals?.exitConfluence ?? 1) < EXIT_UMBAU_ZIEL.exitConfluence) {
    plan.exitConfluence = EXIT_UMBAU_ZIEL.exitConfluence;
  }
  return Object.keys(plan).length > 0 ? plan : {};
}

// ── Stückzahl aus einem Eingabefeld (Audit-Befund 11.08.) ───────────────────

/**
 * Größte Stückzahl, die eine Handeingabe tragen darf.
 *
 * Die Grenze steht seit M4 im `trade`-Callable und ist der Grund, warum sie
 * hier steht: Sie MUSS an beiden Enden dieselbe sein.
 */
export const MAX_QTY = 10_000;

/**
 * Die Stückzahl aus einem Eingabefeld — nach genau der Regel, die der Server
 * durchsetzt.
 *
 * ── Der Audit-Befund ──────────────────────────────────────────────────────
 *
 * Das Dashboard las die Menge an fünf Stellen aus einem Feld, mit vier
 * verschiedenen Antworten. Zwei davon standen im selben Ablauf:
 *
 *   Vorschau (`updateOrderPreview`)  Math.max(1, Number(v) || 1)
 *   Absenden (`submitOrderTicket`)   Math.max(1, Math.floor(Number(v) || 1))
 *
 * Die Felder sind `type="number"` ohne `step`, nehmen also `2,7`. Die
 * Vorschau rechnete dann mit 2,7 (`2,7 × 250,00 = 675,00 $`), ausgeführt
 * wurden 2 Stück (500,00 $). Kapitalbindung, Prozent-vom-Cash und Stop-Level
 * bezogen sich auf eine Order, die so nie stattfand.
 *
 * In der Trade-Karte fehlte das Abrunden GANZ — dort rechneten Zwischensumme,
 * Gebühr, Gesamtbetrag, „Barbestand danach" und der Bestätigungstext
 * vollständig mit 2,5 Stück durch. Als einziges Ergebnis kam danach die
 * Server-Absage „qty muss eine ganze Zahl 1–10000 sein". Die gesamte Vorschau
 * beschrieb eine Order, die das System per Definition nicht ausführen kann.
 *
 * ── Warum abrunden und nicht aufrunden ────────────────────────────────────
 *
 * Weil eine aufgerundete Kaufmenge mehr Kapital bindet, als der Nutzer
 * eingetippt hat. Im Zweifel weniger, nie mehr — dieselbe Richtung, die
 * `clampStrategyRisk` und `sizeOrder` bei jedem Grenzfall nehmen.
 */
export function eingabeStueckzahl(roh: string | number | null | undefined): number {
  const n = typeof roh === 'number' ? roh : Number(roh);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_QTY, Math.max(1, Math.floor(n)));
}
