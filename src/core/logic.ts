/**
 * DER Entscheidungspfad. Backtest und Live-Engine rufen `decide()` mit
 * derselben Sicht auf und bekommen dieselben Order-Intents zurück. Alles,
 * was hier steht, gilt in beiden Welten — alles, was nur in einer Welt
 * gilt, ist ein Messfehler (Owner-Erkenntnis: der alte Backtest maß eine
 * Strategie, die live nie lief).
 *
 * Reihenfolge je Zyklus:
 *   0. Faktor des Volatilitätsziels rechnen (`risk.volTarget`,
 *      risk/volziel.ts) — einmal je Zyklus, hier und nirgends sonst.
 *   1. Konto-Sperren prüfen (Tagesverlust, Drawdown) → ggf. alles glatt.
 *   1b. Bremsen je Stufe (`risk.tiers`) → ggf. die Positionen DIESER Stufe
 *      glatt und ihre Einstiege gesperrt; die andere Stufe läuft weiter.
 *   2. Je Symbol: Strategie befragen — in rotierender Reihenfolge, damit
 *      niemand dauerhaft zuerst an die knappen Plätze kommt
 *      (`wettbewerbsOrdnung`).
 *      - Position offen: Exit / Stop nachziehen / EOD-Flatten. Exits werden
 *        NIE gesperrt (Owner-Regel).
 *      - Keine Position: Einstieg nur durch alle Tore (Halt, Stufen-Bremse,
 *        Datenfrische, Session, Short-Erlaubnis, Positionslimit, PDT,
 *        Stop-Plausibilität, Sizing) — auch der Wiederaufbau einer
 *        Zielallokation (`risk.wiederaufbau`) geht durch genau diese Tore.
 *
 * Drei Stellschrauben sind seit 12.09.2026 dabei, alle drei per Vorgabe AUS
 * bzw. leer, damit kein bestehendes Messergebnis still verschoben wird:
 * `risk.volTarget` (Größe der Positionen), `risk.tiers` (Latte der Bremsen
 * je Stufe), `risk.wiederaufbau` (Wiedereinstieg nach Zwangs-Glattstellung).
 * Ihr gemeinsamer Nenner: Sie ändern, WIE VIEL und WANN gehandelt wird —
 * nie, WAS als Kante gilt. Kein Gate wird dadurch leichter (§0.9).
 *
 * Die Basis-Stufe (Champion-Block `basis`, core/basisTier.ts) hat hier KEINE
 * Sonderrechte. Ein Basis-Symbol ist ein `SymbolInput` wie jedes andere:
 * Tages-Notbremse, Drawdown-Halt, Einstiegssperre von außen (`entryLock`),
 * Datenalter, Positionslimit, Exposure-Budget, PDT und Bargeld sperren ihre
 * Einstiege wie die des Alpha-Champions; Exits laufen wie überall nie
 * gesperrt. Was sie unterscheidet, ist allein die Sizing-Semantik der Wahl
 * (`sizing`, risk/sizing.ts) und die Rangbildung je Korb (`korbRaenge`).
 *
 * Benannt, nicht beschönigt (Prüfbefund M9, 09.09.2026): Der Simulator setzt
 * den Equity-Peak je Simulations-Range neu und kennt kein `resume`; live
 * steht der Peak über Wochen (`peakEquity` im State) und ein Drawdown-Halt
 * endet nur über `resume` (§0.5). Ein Drawdown, der sich über mehrere
 * Messfenster aufbaut, löst deshalb live aus, wo der Simulator schweigt —
 * das gilt heute für den Alpha-Champion und seit der Basis-Stufe für die
 * Basis genauso. Die durchgehende Basis-Simulation (ein Peak über die ganze
 * OOS-Kette, optimize/walkForward.ts) verkleinert die Lücke, sie schließt
 * sie nicht: `resume` gibt es dort nicht, live bleibt die Basis nach einem
 * Drawdown-Halt in Kasse, bis der Nutzer es aufhebt. Kein Auto-Resume —
 * das wäre ein Override, keine Ursache (§0.5).
 */
import type { RiskConfig, SessionConfig } from './config.ts';
import type {
  AccountView,
  AssetClass,
  HaltState,
  IndicatorSet,
  KorbRang,
  Ms,
  OrderIntent,
  Params,
  PositionState,
  Side,
  SizingSpec,
  Strategy,
  SymbolSnapshot,
  TimeframeMin,
} from './types.ts';
import { DAY } from './time.ts';
import { checkHalt, grenzenFuer, kontoGrenzen, STUFEN, stufeOf, stufenBremsenAktiv, type Stufe } from '../risk/limits.ts';
import { pdtCheck } from '../risk/pdt.ts';
import { sizePosition } from '../risk/sizing.ts';
import { volSkalierung, type VolZielResult } from '../risk/volziel.ts';

export interface AssetFacts {
  tradable: boolean;
  shortable: boolean;
}

export interface LogicContext {
  now: Ms;
  today: string;
  nextTradingDay: string;
  account: AccountView;
  positions: ReadonlyMap<string, PositionState>;
  /** Symbole mit offener, noch ungefüllter Einstiegs-Order. */
  pendingEntries: ReadonlySet<string>;
  /** Nominalwert (qty × Referenzkurs) der offenen Einstiegs-Orders je Symbol — belegt Exposure-Budget. */
  pendingNotional?: ReadonlyMap<string, number> | undefined;
  halt: HaltState;
  risk: RiskConfig;
  session: SessionConfig;
  assetClass: AssetClass;
  timeframe: TimeframeMin;
  /** false ⇒ keine neuen Einstiege (Datenstrom alt/abgerissen). */
  dataFresh: boolean;
  /** Lokal gezählte Daytrades im 5-Tage-Fenster (Ergänzung zur Broker-Zahl). */
  localDayTrades: number;
  assetFacts: (symbol: string) => AssetFacts | undefined;
  /** Stop bei Einstieg mindestens diese Distanz (in %) vom Kurs — Schutz vor Null-Risiko-Stops. */
  minStopDistancePct?: number;
  /**
   * Einstiege von außen gesperrt (Text = Grund), ohne persistierten Halt: Der Functions-Takt setzt das,
   * wenn die Echtgeld-Kette (Freigabe, Kill-Switch, Nutzer-Schalter, Reife) nicht geschlossen ist.
   * Exits, Stop-Nachzüge und Glattstellungen laufen weiter — Exits werden nie gesperrt.
   */
  entryLock?: string | null | undefined;
  /**
   * Tagesrenditen der EIGENEN Equity-Kurve (Anteile, jüngste zuletzt) — Eingabe
   * des Volatilitätsziels (`risk.volTarget`, risk/volziel.ts). Gerechnet wird der
   * Faktor HIER, in `decide()`, nicht im Aufrufer: Sonst rechneten Simulator und
   * Engine ihn zweimal und könnten auseinanderlaufen — genau der Messfehler,
   * gegen den dieser Entscheidungspfad gebaut ist. Der Aufrufer liefert nur die
   * Reihe, und beide Welten bilden sie gleich (Simulator: `dailyReturns`;
   * Engine: `tagesRenditen(state.equityHistory)`).
   */
  equityReturns?: readonly number[] | undefined;
  /**
   * Persistierte Halt-Zustände je Stufe (`alpha` · `basis` · `other`), wenn
   * `risk.tiers` Latten je Stufe setzt. Fehlt das Feld, beginnt jede Stufe ohne
   * Sperre. `decide()` gibt den fortgeschriebenen Stand zurück; Simulator und
   * Engine speichern ihn wie den Konto-Halt.
   */
  stufenHalt?: Readonly<Record<string, HaltState>> | undefined;
  /**
   * Offene Wiederaufbau-Ziele je Symbol (`risk.wiederaufbau`): Positionen, die
   * eine Notbremse glattgestellt hat und die die Zielallokation weiter halten
   * will. `decide()` gibt den fortgeschriebenen Stand zurück.
   */
  wiederaufbau?: Readonly<Record<string, WiederaufbauZiel>> | undefined;
}

/**
 * Eine Position, die die Zielallokation halten WILL, die aber eine Notbremse
 * glattgestellt hat.
 *
 * Warum die Stop-DISTANZ und nicht die Marke: Der Wiederaufbau kauft zu einem
 * neuen Kurs; ein alter Stop-Preis wäre eine andere Regel als die gemessene.
 * Die Distanz ist bei den Familien mit Zielallokation ein fester Prozentsatz
 * des Einstands (`regime_allocation`: `stopPct`), der Wiederaufbau bekommt
 * also genau den Stop, den die Strategie an diesem Tag auch selbst gesetzt
 * hätte. GRENZE, nicht wegdefiniert: Für eine Familie, deren Stop aus der
 * Schwankung kommt (ATR), wäre die Distanz von gestern eine Näherung — solche
 * Familien haben keine Allokations-Semantik, und der Wiederaufbau gilt nur
 * für diese (siehe `merkeWiederaufbau` in `decide()`).
 */
export interface WiederaufbauZiel {
  side: Side;
  /** Stop-Distanz in % vom Einstand der glattgestellten Position (> 0, < 100). */
  stopDistPct: number;
  /** Strategie, die die Position führte — wechselt sie, verfällt das Ziel. */
  strategy: string;
  /** Wann glattgestellt (Epoch-ms) — Grundlage des Verfalls. */
  since: Ms;
  /** Warum glattgestellt (fürs Journal). */
  grund: string;
}

export interface SymbolInput {
  snap: SymbolSnapshot;
  strategy: Strategy;
  params: Params;
  ind: IndicatorSet;
  /**
   * Sizing-Semantik der Strategie-Wahl (Basis-Stufe: Allokation). Fehlt sie,
   * gilt das Risiko-Budget je Trade. Sie kommt aus `strategyFor` — im
   * Simulator wie in der Engine derselbe Wert, sonst wären Messung und
   * Handel zwei Welten.
   */
  sizing?: SizingSpec | undefined;
  /**
   * Einstiegsrecht der Wahl: `false` ⇒ diese Strategie darf in diesem Symbol
   * KEINE neue Position eröffnen, führt eine offene aber weiter (eigene
   * Exits, Stop-Nachzug — Exits werden nie gesperrt, §0.4). So sperrt ein
   * gefallenes `pass`, ein Schalter „aus" oder ein Block ohne Freigabe die
   * Basis-Stufe nur nach vorn, statt alle Konten zu liquidieren (Prüfbefund
   * M6/M8). Fehlt das Feld, sind Einstiege erlaubt; der Simulator setzt es nie.
   */
  entriesAllowed?: boolean | undefined;
  /** Grund der Einstiegssperre (fürs Journal), wenn `entriesAllowed` false ist. */
  entryLockReason?: string | undefined;
  /**
   * Stufe der Wahl (`champion` · `basis` · `config`) — dieselbe Quelle, die
   * beim Fill in der Position festgehalten wird (`PositionState.stufe`).
   * Sie entscheidet, welche Latte der Notbremse für dieses Symbol gilt
   * (`risk.tiers`, risk/limits.ts). Fehlt sie, gelten die globalen Werte.
   */
  stufe?: string | undefined;
}

export interface LogicNote {
  symbol: string;
  kind: 'blocked' | 'decision' | 'info' | 'halt';
  text: string;
}

export interface LogicResult {
  intents: OrderIntent[];
  notes: LogicNote[];
  halt: HaltState;
  /** true, wenn in diesem Zyklus eine Sperre neu ausgelöst wurde. */
  haltTriggered: boolean;
  /**
   * Ergebnis des Volatilitätsziels dieses Zyklus (null = aus). Der Faktor
   * verändert jede Positionsgröße — er gehört ins Journal und in den Bericht,
   * nicht in eine unsichtbare Ecke.
   */
  volZiel?: VolZielResult | null;
  /** Fortgeschriebene Halt-Zustände je Stufe (nur belegt, wenn `risk.tiers` Latten setzt). */
  stufenHalt?: Record<string, HaltState>;
  /** Stufen, deren Bremse in DIESEM Zyklus neu ausgelöst hat (fürs Journal/Notify). */
  stufenHaltTriggered?: Stufe[];
  /** Fortgeschriebene Wiederaufbau-Ziele (siehe `WiederaufbauZiel`). */
  wiederaufbau?: Record<string, WiederaufbauZiel>;
}

export const DEFAULT_MIN_STOP_DISTANCE_PCT = 0.05;

export function qtyStepFor(assetClass: AssetClass): number {
  return assetClass === 'crypto' ? 0.0001 : 1;
}

export function grossExposure(positions: ReadonlyMap<string, PositionState>, priceOf: (symbol: string) => number | undefined): number {
  let sum = 0;
  for (const p of positions.values()) {
    const px = priceOf(p.symbol) ?? p.entryPrice;
    sum += p.qty * px;
  }
  return sum;
}

/**
 * Reihenfolge, in der Symbole um die knappen Budgets konkurrieren
 * (`maxPositions`, Brutto-Exposure, PDT-Reserve, Bargeld am Fill).
 *
 * Warum es diese Funktion überhaupt gibt: Wer im Zyklus zuerst drankommt,
 * bekommt den letzten freien Platz. Ohne Regel entschied das die Reihenfolge,
 * in der der Aufrufer seine Liste gebaut hat — im Backtest wie live die
 * Reihenfolge aus `universe.symbols`. Bei 30 Symbolen auf 4 Plätzen ist das
 * keine Kleinigkeit: Die ersten vier Einträge der Config (bei uns die vier
 * Index-ETFs) hätten systematisch mehr Einstiege bekommen als der Rest, und
 * ein umsortiertes Universum hätte das Ergebnis verändert, ohne dass sich
 * eine Strategie geändert hat. Genau die Art stiller Freiheitsgrad, der
 * hinterher wie eine Kante aussieht.
 *
 * Die Regel: Jedes Symbol bekommt je Bar einen Schlüssel aus (Symbol, Bucket),
 * sortiert wird danach. Zwei Eigenschaften, die beide gebraucht werden und die
 * eine einfache Rotation `bucket mod n` NICHT hat (Red-Team, 08.09.):
 *
 *  1. **Keine Resonanz.** Ein Handelstag hat bei 5 min genau 288 Buckets. Mit
 *     `bucket mod n` rückt der Start an einer festen Tageszeit täglich um
 *     `288 mod n` vor — bei n = 30 gäbe es zu jeder Uhrzeit nur 5 verschiedene
 *     Startpunkte, 10 der 30 Symbole kämen um 10:00 ET NIE zuerst dran (unter
 *     ihnen SPY und QQQ, also genau die, die vorher bevorzugt waren). Bei
 *     n ∈ {12, 16, 18, 24} stünde die Reihenfolge zu einer festen Uhrzeit für
 *     immer still. Der Mischer hat keine gemeinsamen Teiler mit irgendetwas.
 *  2. **Unabhängig davon, WER im Zyklus dabei ist.** Der Schlüssel eines
 *     Symbols hängt nur an ihm selbst und an der Bar-Zeit, nicht an der Anzahl
 *     der Anwesenden. Sonst würde ein einziges fehlendes Symbol (live normal:
 *     keine IEX-Bar im Bucket) die ganze Prioritätsreihenfolge gegenüber der
 *     Messung permutieren — und zwar systematisch, weil die Ausfälle die
 *     dünneren Werte treffen.
 *
 * Über viele Bars ist die Priorität damit gleichverteilt; innerhalb einer Bar
 * ist sie allein aus den Daten reproduzierbar, im Backtest wie live.
 *
 * Exits berührt das nicht: Sie laufen für jedes Symbol dieses Zyklus,
 * unabhängig von der Reihenfolge, und werden nie gesperrt.
 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** splitmix32-Finalisierer: streut benachbarte Zahlen über den ganzen Bereich. */
function mische(x: number): number {
  let z = x | 0;
  z = (z ^ (z >>> 16)) >>> 0;
  z = Math.imul(z, 0x21f0aaad) >>> 0;
  z = (z ^ (z >>> 15)) >>> 0;
  z = Math.imul(z, 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

/**
 * Schlüssel des Korbs, in dem ein Symbol rangiert: Strategie, Parameter und
 * Sizing-Semantik der Wahl — alles Daten des `SymbolInput`, nichts, was ein
 * Aufrufer etikettieren könnte. Zwei Symbole rangieren nur dann gegeneinander,
 * wenn dieselbe Strategie mit denselben Parametern und derselben Semantik sie
 * führt: So bleibt der Korb der Basis-Stufe (Allokation, eigene Parameter) von
 * einem Alpha-Korb derselben Strategie getrennt, und ein gepoolter Alpha-Korb
 * (ein Parametersatz für alle) rangiert wie bisher als Ganzes.
 */
export function korbSchluessel(inp: Pick<SymbolInput, 'strategy' | 'params' | 'sizing'>): string {
  const params = Object.keys(inp.params)
    .sort()
    .map((k) => `${k}=${inp.params[k]}`)
    .join(',');
  const sizing = inp.sizing ? `${inp.sizing.mode}:${inp.sizing.positionPct}` : 'risk';
  return `${inp.strategy.id}|${params}|${sizing}`;
}

/**
 * Korb-Rang je Symbol für Querschnitts-Strategien.
 *
 * Warum das hier steht und nicht im Aufrufer: `decide()` ist der EINE
 * Entscheidungspfad. Würde der Backtest die Rangliste selbst bauen und die
 * Engine auch, hätten wir zwei Ranglisten, die auseinanderlaufen können —
 * und das wäre genau der Messfehler, gegen den der ganze Neubau gebaut ist.
 *
 * Zwei Regeln machen die Sache kausal und in beiden Welten gleich:
 *
 *  1. Es wird nur innerhalb eines KORBS rangiert (`korbSchluessel`: Strategie,
 *     Parameter, Sizing-Semantik). Symbole mit anderer Strategie haben eine
 *     andere Kennzahl; sie zu mischen wäre sinnlos. Und der Korb der
 *     Basis-Stufe (z. B. neun Anlageklassen-ETFs mit Allokations-Sizing)
 *     darf nie gegen einen Alpha-Korb derselben Strategie rangieren — gemessen
 *     wurde er allein, also rangiert er allein. In der Messung ist der Korb
 *     einer Einheit ohnehin ein Parametersatz; per Symbol gefittete
 *     Querschnitts-Champions rangierten in ihrer Messung nur gegen sich selbst
 *     (`of` 1, unter MIN_KORB) und konnten so nie Champion werden — der
 *     Schlüssel macht live nur, was die Messung schon tat.
 *  2. Es rangieren nur Symbole, deren Entscheidungs-Bar zur JÜNGSTEN Bar des
 *     Zyklus gehört. Live kann ein Symbol ohne Trade im Bucket eine ältere
 *     letzte Bar haben — seine Kennzahl stammt dann von einem anderen
 *     Zeitpunkt, und ein Vergleich damit wäre schlicht falsch. Solche Symbole
 *     bekommen keinen Rang; ihre EXITS laufen unberührt weiter (Regel 4).
 *
 * `crossScore` sieht nur `snap.bars.prefix(i + 1)` — geschlossene Bars bis
 * zur Entscheidungs-Bar. Zukunft kann hier also nicht hineingeraten.
 */
export function korbRaenge(inputs: readonly SymbolInput[]): Map<string, KorbRang> {
  const out = new Map<string, KorbRang>();
  let neueste = Number.NEGATIVE_INFINITY;
  for (const inp of inputs) {
    const t = inp.snap.bars.t[inp.snap.i];
    if (t !== undefined && t > neueste) neueste = t;
  }
  const proKorb = new Map<string, { symbol: string; score: number }[]>();
  for (const inp of inputs) {
    if (!inp.strategy.crossScore) continue;
    if (inp.snap.bars.t[inp.snap.i] !== neueste) continue;
    const score = inp.strategy.crossScore(inp.snap, inp.ind, inp.params);
    if (score === null || !Number.isFinite(score)) continue;
    const key = korbSchluessel(inp);
    const liste = proKorb.get(key) ?? [];
    liste.push({ symbol: inp.snap.symbol, score });
    proKorb.set(key, liste);
  }
  for (const liste of proKorb.values()) {
    // Absteigend nach Kennzahl; Gleichstand alphabetisch, damit der Lauf reproduzierbar bleibt.
    liste.sort((a, b) => b.score - a.score || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
    const of = liste.length;
    for (let k = 0; k < of; k++) {
      out.set(liste[k]!.symbol, { pct: of > 1 ? k / (of - 1) : 0, rank: k + 1, of });
    }
  }
  return out;
}

export function wettbewerbsOrdnung(inputs: readonly SymbolInput[], timeframe: TimeframeMin): SymbolInput[] {
  if (inputs.length < 2) return [...inputs];
  // Bucket-Nummer der jüngsten Entscheidungs-Bar. Beide Welten entscheiden auf
  // geschlossenen Bars desselben Rasters, also ergibt sich dieselbe Zahl.
  let neueste = 0;
  for (const inp of inputs) {
    const t = inp.snap.bars.t[inp.snap.i] ?? 0;
    if (t > neueste) neueste = t;
  }
  const bucket = mische(Math.floor(neueste / (timeframe * 60_000)));
  const schluessel = new Map<string, number>();
  for (const inp of inputs) schluessel.set(inp.snap.symbol, mische(fnv1a(inp.snap.symbol) ^ bucket));
  return [...inputs].sort((a, b) => {
    const d = schluessel.get(a.snap.symbol)! - schluessel.get(b.snap.symbol)!;
    // Gleichstand (Hash-Kollision) alphabetisch — der Lauf muss reproduzierbar bleiben.
    return d !== 0 ? d : a.snap.symbol < b.snap.symbol ? -1 : a.snap.symbol > b.snap.symbol ? 1 : 0;
  });
}

export function decide(ctx: LogicContext, inputs: readonly SymbolInput[]): LogicResult {
  const intents: OrderIntent[] = [];
  const notes: LogicNote[] = [];
  const bySym = new Map<string, SymbolInput>();
  for (const inp of inputs) bySym.set(inp.snap.symbol, inp);

  /*
   * Volatilitätsziel: EIN Aufruf je Zyklus, hier und nirgends sonst. Der
   * Faktor skaliert das Sizing-Budget beider Semantiken; die Deckel des
   * Nutzers bleiben darüber (risk/sizing.ts). Aus ⇒ Faktor 1,0, also exakt
   * das Verhalten ohne dieses Feld.
   */
  const vt = ctx.risk.volTarget;
  const volZiel: VolZielResult | null = vt?.enabled
    ? volSkalierung({
        renditen: ctx.equityReturns ?? [],
        zielVolPct: vt.zielVolPct,
        halbwertszeitTage: vt.halbwertszeitTage,
        minFaktor: vt.minFaktor,
        maxFaktor: vt.maxFaktor,
        minBeobachtungen: vt.minBeobachtungen,
        tageJeJahr: ctx.assetClass === 'crypto' ? 365 : 252,
      })
    : null;
  const volFaktor = volZiel?.faktor ?? 1;

  /* ── Wiederaufbau-Ziele (risk.wiederaufbau) ──────────────────────────── */
  const wiederCfg = ctx.risk.wiederaufbau;
  const ziele = new Map<string, WiederaufbauZiel>(Object.entries(ctx.wiederaufbau ?? {}));
  /** Stufe einer Position: die beim Fill festgehaltene gewinnt, die Wahl von heute ist nur Rückfall (Prüfbefund G14). */
  const stufeVonPosition = (p: PositionState): Stufe => {
    if (p.stufe !== undefined) return stufeOf(p.stufe);
    const inp = bySym.get(p.symbol);
    return stufeOf(inp && inp.strategy.id === p.strategy ? inp.stufe : undefined);
  };
  /**
   * Eine zwangsweise glattgestellte Position merken — aber nur, wenn sie eine
   * ZIELALLOKATION war (Allokations-Sizing) und die Wahl von heute dieselbe
   * Strategie führt. Für Signal-Strategien mit Risiko-Budget gibt es keine
   * Zielallokation: Ein „Wiederaufbau" wäre dort ein erfundenes Signal.
   */
  const merkeWiederaufbau = (p: PositionState, grund: string): void => {
    if (!wiederCfg?.enabled) return;
    const inp = bySym.get(p.symbol);
    if (!inp || inp.sizing?.mode !== 'allocation' || inp.strategy.id !== p.strategy) return;
    const marke = p.initialStop ?? p.stop;
    if (marke === null || !Number.isFinite(marke) || !(p.entryPrice > 0)) return;
    const dist = (Math.abs(p.entryPrice - marke) / p.entryPrice) * 100;
    if (!(dist > 0) || dist >= 100) return;
    ziele.set(p.symbol, { side: p.side, stopDistPct: dist, strategy: p.strategy, since: ctx.now, grund });
  };
  /** Gültiges Ziel für dieses Symbol — oder null (und dann verfallen). */
  const zielFuer = (inp: SymbolInput): WiederaufbauZiel | null => {
    if (!wiederCfg?.enabled) return null;
    const sym = inp.snap.symbol;
    const z = ziele.get(sym);
    if (!z) return null;
    if (inp.sizing?.mode !== 'allocation' || inp.strategy.id !== z.strategy) {
      ziele.delete(sym);
      return null;
    }
    if (ctx.now - z.since > wiederCfg.maxAlterTage * DAY) {
      ziele.delete(sym);
      notes.push({ symbol: sym, kind: 'info', text: `Wiederaufbau-Ziel verfallen (älter als ${wiederCfg.maxAlterTage} Tage)` });
      return null;
    }
    return z;
  };

  const fertig = (halt: HaltState, haltTriggered: boolean, stufenHalt: Record<string, HaltState>, ausgeloest: Stufe[]): LogicResult => ({
    intents,
    notes,
    halt,
    haltTriggered,
    volZiel,
    stufenHalt,
    stufenHaltTriggered: ausgeloest,
    wiederaufbau: Object.fromEntries(ziele),
  });

  // 1. Konto-Sperren. Latte ist die LOCKERSTE aller Stufen (risk/limits.ts):
  // Ohne `risk.tiers` sind das die globalen Werte, also alles wie bisher; mit
  // Stufen-Latten steht das ganze Konto erst still, wenn selbst die duldsamste
  // Stufe aufgegeben hätte — vorher greift deren eigene Bremse (Schritt 1b).
  const hc = checkHalt({
    account: ctx.account,
    halt: ctx.halt,
    risk: ctx.risk,
    now: ctx.now,
    today: ctx.today,
    nextDay: ctx.nextTradingDay,
    grenzen: kontoGrenzen(ctx.risk),
  });
  const halt = hc.halt;
  const stufenHalt: Record<string, HaltState> = { ...(ctx.stufenHalt ?? {}) };
  if (hc.lifted) notes.push({ symbol: '*', kind: 'halt', text: halt.note ?? 'Halt geendet' });
  if (hc.triggered) {
    notes.push({ symbol: '*', kind: 'halt', text: halt.note ?? 'Halt ausgelöst' });
    const reason = halt.reason === 'drawdown' ? 'drawdown' : 'kill_switch';
    for (const p of ctx.positions.values()) {
      intents.push({ kind: 'exit', symbol: p.symbol, reason, decidedAt: ctx.now });
      merkeWiederaufbau(p, `Konto-Notbremse (${halt.reason})`);
    }
    return fertig(halt, true, stufenHalt, []);
  }
  // Notbremse steht (Tagesverlust/Drawdown) und das Buch ist nicht leer: Der Glattstellungs-Exit wird in
  // JEDEM Zyklus erneut angefordert, bis alles zu ist — der Executor ist idempotent (positionsstabile
  // Kennung). Sonst bliebe eine Position nach einem im Auslöse-Zyklus gescheiterten Exit einfach offen
  // (Secreview 2, K2: im Functions-Takt gibt es keinen Wiederholversuch über den Takt hinaus).
  if (halt.halted && (halt.reason === 'daily_loss' || halt.reason === 'drawdown') && ctx.positions.size > 0) {
    const reason = halt.reason === 'drawdown' ? 'drawdown' : 'kill_switch';
    for (const p of ctx.positions.values()) {
      intents.push({ kind: 'exit', symbol: p.symbol, reason, decidedAt: ctx.now });
      merkeWiederaufbau(p, `Konto-Notbremse (${halt.reason})`);
    }
    notes.push({ symbol: '*', kind: 'halt', text: `Notbremse aktiv (${halt.reason}) — offene Positionen werden glattgestellt` });
    return fertig(halt, false, stufenHalt, []);
  }

  /*
   * 1b. Bremsen je Stufe (`risk.tiers`, seit 12.09.2026). Jede Stufe trägt
   * ihren eigenen, persistierten Halt-Zustand mit derselben Lebensdauer wie
   * der des Kontos: Ein Tages-Halt endet am nächsten Handelstag von selbst,
   * ein Drawdown-Halt nur über `resume` (§0.5 — kein Schalter „Sperre aus").
   *
   * Wirkung: Glattstellen der Positionen DIESER Stufe und Sperre ihrer
   * Einstiege. Exits aller anderen Stufen laufen unberührt weiter, und eine
   * gesperrte Stufe verliert nur das Recht zu KAUFEN — nie das zu verkaufen
   * (§0.4).
   */
  const gesperrt = new Map<Stufe, HaltState>();
  const ausgeloest: Stufe[] = [];
  const schonExit = new Set<string>();
  if (stufenBremsenAktiv(ctx.risk)) {
    /*
     * Geprüft werden nur Stufen, die in diesem Zyklus VORKOMMEN (Position oder
     * Wahl) — plus solche, die schon eine Sperre tragen (damit sie enden kann).
     * Sonst stünde in jedem Journal ein Halt für eine Stufe, die gar nichts
     * hält und nichts kaufen will; eine Sperre ohne Gegenstand ist keine
     * Information, sondern Rauschen, und Rauschen liest niemand.
     */
    const anwesend = new Set<Stufe>();
    for (const p of ctx.positions.values()) anwesend.add(stufeVonPosition(p));
    for (const inp of inputs) anwesend.add(stufeOf(inp.stufe));
    for (const [stufe, h] of Object.entries(stufenHalt)) if (h.halted) anwesend.add(stufeOf(stufe));
    for (const stufe of STUFEN) {
      if (!anwesend.has(stufe)) continue;
      const vorher = stufenHalt[stufe] ?? { halted: false, reason: null, since: null, until: null, note: null };
      const hs = checkHalt({
        account: ctx.account,
        halt: vorher,
        risk: ctx.risk,
        now: ctx.now,
        today: ctx.today,
        nextDay: ctx.nextTradingDay,
        grenzen: grenzenFuer(ctx.risk, stufe),
      });
      stufenHalt[stufe] = hs.halt;
      if (hs.lifted) notes.push({ symbol: '*', kind: 'halt', text: `Stufe ${stufe}: ${hs.halt.note ?? 'Halt geendet'}` });
      if (hs.triggered) {
        ausgeloest.push(stufe);
        notes.push({ symbol: '*', kind: 'halt', text: `Stufe ${stufe}: ${hs.halt.note ?? 'Halt ausgelöst'}` });
      }
      if (!hs.halt.halted) continue;
      gesperrt.set(stufe, hs.halt);
      if (hs.halt.reason !== 'daily_loss' && hs.halt.reason !== 'drawdown') continue;
      const reason = hs.halt.reason === 'drawdown' ? 'drawdown' : 'kill_switch';
      for (const p of ctx.positions.values()) {
        if (stufeVonPosition(p) !== stufe || schonExit.has(p.symbol)) continue;
        intents.push({ kind: 'exit', symbol: p.symbol, reason, decidedAt: ctx.now });
        schonExit.add(p.symbol);
        merkeWiederaufbau(p, `Stufen-Bremse ${stufe} (${hs.halt.reason})`);
      }
    }
    if (schonExit.size > 0) {
      notes.push({ symbol: '*', kind: 'halt', text: `Stufen-Bremse aktiv — glattgestellt: ${[...schonExit].join(', ')}` });
    }
  }

  // Preise der Entscheidungs-Bars für Exposure
  const lastClose = new Map<string, number>();
  for (const inp of inputs) lastClose.set(inp.snap.symbol, inp.snap.bars.c[inp.snap.i]!);
  let gross = grossExposure(ctx.positions, (s) => lastClose.get(s));
  // Offene Einstiegs-Orders belegen Exposure-Budget, sobald sie füllen — mitzählen.
  if (ctx.pendingNotional) for (const n of ctx.pendingNotional.values()) gross += n;
  let openCount = ctx.positions.size + ctx.pendingEntries.size;
  // Unter der PDT-Schwelle zählt jeder geplante Einstieg gegen die Reserve — auch ein
  // Übernacht-Einstieg kann noch am selben Tag ausgestoppt werden (Red-Team-Befund).
  let plannedEntries = 0;

  // Querschnitts-Strategien brauchen den Korb-Rang. Nur bauen, wenn wirklich
  // eine Strategie im Zyklus danach fragt — sonst kostet es jede Bar Arbeit
  // und Speicher für nichts.
  const brauchtRang = inputs.some((inp) => inp.strategy.crossScore !== undefined);
  const raenge = brauchtRang ? korbRaenge(inputs) : null;

  // Um die knappen Plätze wird in rotierender Reihenfolge konkurriert, nicht in
  // Config-Reihenfolge (siehe wettbewerbsOrdnung) — mit einer Ausnahme: Wer
  // einen Korb-Rang hat, konkurriert nach RANG, der Stärkste zuerst. Sonst
  // entschiede der Hash, wer von sechs Kandidaten die vier Plätze bekommt
  // (Prüfbefund 09.09.: Rang 3–6 drin, 1 und 2 draußen). Stabil sortiert:
  // unter Gleichrangigen und ohne Rang bleibt die rotierende Ordnung.
  const rotierend = wettbewerbsOrdnung(inputs, ctx.timeframe);
  const geordnet = raenge
    ? [...rotierend].sort((a, b) => {
        const ra = raenge.get(a.snap.symbol)?.rank ?? Number.POSITIVE_INFINITY;
        const rb = raenge.get(b.snap.symbol)?.rank ?? Number.POSITIVE_INFINITY;
        return ra === rb ? 0 : ra - rb;
      })
    : rotierend;
  for (const roh of geordnet) {
    const rang = raenge?.get(roh.snap.symbol);
    const inp = rang === undefined ? roh : { ...roh, snap: { ...roh.snap, rank: rang } };
    const { snap, strategy, params, ind } = inp;
    const sym = snap.symbol;
    const pos = snap.position;
    const price = snap.bars.c[snap.i]!;

    if (snap.i + 1 < strategy.warmupBars(params)) {
      continue;
    }

    // Die Stufen-Bremse stellt dieses Symbol in diesem Zyklus schon glatt — kein
    // zweiter Exit, kein Stop-Nachzug, kein Einstieg daneben.
    if (schonExit.has(sym)) continue;

    // Position wieder da (oder nie weg): Das Wiederaufbau-Ziel ist erledigt.
    if (pos) ziele.delete(sym);

    // Fremde Führung (Prüfbefund M4, 09.09.2026): Die Position hat eine ANDERE
    // Strategie eröffnet als die, die das Symbol heute führt (Alpha-Beförderung,
    // Basis-Wechsel über Nacht). Die neue Strategie hat für diese Position keine
    // gemessene Regel — ihr Signal-Exit, ihr Trailing und ihr EOD-Flatten wären
    // fremde Regeln (der 20-%-Katastrophen-Stop würde zum ATR-Trailing: die
    // Fehlerklasse „Trailing vom Einstand" aus CLAUDE.md §2). Also: halten,
    // nichts nachziehen; der Broker-Stop bleibt, wie er liegt. Die Notbremsen
    // oben laufen über `ctx.positions` und stellen auch diese Position glatt —
    // Exits werden nie gesperrt. Neue Einstiege gibt es mit offener Position
    // ohnehin nicht. Im Simulator kommt der Fall nicht vor (eine Strategie je
    // Symbol und Lauf); live steht die Notiz dazu im Journal (engine.ts).
    if (pos && pos.strategy !== strategy.id) {
      notes.push({ symbol: sym, kind: 'info', text: `Position der Strategie ${pos.strategy} — ${strategy.id} führt sie nicht (kein Signal-Exit, kein Stop-Nachzug, Broker-Stop bleibt)` });
      continue;
    }

    const decision = strategy.decide(snap, ind, params);

    if (pos) {
      // ── Position offen: Exits sind nie gesperrt ──
      // EOD-Flatten am LETZTEN Entscheidungspunkt vor der Frist: Würde die nächste
      // Bar erst nach (Schluss − flattenBeforeCloseMin) schließen, muss jetzt raus.
      // Der Fill liegt dann am Open der Folgebar — ein Kurs, den es live gibt
      // (Red-Team-Befund: ein Fill am Close der Entscheidungs-Bar existiert live nicht).
      const mustFlatten =
        !strategy.holdsOvernight &&
        snap.session.minutesToClose !== null &&
        snap.session.minutesToClose - ctx.timeframe < ctx.session.flattenBeforeCloseMin;
      if (mustFlatten) {
        intents.push({ kind: 'exit', symbol: sym, reason: 'eod', decidedAt: ctx.now });
        notes.push({ symbol: sym, kind: 'decision', text: 'EOD-Flatten' });
        continue;
      }
      if (decision.kind === 'exit') {
        intents.push({ kind: 'exit', symbol: sym, reason: 'signal', decidedAt: ctx.now });
        notes.push({ symbol: sym, kind: 'decision', text: `Exit: ${decision.reason}` });
        continue;
      }
      if (decision.kind === 'move_stop') {
        const tighter = pos.side === 'long' ? pos.stop === null || decision.stop > pos.stop : pos.stop === null || decision.stop < pos.stop;
        const onLossSide = pos.side === 'long' ? decision.stop < price : decision.stop > price;
        if (tighter && onLossSide && Number.isFinite(decision.stop) && decision.stop > 0) {
          intents.push({ kind: 'move_stop', symbol: sym, stop: decision.stop, reason: decision.reason, decidedAt: ctx.now });
          notes.push({ symbol: sym, kind: 'decision', text: `Stop → ${decision.stop} (${decision.reason})` });
        }
        continue;
      }
      if (decision.kind === 'enter' && decision.side !== pos.side) {
        notes.push({ symbol: sym, kind: 'info', text: 'Gegensignal bei offener Position — ignoriert (kein Reversal)' });
      }
      continue;
    }

    // ── Keine Position ──
    /*
     * Wiederaufbau einer Zielallokation (risk.wiederaufbau, §5a.16):
     *
     * Eine Notbremse hat dieses Symbol glattgestellt, die Zielallokation will
     * es aber weiter halten. Ohne Wiederaufbau käme der Wiedereinstieg erst im
     * nächsten ENTSCHEIDUNGSFENSTER der Strategie — bei `regime_allocation`
     * drei Tage je Monat, also im Regelfall einen Monat später (gemessen: V3,
     * August 2024 und April 2025; die Erholung fehlt, und der Drawdown je
     * Einheit Exposure wird dadurch schlechter, nicht besser).
     *
     * Was hier passiert und was nicht: Der Wiederaufbau erzeugt einen
     * Einstieg, der durch ALLE Tore unten läuft (Halt, Stufen-Bremse,
     * Einstiegsrecht, Datenfrische, Session, Positionslimit, PDT,
     * Stop-Plausibilität, Sizing) — er hebt keine Sperre auf und ist kein
     * Override (§0.5). Er entsteht nur, wenn die Strategie in diesem Zyklus
     * NICHT aussteigen will.
     *
     * GRENZE, benannt: Außerhalb ihres Fensters sagt die Familie gar nichts —
     * ihr Schweigen ist kein Ja. Deshalb verfällt ein Ziel nach
     * `maxAlterTage` (Vorgabe 5), und deshalb ist der Schalter aus, bis ein
     * vorregistrierter Lauf ihn misst.
     */
    const ziel = zielFuer(inp);
    if (ziel && decision.kind === 'exit') {
      ziele.delete(sym);
      notes.push({ symbol: sym, kind: 'info', text: 'Wiederaufbau verworfen — die Strategie will diese Allokation nicht mehr' });
      continue;
    }
    let einstieg: { side: Side; stop: number; target?: number | undefined; reason: string } | null = null;
    if (decision.kind === 'enter') {
      einstieg = { side: decision.side, stop: decision.stop, target: decision.target, reason: decision.reason };
    } else if (ziel) {
      const dist = ziel.stopDistPct / 100;
      einstieg = {
        side: ziel.side,
        stop: ziel.side === 'long' ? price * (1 - dist) : price * (1 + dist),
        reason: `Wiederaufbau der Zielallokation (${ziel.grund}, Stop ${ziel.stopDistPct.toFixed(1)} % wie beim Einstand)`,
      };
    }
    if (!einstieg) continue;

    const block = (text: string) => notes.push({ symbol: sym, kind: 'blocked', text });

    if (halt.halted) {
      block(`Halt aktiv (${halt.reason})`);
      continue;
    }
    const stufe = stufeOf(inp.stufe);
    const stufenSperre = gesperrt.get(stufe);
    if (stufenSperre) {
      block(`Stufe ${stufe} gesperrt (${stufenSperre.reason})`);
      continue;
    }
    if (ctx.entryLock) {
      block(`Einstiege gesperrt: ${ctx.entryLock}`);
      continue;
    }
    // Einstiegsrecht der Wahl (Basis ohne Freigabe: pass gefallen, Schalter aus):
    // nur Einstiege — Exits liefen oben, unberührt.
    if (inp.entriesAllowed === false) {
      block(`Einstiege gesperrt: ${inp.entryLockReason ?? 'Wahl ohne Einstiegsrecht'}`);
      continue;
    }
    if (!ctx.dataFresh) {
      block('Daten nicht frisch');
      continue;
    }
    if (ctx.pendingEntries.has(sym)) {
      block('Einstiegs-Order bereits offen');
      continue;
    }
    const facts = ctx.assetFacts(sym);
    if (facts && !facts.tradable) {
      block('Asset nicht handelbar');
      continue;
    }
    if (einstieg.side === 'short') {
      if (!ctx.risk.allowShort) {
        block('Short nicht erlaubt (risk.allowShort=false)');
        continue;
      }
      if (ctx.assetClass === 'crypto') {
        block('Krypto: kein Short bei Alpaca');
        continue;
      }
      if (facts && !facts.shortable) {
        block('Asset nicht shortbar');
        continue;
      }
    }
    // Session-Tore (nur Intraday-Zeitrahmen bei Aktien)
    if (ctx.assetClass === 'us_equity' && ctx.timeframe !== 1440) {
      const so = snap.session.minutesSinceOpen;
      const tc = snap.session.minutesToClose;
      if (!snap.session.isRegularSession) {
        block('Außerhalb der regulären Sitzung');
        continue;
      }
      if (so !== null && so < ctx.session.noEntryFirstMin) {
        block(`Eröffnungsfenster (${so} < ${ctx.session.noEntryFirstMin} min)`);
        continue;
      }
      if (tc !== null && tc <= ctx.session.noEntryLastMin) {
        block(`Schlussfenster (${tc} ≤ ${ctx.session.noEntryLastMin} min)`);
        continue;
      }
      // Kein Einstieg, der am nächsten Entscheidungspunkt sofort wieder glattgestellt würde.
      if (!strategy.holdsOvernight && tc !== null && tc - ctx.timeframe < ctx.session.flattenBeforeCloseMin) {
        block('Flatten-Fenster');
        continue;
      }
    }
    if (openCount >= ctx.risk.maxPositions) {
      block(`Positionslimit ${ctx.risk.maxPositions} erreicht`);
      continue;
    }
    // Stop-Plausibilität
    const minDist = (ctx.minStopDistancePct ?? DEFAULT_MIN_STOP_DISTANCE_PCT) / 100;
    const stop = einstieg.stop;
    const stopOk =
      Number.isFinite(stop) &&
      stop > 0 &&
      (einstieg.side === 'long' ? stop < price * (1 - minDist) : stop > price * (1 + minDist));
    if (!stopOk) {
      block(`Stop unplausibel (${stop} bei Kurs ${price})`);
      continue;
    }
    let target: number | null = null;
    if (einstieg.target !== undefined && Number.isFinite(einstieg.target) && einstieg.target > 0) {
      const targetOk = einstieg.side === 'long' ? einstieg.target > price : einstieg.target < price;
      target = targetOk ? einstieg.target : null;
    }
    // PDT
    const pdt = pdtCheck({
      respect: ctx.risk.pdt.respect,
      minEquity: ctx.risk.pdt.minEquity,
      maxDayTrades: ctx.risk.pdt.maxDayTrades,
      equity: ctx.account.equity,
      brokerCount: ctx.account.dayTradeCount,
      localCount: ctx.localDayTrades,
      plannedIntradayEntries: plannedEntries,
      intraday: !strategy.holdsOvernight,
      assetClass: ctx.assetClass,
    });
    if (!pdt.allowed) {
      block(pdt.reason ?? 'PDT');
      continue;
    }
    // Sizing — Risiko-Budget, oder die Allokations-Semantik der Wahl
    // (Basis-Stufe); die Deckel des Nutzers gelten in beiden Fällen.
    const exposureBudget = (ctx.account.equity * ctx.risk.maxGrossExposurePct) / 100 - gross;
    const size = sizePosition({
      equity: ctx.account.equity,
      cash: ctx.account.cash,
      price,
      stop,
      side: einstieg.side,
      riskPct: ctx.risk.riskPerTradePct,
      maxPositionPct: ctx.risk.maxPositionPct,
      exposureBudget,
      qtyStep: qtyStepFor(ctx.assetClass),
      sizing: inp.sizing,
      volFaktor,
    });
    if (size.qty <= 0) {
      block(`Sizing: ${size.reason}`);
      continue;
    }

    intents.push({
      kind: 'enter',
      symbol: sym,
      side: einstieg.side,
      qty: size.qty,
      stop,
      target,
      refPrice: price,
      reason: einstieg.reason,
      strategy: strategy.id,
      decidedAt: ctx.now,
    });
    notes.push({
      symbol: sym,
      kind: 'decision',
      text: `Enter ${einstieg.side} ${size.qty} @~${price} stop ${stop}${target ? ` ziel ${target}` : ''}: ${einstieg.reason}`,
    });
    openCount++;
    gross += size.notional;
    plannedEntries++;
  }

  return fertig(halt, false, stufenHalt, ausgeloest);
}

/** Position nach einer geschlossenen Bar fortschreiben (Haltedauer, Hochwasser). Identisch in Backtest und Live. */
export function advancePosition(pos: PositionState, close: number): PositionState {
  const highWater = pos.side === 'long' ? Math.max(pos.highWater, close) : Math.min(pos.highWater, close);
  return { ...pos, barsHeld: pos.barsHeld + 1, highWater };
}

/** Neue Position aus einem Fill — Backtest und Live nutzen dieselbe Fabrik. */
export function openPosition(args: {
  symbol: string;
  side: PositionState['side'];
  qty: number;
  fillPrice: number;
  fillTime: Ms;
  stop: number;
  target: number | null;
  strategy: string;
  entryDay: string;
  /** Stufe der Wahl (champion/basis/config) — nur die Engine kennt sie; der Simulator lässt sie weg. */
  stufe?: string | undefined;
}): PositionState {
  return {
    symbol: args.symbol,
    side: args.side,
    qty: args.qty,
    entryPrice: args.fillPrice,
    entryTime: args.fillTime,
    stop: args.stop,
    target: args.target,
    initialStop: args.stop,
    highWater: args.fillPrice,
    strategy: args.strategy,
    barsHeld: 0,
    entryDay: args.entryDay,
    ...(args.stufe !== undefined ? { stufe: args.stufe } : {}),
  };
}
