/**
 * Markt-Universum — Port von reference/scripts/market_universe.py.
 *
 * Katalog aller handelbaren Assets (yfinance-Symbolkonventionen), gruppiert
 * nach Assetklasse → Region/Thema. Pure Daten + Helfer; wird von Functions
 * (meta/universe-Seed, Scan) und Frontend (Picker, Klarnamen) genutzt.
 *
 * Konventionen: Indizes `^`-Präfix (^GSPC), Forex `=X` (EURUSD=X),
 * Krypto `-USD`/`-EUR` (BTC-USD), Futures `=F` (GC=F), Aktien mit
 * Börsen-Suffix (SAP.DE, 7203.T).
 */

export type CatalogEntry = readonly [symbol: string, name: string];
export type Catalog = Record<string, Record<string, readonly CatalogEntry[]>>;

export const CATALOG: Catalog = {
  /*
   * ── Indizes: NUR was als Signal gebraucht wird ──────────────────────────
   *
   * Alpaca handelt keine Indizes. Die 25 Einträge von früher waren deshalb
   * reine Scan-Kosten ohne die Möglichkeit eines Trades. Geblieben sind die
   * beiden, die tatsächlich etwas STEUERN:
   *
   *   ^GSPC — Marktfilter des Momentum-Sockels (`MARKET_INDEX`). Als Signal
   *           ist er das breiteste verfügbare US-Bild; gekauft wird SPY.
   *   ^VIX  — Regime-Ampel im Scan. Für ihn gibt es keinen brauchbaren
   *           handelbaren Vertreter: VIXY und UVXY sind Futures-ETFs mit
   *           Rollverlust und bilden den Index nicht ab.
   *
   * Beide werden NIE gekauft (`isTradable` sperrt alles mit `^`).
   */
  indices: {
    'Nur Signal': [
      ['^GSPC', 'S&P 500 (Marktfilter)'], ['^VIX', 'VIX Volatilität (Regime)'],
    ],
  },
  crypto: {
    Majors: [
      ['BTC-USD', 'Bitcoin'], ['ETH-USD', 'Ethereum'], ['BNB-USD', 'BNB'],
      ['XRP-USD', 'XRP'], ['SOL-USD', 'Solana'], ['ADA-USD', 'Cardano'],
    ],
    Alts: [
      ['DOGE-USD', 'Dogecoin'], ['AVAX-USD', 'Avalanche'], ['DOT-USD', 'Polkadot'],
      ['LINK-USD', 'Chainlink'], ['LTC-USD', 'Litecoin'],
      ['TRX-USD', 'TRON'], ['ATOM-USD', 'Cosmos'],
      /*
       * Polygon ist hier ENTFERNT (09.08.), und der Grund ist doppelt.
       *
       * `POL-USD` heißt bei Yahoo „Proof Of Liquidity USD" — das ist nicht
       * Polygon, sondern ein anderer Token. Der Katalog hätte also unter dem
       * Namen „Polygon" etwas anderes gehandelt.
       *
       * Und brauchbar ist keiner von beiden: POL-USD und MATIC-USD liefern
       * beide 0 Bars für range=5d/1mo/1y, Daten nur noch über range=max, mit
       * letztem Tag 03.08. Das Spark-Bündel gibt für POL-USD 0 Closes zurück.
       *
       * Der Preis dafür war nicht bloß ein fehlendes Symbol: Der Scan meldete
       * dauerhaft `symbolsFailed: 1` und die Katalog-Versorgung
       * `catalogQuotes: 0`. Ein Dauerfehler in einem Fehlerzähler ist
       * schlimmer als das fehlende Symbol — er macht den Zähler blind für den
       * ZWEITEN Ausfall.
       *
       * Wenn Polygon zurücksoll, braucht es vorher einen Ticker, der aktuelle
       * Tages-Bars liefert.
       */
    ],
  },
  rates_bonds: {
    /*
     * Die vier Rendite-INDIZES (^IRX, ^FVX, ^TNX, ^TYX) sind entfernt: Sie
     * sind Prozentzahlen, kein Papier, und wurden von keiner Logik gelesen —
     * anders als ^GSPC und ^VIX, die etwas steuern. Die Zinskurve bildet sich
     * über die Laufzeiten der Bond-ETFs ohnehin ab, und die sind handelbar.
     */
    'Bond ETFs': [
      ['TLT', '20y+ Treasury'], ['IEF', '7-10y Treasury'], ['SHY', '1-3y Treasury'],
      ['AGG', 'US Aggregate'], ['LQD', 'IG Corporate'], ['HYG', 'High Yield'],
      ['TIP', 'TIPS Inflation'], ['BIL', '1-3m T-Bill'],
    ],
  },
  etf_sectors: {
    'US Sectors (SPDR)': [
      ['XLK', 'Technology'], ['XLF', 'Financials'], ['XLE', 'Energy'],
      ['XLV', 'Health Care'], ['XLI', 'Industrials'], ['XLY', 'Cons. Discretionary'],
      ['XLP', 'Cons. Staples'], ['XLU', 'Utilities'], ['XLB', 'Materials'],
      ['XLRE', 'Real Estate'], ['XLC', 'Communication'],
    ],
  },
  etf_regions: {
    'Broad / Region': [
      ['SPY', 'S&P 500'], ['QQQ', 'Nasdaq 100'], ['DIA', 'Dow 30'], ['IWM', 'Russell 2000'],
      ['VTI', 'US Total Market'], ['EFA', 'Developed ex-US'], ['EEM', 'Emerging Markets'],
      ['VGK', 'Europe'], ['EWJ', 'Japan'], ['FXI', 'China'], ['EWG', 'Germany'],
      ['EWZ', 'Brazil'], ['INDA', 'India'],
    ],
  },
  etf_thematic: {
    Themes: [
      ['ARKK', 'ARK Innovation'], ['SMH', 'Semiconductors'], ['SOXX', 'Semiconductors'],
      ['IBB', 'Biotech'], ['ICLN', 'Clean Energy'], ['TAN', 'Solar'], ['LIT', 'Battery/Lithium'],
      ['JETS', 'Airlines'], ['HACK', 'Cybersecurity'], ['BOTZ', 'Robotics/AI'],
    ],
    /*
     * ── Rohstoffe als ETF statt als Future ──────────────────────────────────
     *
     * Vorher standen hier 21 Futures (GC=F, CL=F, ZC=F …). Alpaca handelt
     * keine Futures, und ein Kontrakt-Rollover ist ohnehin nichts, was diese
     * Engine modelliert. Die ETFs bilden dieselbe wirtschaftliche Wette ab,
     * laufen an der US-Börse und sind orderbar.
     *
     * Bewusst nur die liquiden: Ein Agrar-ETF mit 20.000 Stück Tagesumsatz
     * hätte einen Spread, den unser Kostenmodell nicht kennt — und die
     * gemessene Netto-Kante liegt im Bereich von 0,3 % je Signal.
     */
    Rohstoffe: [
      ['GLD', 'Gold'], ['SLV', 'Silber'], ['PPLT', 'Platin'], ['CPER', 'Kupfer'],
      ['USO', 'Öl (WTI)'], ['BNO', 'Öl (Brent)'], ['UNG', 'Erdgas'],
      ['DBA', 'Agrar breit'], ['PDBC', 'Rohstoffkorb'],
    ],
  },
  stocks_us: {
    /*
     * ── Der eigentliche Alpaca-Raum ─────────────────────────────────────────
     *
     * Von 12 auf 60 der liquidesten US-Werte, über alle Sektoren gestreut.
     * Der Ausbau ist KOSTENNEUTRAL: Er finanziert sich aus den 96 Symbolen,
     * die Alpaca nie handeln konnte und die trotzdem alle fünf Minuten
     * mitversorgt wurden.
     *
     * Die Auswahl folgt zwei Regeln: Tagesumsatz weit über dem, was unsere
     * Positionsgrößen bewegen (damit der Spread nicht die Kante frisst), und
     * Streuung über Sektoren — die Korrelations-Cluster weiter unten sind
     * sonst wirkungslos, weil sie nur EINE Wette in Scheiben schneiden.
     */
    'Technologie': [
      ['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['NVDA', 'Nvidia'], ['AVGO', 'Broadcom'],
      ['AMD', 'AMD'], ['INTC', 'Intel'], ['QCOM', 'Qualcomm'], ['TXN', 'Texas Instruments'],
      ['MU', 'Micron'], ['ORCL', 'Oracle'], ['CRM', 'Salesforce'], ['ADBE', 'Adobe'],
      ['CSCO', 'Cisco'], ['IBM', 'IBM'], ['PLTR', 'Palantir'],
    ],
    'Kommunikation & Konsum': [
      ['GOOGL', 'Alphabet'], ['META', 'Meta'], ['NFLX', 'Netflix'], ['DIS', 'Disney'],
      ['AMZN', 'Amazon'], ['TSLA', 'Tesla'], ['HD', 'Home Depot'], ['MCD', "McDonald's"],
      ['NKE', 'Nike'], ['SBUX', 'Starbucks'], ['LOW', "Lowe's"], ['BKNG', 'Booking'],
    ],
    'Finanzen': [
      ['BRK-B', 'Berkshire'], ['JPM', 'JPMorgan'], ['BAC', 'Bank of America'],
      ['WFC', 'Wells Fargo'], ['GS', 'Goldman Sachs'], ['MS', 'Morgan Stanley'],
      ['V', 'Visa'], ['MA', 'Mastercard'], ['AXP', 'American Express'],
      ['BLK', 'BlackRock'], ['SCHW', 'Charles Schwab'],
    ],
    'Gesundheit': [
      ['UNH', 'UnitedHealth'], ['JNJ', 'Johnson & Johnson'], ['LLY', 'Eli Lilly'],
      ['ABBV', 'AbbVie'], ['MRK', 'Merck'], ['PFE', 'Pfizer'], ['TMO', 'Thermo Fisher'],
      ['ABT', 'Abbott'], ['AMGN', 'Amgen'],
    ],
    'Industrie & Energie': [
      ['XOM', 'Exxon'], ['CVX', 'Chevron'], ['COP', 'ConocoPhillips'], ['SLB', 'SLB'],
      ['CAT', 'Caterpillar'], ['DE', 'Deere'], ['BA', 'Boeing'], ['GE', 'GE Aerospace'],
      ['HON', 'Honeywell'], ['UPS', 'UPS'], ['LMT', 'Lockheed Martin'],
    ],
    'Basiskonsum & Versorger': [
      ['WMT', 'Walmart'], ['COST', 'Costco'], ['PG', 'Procter & Gamble'], ['KO', 'Coca-Cola'],
      ['PEP', 'PepsiCo'], ['PM', 'Philip Morris'], ['NEE', 'NextEra Energy'], ['DUK', 'Duke Energy'],
    ],
  },
};

/**
 * Deutsche UI-Labels + Reihenfolge der Assetklassen.
 *
 * `forex`, `commodities` und `stocks_global` stehen weiterhin hier, obwohl der
 * Katalog sie nicht mehr führt: `classify()` kann sie für Alt-Bestände und
 * Alt-Statistiken immer noch zurückgeben (ein Trade in SAP.DE aus der Zeit
 * davor, ein Klassen-Aggregat in der Rückschau). Ohne Label stünde dort ein
 * roher Schlüssel. Neue Symbole dieser Klassen entstehen nicht mehr.
 */
export const CLASS_LABELS: Record<string, string> = {
  indices: 'Indizes (nur Signal)',
  crypto: 'Krypto',
  rates_bonds: 'Zinsen & Anleihen',
  etf_sectors: 'Sektor-ETFs',
  etf_regions: 'Regionen-ETFs',
  etf_thematic: 'Themen-ETFs',
  stocks_us: 'US-Aktien',
  // Nur noch für Altbestände (siehe oben) — nicht mehr im Katalog:
  forex: 'Devisen (historisch)',
  commodities: 'Rohstoffe (historisch)',
  stocks_global: 'Globale Aktien (historisch)',
};

/** Flache Symbolliste, optional auf eine Assetklasse gefiltert. */
export function allSymbols(assetClass?: string): string[] {
  const classes = assetClass ? [assetClass] : Object.keys(CATALOG);
  const out: string[] = [];
  for (const cls of classes) {
    for (const group of Object.values(CATALOG[cls] ?? {})) {
      for (const [sym] of group) out.push(sym);
    }
  }
  return out;
}

/** symbol → Klarname über den ganzen Katalog. */
export function nameMap(): Record<string, string> {
  const m: Record<string, string> = {};
  for (const groups of Object.values(CATALOG)) {
    for (const group of Object.values(groups)) {
      for (const [sym, nm] of group) m[sym] = nm;
    }
  }
  return m;
}

/** Klarname eines Symbols (Katalog, sonst das Symbol selbst — pure Variante). */
export function resolveName(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  return nameMap()[s] ?? s;
}

/** Best-effort-Assetklasse aus der yfinance-Konvention (Port von classify()). */
export function classify(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (s.endsWith('=X') || s === 'DX-Y.NYB') return 'forex';
  if (s.endsWith('=F')) return 'commodities';
  if (s.endsWith('-USD') || s.endsWith('-EUR')) return 'crypto';
  if (['^TNX', '^TYX', '^FVX', '^IRX'].includes(s)) return 'rates_bonds';
  if (s.startsWith('^')) return 'indices';
  for (const [cls, groups] of Object.entries(CATALOG)) {
    for (const group of Object.values(groups)) {
      if (group.some(([sym]) => sym.toUpperCase() === s)) return cls;
    }
  }
  return s.includes('.') ? 'stocks_global' : 'stocks_us';
}

/**
 * Notierungswährung aus der yfinance-Symbol-Konvention (04.08.).
 *
 * Warum das überhaupt nötig ist: Der Kontostand ist hart in USD geführt
 * (`Wallet.currency`), und der Katalog enthält Papiere, die gar nicht in USD
 * notieren — `BMW.DE` in Euro, `7203.T` in Yen, `AZN.L` sogar in **Pence**,
 * nicht Pfund. Diese Papiere sind über `isTradable` bereits ausgeschlossen
 * (`stocks_global`), aber die Währung am Trade festzuhalten kostet nichts und
 * macht einen Buchungsfehler nachträglich erkennbar statt unsichtbar.
 *
 * Best effort: Yahoo liefert die Währung im Meta-Block mit — wo die vorliegt,
 * hat sie Vorrang. Diese Funktion ist der Fallback fürs reine Symbol.
 */
const BOERSEN_WAEHRUNG: Record<string, string> = {
  DE: 'EUR', PA: 'EUR', AS: 'EUR', MI: 'EUR', MC: 'EUR', BR: 'EUR', LS: 'EUR',
  VI: 'EUR', HE: 'EUR', IR: 'EUR',
  L: 'GBp', // London notiert in PENCE — Faktor 100 gegenüber GBP
  T: 'JPY', HK: 'HKD', SS: 'CNY', SZ: 'CNY', KS: 'KRW', TW: 'TWD',
  SW: 'CHF', ST: 'SEK', OL: 'NOK', CO: 'DKK',
  TO: 'CAD', V: 'CAD', AX: 'AUD', NZ: 'NZD', SI: 'SGD', BO: 'INR', NS: 'INR',
  SA: 'BRL', MX: 'MXN', JO: 'ZAR', TA: 'ILS',
};

export function currencyForSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (s.endsWith('-EUR')) return 'EUR';
  if (s.endsWith('=X')) return s.slice(0, -2).slice(-3) || 'USD'; // EURUSD=X → USD
  const punkt = s.lastIndexOf('.');
  if (punkt > 0) {
    const suffix = s.slice(punkt + 1);
    const waehrung = BOERSEN_WAEHRUNG[suffix];
    if (waehrung) return waehrung;
  }
  return 'USD';
}

/* ── Handelbarkeit (Befund 28.07.) ──────────────────────────────────────────
 *
 * Von den 40 Symbolen, die der Scan an diesem Tag beobachtete, waren 25
 * Aktienindizes: ^GSPC, ^DJI, ^N225, ^HSI und so weiter. Die kann man nicht
 * kaufen. `^GSPC` ist eine Zahl, kein Instrument — kein Broker der Welt
 * verkauft dir den S&P-500-INDEX, nur ETFs darauf.
 *
 * Im Paper-Konto fällt das nicht auf, weil wir so tun als ob. Real war die
 * Strategie damit NICHT AUSFÜHRBAR, und jede Auswertung maß etwas, das es
 * nicht zu kaufen gibt. Das ist kein Optimierungsthema, sondern ein
 * Korrektheitsthema: Solange das drinsteht, ist jede Kennzahl wertlos.
 *
 * Der Maßstab ist bewusst der Broker, auf den M13/M14 zielen: Alpaca handelt
 * US-Aktien, US-ETFs und Krypto. Alles andere — Devisen, Futures,
 * Auslandsbörsen, Rendite-Indizes — ist über diesen Weg nicht erreichbar.
 *
 * Die nicht handelbaren Symbole bleiben im Katalog. Sie sind als SIGNAL
 * weiterhin wertvoll: ^GSPC trägt den Marktfilter der Momentum-Strategie,
 * ^VIX misst die Nervosität, die Auslandsindizes zeigen die Weltlage. Nur
 * kaufen kann man sie eben nicht. */

/** Symbole, die trotz `^`/Sonderform HANDELBAR sind (heute: keine). */
const TRADABLE_EXCEPTIONS = new Set<string>();

/** Klassen, deren Symbole über den Alpaca-Weg handelbar sind. */
const TRADABLE_CLASSES = new Set([
  'stocks_us',
  'etf_sectors',
  'etf_regions',
  'etf_thematic',
  'crypto',
]);

/**
 * Lässt sich dieses Symbol tatsächlich kaufen?
 *
 * `rates_bonds` ist gemischt: Die Bond-ETFs (TLT, IEF …) sind ganz normale
 * US-ETFs, die Rendite-Indizes (^TNX, ^IRX …) sind Prozentzahlen. Deshalb
 * entscheidet dort nicht die Klasse, sondern das `^`.
 */
export function isTradable(symbol: string): boolean {
  const s = symbol.trim().toUpperCase();
  if (TRADABLE_EXCEPTIONS.has(s)) return true;
  if (s.startsWith('^')) return false; // Indizes und Renditen: reine Zahlen
  if (s.endsWith('=X') || s === 'DX-Y.NYB') return false; // Devisen: nicht über Alpaca
  if (s.endsWith('=F')) return false; // Futures: Kontrakt-Rollover modellieren wir nicht
  const cls = classify(s);
  if (cls === 'rates_bonds') return true; // hier bleiben nur die Bond-ETFs übrig
  if (cls === 'stocks_global') return false; // Auslandsbörsen nicht erreichbar
  return TRADABLE_CLASSES.has(cls);
}

/** Alle handelbaren Katalog-Symbole. */
export function tradableSymbols(assetClass?: string): string[] {
  return allSymbols(assetClass).filter(isTradable);
}

/* ── Korrelations-Cluster (Befund 28.07.) ───────────────────────────────────
 *
 * Dieselben 40 Symbole nochmal, anders sortiert: 25 Aktienindizes und 12
 * Devisenkreuze, davon die meisten USD-Paare. Globale Aktienindizes laufen
 * im Absturz mit 0,8 bis 0,9 Korrelation, USD-Kreuze sind größtenteils
 * dieselbe Dollar-Wette.
 *
 * Vierzig Positionen waren also in Wahrheit ungefähr ZWEI Wetten. Das
 * Positionslimit streute damit gar nichts — es vervielfachte dieselbe Wette
 * und multiplizierte nur die Gebühren. Und im Drawdown, also genau dann,
 * wenn Streuung zählt, fallen sie gemeinsam.
 *
 * Der Cluster ist bewusst grob. Eine gerechnete Korrelationsmatrix wäre
 * genauer, aber sie hätte einen Nachteil, der schwerer wiegt: Sie ist
 * rückwärtsgewandt und bricht zusammen, wenn im Crash alles auf 1 geht —
 * also genau dann, wenn man sie braucht. Eine feste Zuordnung nach
 * wirtschaftlicher Herkunft kennt diesen Fehlermodus nicht. */

const CLUSTER_OVERRIDES: Record<string, string> = {
  /*
   * Rohstoff-ETFs gehören zum Rohstoff, nicht zu den Aktien.
   *
   * Ohne diese Zuordnung landeten sie über `classify` in `etf_thematic` und
   * damit im Block `aktien_sektor` — und das Positionslimit hielte GLD, SLV
   * und PPLT für drei Aktienwetten. Sie sind aber eine Metallwette, und im
   * Drawdown laufen sie zusammen. Seit dem Alpaca-Umbau (10.08.) sind die
   * Rohstoffe ETFs statt Futures; die Zuordnung wandert deshalb von den
   * `=F`-Mengen hierher.
   */
  GLD: 'rohstoff_metall', SLV: 'rohstoff_metall',
  PPLT: 'rohstoff_metall', CPER: 'rohstoff_metall',
  USO: 'rohstoff_energie', BNO: 'rohstoff_energie', UNG: 'rohstoff_energie',
  DBA: 'rohstoff_agrar',
  // Ein breiter Rohstoffkorb ist überwiegend Energie — so wird er gewichtet.
  PDBC: 'rohstoff_energie',
  // Energie-nahe Aktien-ETFs laufen mit dem Ölpreis, nicht mit dem Index
  XLE: 'rohstoff_energie', ICLN: 'rohstoff_energie', TAN: 'rohstoff_energie',
};

const US_BREIT = new Set(['SPY', 'QQQ', 'DIA', 'IWM', 'VTI']);
const INTL_ETFS = new Set(['EFA', 'EEM', 'VGK', 'EWJ', 'FXI', 'EWG', 'EWZ', 'INDA']);
/* Die Futures-Mengen bleiben, obwohl der Katalog keine `=F`-Symbole mehr
 * führt: `correlationCluster` bekommt auch Symbole aus ALTEN Positionen und
 * alten Statistiken zu sehen, und die sollen weiter richtig eingeordnet
 * werden. Neue entstehen nicht mehr. */
const METALLE = new Set(['GC=F', 'SI=F', 'PL=F', 'PA=F', 'HG=F']);
const ENERGIE = new Set(['CL=F', 'BZ=F', 'NG=F', 'RB=F', 'HO=F']);
const US_INDIZES = new Set(['^GSPC', '^DJI', '^IXIC', '^NDX', '^RUT']);

/**
 * Grober Korrelationsblock eines Symbols.
 *
 * Wer hier etwas ändert, ändert die tatsächliche Streuung des Depots —
 * nicht bloß eine Anzeige.
 */
export function correlationCluster(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  const over = CLUSTER_OVERRIDES[s];
  if (over) return over;
  if (s === '^VIX') return 'volatilitaet'; // läuft GEGEN Aktien, eigener Block
  if (s.endsWith('=X') || s === 'DX-Y.NYB') {
    // Alles mit USD auf einer Seite ist dieselbe Dollar-Wette.
    return s.includes('USD') || s === 'DX-Y.NYB' ? 'fx_usd' : 'fx_kreuz';
  }
  if (METALLE.has(s)) return 'rohstoff_metall';
  if (ENERGIE.has(s)) return 'rohstoff_energie';
  if (s.endsWith('=F')) return 'rohstoff_agrar'; // Rest der Futures: Agrar + Index-Futures
  const cls = classify(s);
  if (cls === 'crypto') return 'krypto';
  if (cls === 'rates_bonds') return 'zinsen';
  if (cls === 'indices') return US_INDIZES.has(s) ? 'aktien_us_breit' : 'aktien_intl';
  if (cls === 'etf_regions') {
    if (US_BREIT.has(s)) return 'aktien_us_breit';
    if (INTL_ETFS.has(s)) return 'aktien_intl';
    return 'aktien_us_breit';
  }
  if (cls === 'etf_sectors' || cls === 'etf_thematic') return 'aktien_sektor';
  if (cls === 'stocks_global') return 'aktien_intl_einzel';
  return 'aktien_us_einzel';
}

/**
 * Wie viele Positionen ein einzelner Korrelationsblock höchstens stellen darf.
 *
 * 3 von 10 ist die Grenze, ab der ein Block das Depot dominiert. Höher wäre
 * kosmetisch: Bei 5 gleichlaufenden Positionen von 10 bestimmt dieser eine
 * Block die halbe Kurve, und die Streuung ist wieder Behauptung statt
 * Eigenschaft.
 */
export const MAX_PER_CLUSTER = 3;

/**
 * Darf noch eine Position aus diesem Block eröffnet werden?
 *
 * `offen` sind die Symbole der bereits gehaltenen Positionen. Pure Funktion,
 * damit die Regel einzeln testbar ist — sie entscheidet über echtes Geld.
 */
export function clusterHasRoom(
  offen: readonly string[],
  symbol: string,
  max = MAX_PER_CLUSTER,
): boolean {
  const ziel = correlationCluster(symbol);
  let n = 0;
  for (const sym of offen) {
    if (correlationCluster(sym) === ziel) n += 1;
    if (n >= max) return false;
  }
  return true;
}

/** Kuratiertes Kompakt-Set für die „Markt-Puls"-Leiste. */
export const MARKET_PULSE: readonly string[] = [
  '^GSPC', '^IXIC', '^GDAXI', '^N225', '^VIX',
  'EURUSD=X', 'USDJPY=X', 'DX-Y.NYB',
  'BTC-USD', 'ETH-USD',
  'GC=F', 'CL=F', '^TNX',
];
