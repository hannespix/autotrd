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
  indices: {
    US: [
      ['^GSPC', 'S&P 500'], ['^DJI', 'Dow Jones'], ['^IXIC', 'Nasdaq Composite'],
      ['^NDX', 'Nasdaq 100'], ['^RUT', 'Russell 2000'], ['^VIX', 'VIX Volatility'],
    ],
    Europe: [
      ['^GDAXI', 'DAX 40'], ['^FTSE', 'FTSE 100'], ['^FCHI', 'CAC 40'],
      ['^STOXX50E', 'Euro Stoxx 50'], ['^IBEX', 'IBEX 35'], ['^AEX', 'AEX'],
      ['^SSMI', 'SMI Switzerland'], ['FTSEMIB.MI', 'FTSE MIB Italy'],
    ],
    'Asia-Pacific': [
      ['^N225', 'Nikkei 225'], ['^HSI', 'Hang Seng'], ['000001.SS', 'Shanghai Composite'],
      ['^BSESN', 'BSE Sensex'], ['^KS11', 'KOSPI'], ['^AXJO', 'ASX 200'],
      ['^TWII', 'Taiwan Weighted'], ['^STI', 'Straits Times'],
    ],
    Americas: [
      ['^BVSP', 'Bovespa Brazil'], ['^GSPTSE', 'TSX Canada'], ['^MXX', 'IPC Mexico'],
    ],
  },
  forex: {
    Majors: [
      ['EURUSD=X', 'EUR/USD'], ['GBPUSD=X', 'GBP/USD'], ['USDJPY=X', 'USD/JPY'],
      ['USDCHF=X', 'USD/CHF'], ['AUDUSD=X', 'AUD/USD'], ['USDCAD=X', 'USD/CAD'],
      ['NZDUSD=X', 'NZD/USD'], ['DX-Y.NYB', 'US Dollar Index'],
    ],
    Crosses: [
      ['EURGBP=X', 'EUR/GBP'], ['EURJPY=X', 'EUR/JPY'], ['EURCHF=X', 'EUR/CHF'],
      ['GBPJPY=X', 'GBP/JPY'],
    ],
    Emerging: [
      ['USDCNY=X', 'USD/CNY'], ['USDINR=X', 'USD/INR'], ['USDMXN=X', 'USD/MXN'],
      ['USDBRL=X', 'USD/BRL'], ['USDZAR=X', 'USD/ZAR'], ['USDTRY=X', 'USD/TRY'],
    ],
  },
  crypto: {
    Majors: [
      ['BTC-USD', 'Bitcoin'], ['ETH-USD', 'Ethereum'], ['BNB-USD', 'BNB'],
      ['XRP-USD', 'XRP'], ['SOL-USD', 'Solana'], ['ADA-USD', 'Cardano'],
    ],
    Alts: [
      ['DOGE-USD', 'Dogecoin'], ['AVAX-USD', 'Avalanche'], ['DOT-USD', 'Polkadot'],
      ['LINK-USD', 'Chainlink'], ['MATIC-USD', 'Polygon'], ['LTC-USD', 'Litecoin'],
      ['TRX-USD', 'TRON'], ['ATOM-USD', 'Cosmos'],
    ],
  },
  commodities: {
    Metals: [
      ['GC=F', 'Gold'], ['SI=F', 'Silver'], ['PL=F', 'Platinum'],
      ['PA=F', 'Palladium'], ['HG=F', 'Copper'],
    ],
    Energy: [
      ['CL=F', 'WTI Crude Oil'], ['BZ=F', 'Brent Crude'], ['NG=F', 'Natural Gas'],
      ['RB=F', 'Gasoline'], ['HO=F', 'Heating Oil'],
    ],
    Agriculture: [
      ['ZC=F', 'Corn'], ['ZW=F', 'Wheat'], ['ZS=F', 'Soybeans'], ['KC=F', 'Coffee'],
      ['SB=F', 'Sugar'], ['CC=F', 'Cocoa'], ['CT=F', 'Cotton'],
    ],
    'Index Futures': [
      ['ES=F', 'S&P 500 Future'], ['NQ=F', 'Nasdaq 100 Future'],
      ['YM=F', 'Dow Future'], ['RTY=F', 'Russell 2000 Future'],
    ],
  },
  rates_bonds: {
    Yields: [
      ['^IRX', '13w T-Bill'], ['^FVX', '5y Treasury'],
      ['^TNX', '10y Treasury'], ['^TYX', '30y Treasury'],
    ],
    'Bond ETFs': [
      ['TLT', '20y+ Treasury'], ['IEF', '7-10y Treasury'], ['SHY', '1-3y Treasury'],
      ['AGG', 'US Aggregate'], ['LQD', 'IG Corporate'], ['HYG', 'High Yield'],
      ['TIP', 'TIPS Inflation'],
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
      ['GLD', 'Gold'], ['SLV', 'Silver'], ['USO', 'Oil'],
    ],
  },
  stocks_us: {
    'US Mega Cap': [
      ['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['NVDA', 'Nvidia'], ['AMZN', 'Amazon'],
      ['GOOGL', 'Alphabet'], ['META', 'Meta'], ['TSLA', 'Tesla'], ['BRK-B', 'Berkshire'],
      ['JPM', 'JPMorgan'], ['V', 'Visa'], ['XOM', 'Exxon'], ['WMT', 'Walmart'],
    ],
  },
  stocks_global: {
    'Germany (Xetra)': [
      ['SAP.DE', 'SAP'], ['SIE.DE', 'Siemens'], ['ALV.DE', 'Allianz'], ['BMW.DE', 'BMW'],
      ['MBG.DE', 'Mercedes-Benz'], ['VOW3.DE', 'Volkswagen'], ['DTE.DE', 'Deutsche Telekom'],
      ['BAS.DE', 'BASF'], ['RHM.DE', 'Rheinmetall'], ['DBK.DE', 'Deutsche Bank'],
    ],
    Europe: [
      ['MC.PA', 'LVMH'], ['OR.PA', "L'Oreal"], ['TTE.PA', 'TotalEnergies'],
      ['ASML.AS', 'ASML'], ['NESN.SW', 'Nestle'], ['ROG.SW', 'Roche'], ['NOVN.SW', 'Novartis'],
      ['SHEL.L', 'Shell'], ['AZN.L', 'AstraZeneca'], ['HSBA.L', 'HSBC'], ['ULVR.L', 'Unilever'],
    ],
    Asia: [
      ['7203.T', 'Toyota'], ['6758.T', 'Sony'], ['9984.T', 'SoftBank'],
      ['0700.HK', 'Tencent'], ['9988.HK', 'Alibaba'],
      ['RELIANCE.NS', 'Reliance'], ['TCS.NS', 'TCS'],
    ],
  },
};

/** Deutsche UI-Labels + Reihenfolge der Assetklassen. */
export const CLASS_LABELS: Record<string, string> = {
  indices: 'Indizes',
  forex: 'Devisen',
  crypto: 'Krypto',
  commodities: 'Rohstoffe',
  rates_bonds: 'Zinsen & Anleihen',
  etf_sectors: 'Sektor-ETFs',
  etf_regions: 'Regionen-ETFs',
  etf_thematic: 'Themen-ETFs',
  stocks_us: 'US-Aktien',
  stocks_global: 'Globale Aktien',
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

/** Kuratiertes Kompakt-Set für die „Markt-Puls"-Leiste. */
export const MARKET_PULSE: readonly string[] = [
  '^GSPC', '^IXIC', '^GDAXI', '^N225', '^VIX',
  'EURUSD=X', 'USDJPY=X', 'DX-Y.NYB',
  'BTC-USD', 'ETH-USD',
  'GC=F', 'CL=F', '^TNX',
];
