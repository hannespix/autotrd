"""
market_universe — a structured catalog of everything tradeable via yfinance.

Covers indices, forex, crypto, commodities/futures, rates/bonds, sector &
regional & thematic ETFs, and major global single stocks (with the correct
yfinance exchange suffixes). Used by the dashboard's market-overview grid and
by the ticker picker / asset-class filters.

yfinance symbol conventions
---------------------------
  Indices     ^ prefix        ^GSPC, ^GDAXI, ^N225
  Forex       =X suffix       EURUSD=X, USDJPY=X   (DX-Y.NYB = dollar index)
  Crypto      -USD / -EUR     BTC-USD, ETH-EUR
  Futures     =F suffix       GC=F (gold), CL=F (WTI), ES=F (S&P future)
  Rates       ^ prefix        ^TNX (10y yield), ^TYX (30y)
  Stocks      exchange suffix  SAP.DE, MC.PA, ASML.AS, 7203.T, 0700.HK
"""
from __future__ import annotations

# Each entry: (symbol, human name). Grouped by asset class, then region/theme.
CATALOG: dict[str, dict[str, list[tuple[str, str]]]] = {
    "indices": {
        "US": [
            ("^GSPC", "S&P 500"), ("^DJI", "Dow Jones"), ("^IXIC", "Nasdaq Composite"),
            ("^NDX", "Nasdaq 100"), ("^RUT", "Russell 2000"), ("^VIX", "VIX Volatility"),
        ],
        "Europe": [
            ("^GDAXI", "DAX 40"), ("^FTSE", "FTSE 100"), ("^FCHI", "CAC 40"),
            ("^STOXX50E", "Euro Stoxx 50"), ("^IBEX", "IBEX 35"), ("^AEX", "AEX"),
            ("^SSMI", "SMI Switzerland"), ("FTSEMIB.MI", "FTSE MIB Italy"),
        ],
        "Asia-Pacific": [
            ("^N225", "Nikkei 225"), ("^HSI", "Hang Seng"), ("000001.SS", "Shanghai Composite"),
            ("^BSESN", "BSE Sensex"), ("^KS11", "KOSPI"), ("^AXJO", "ASX 200"),
            ("^TWII", "Taiwan Weighted"), ("^STI", "Straits Times"),
        ],
        "Americas": [
            ("^BVSP", "Bovespa Brazil"), ("^GSPTSE", "TSX Canada"), ("^MXX", "IPC Mexico"),
        ],
    },
    "forex": {
        "Majors": [
            ("EURUSD=X", "EUR/USD"), ("GBPUSD=X", "GBP/USD"), ("USDJPY=X", "USD/JPY"),
            ("USDCHF=X", "USD/CHF"), ("AUDUSD=X", "AUD/USD"), ("USDCAD=X", "USD/CAD"),
            ("NZDUSD=X", "NZD/USD"), ("DX-Y.NYB", "US Dollar Index"),
        ],
        "Crosses": [
            ("EURGBP=X", "EUR/GBP"), ("EURJPY=X", "EUR/JPY"), ("EURCHF=X", "EUR/CHF"),
            ("GBPJPY=X", "GBP/JPY"),
        ],
        "Emerging": [
            ("USDCNY=X", "USD/CNY"), ("USDINR=X", "USD/INR"), ("USDMXN=X", "USD/MXN"),
            ("USDBRL=X", "USD/BRL"), ("USDZAR=X", "USD/ZAR"), ("USDTRY=X", "USD/TRY"),
        ],
    },
    "crypto": {
        "Majors": [
            ("BTC-USD", "Bitcoin"), ("ETH-USD", "Ethereum"), ("BNB-USD", "BNB"),
            ("XRP-USD", "XRP"), ("SOL-USD", "Solana"), ("ADA-USD", "Cardano"),
        ],
        "Alts": [
            ("DOGE-USD", "Dogecoin"), ("AVAX-USD", "Avalanche"), ("DOT-USD", "Polkadot"),
            ("LINK-USD", "Chainlink"), ("MATIC-USD", "Polygon"), ("LTC-USD", "Litecoin"),
            ("TRX-USD", "TRON"), ("ATOM-USD", "Cosmos"),
        ],
    },
    "commodities": {
        "Metals": [
            ("GC=F", "Gold"), ("SI=F", "Silver"), ("PL=F", "Platinum"),
            ("PA=F", "Palladium"), ("HG=F", "Copper"),
        ],
        "Energy": [
            ("CL=F", "WTI Crude Oil"), ("BZ=F", "Brent Crude"), ("NG=F", "Natural Gas"),
            ("RB=F", "Gasoline"), ("HO=F", "Heating Oil"),
        ],
        "Agriculture": [
            ("ZC=F", "Corn"), ("ZW=F", "Wheat"), ("ZS=F", "Soybeans"), ("KC=F", "Coffee"),
            ("SB=F", "Sugar"), ("CC=F", "Cocoa"), ("CT=F", "Cotton"),
        ],
        "Index Futures": [
            ("ES=F", "S&P 500 Future"), ("NQ=F", "Nasdaq 100 Future"),
            ("YM=F", "Dow Future"), ("RTY=F", "Russell 2000 Future"),
        ],
    },
    "rates_bonds": {
        "Yields": [
            ("^IRX", "13w T-Bill"), ("^FVX", "5y Treasury"),
            ("^TNX", "10y Treasury"), ("^TYX", "30y Treasury"),
        ],
        "Bond ETFs": [
            ("TLT", "20y+ Treasury"), ("IEF", "7-10y Treasury"), ("SHY", "1-3y Treasury"),
            ("AGG", "US Aggregate"), ("LQD", "IG Corporate"), ("HYG", "High Yield"),
            ("TIP", "TIPS Inflation"),
        ],
    },
    "etf_sectors": {
        "US Sectors (SPDR)": [
            ("XLK", "Technology"), ("XLF", "Financials"), ("XLE", "Energy"),
            ("XLV", "Health Care"), ("XLI", "Industrials"), ("XLY", "Cons. Discretionary"),
            ("XLP", "Cons. Staples"), ("XLU", "Utilities"), ("XLB", "Materials"),
            ("XLRE", "Real Estate"), ("XLC", "Communication"),
        ],
    },
    "etf_regions": {
        "Broad / Region": [
            ("SPY", "S&P 500"), ("QQQ", "Nasdaq 100"), ("DIA", "Dow 30"), ("IWM", "Russell 2000"),
            ("VTI", "US Total Market"), ("EFA", "Developed ex-US"), ("EEM", "Emerging Markets"),
            ("VGK", "Europe"), ("EWJ", "Japan"), ("FXI", "China"), ("EWG", "Germany"),
            ("EWZ", "Brazil"), ("INDA", "India"),
        ],
    },
    "etf_thematic": {
        "Themes": [
            ("ARKK", "ARK Innovation"), ("SMH", "Semiconductors"), ("SOXX", "Semiconductors"),
            ("IBB", "Biotech"), ("ICLN", "Clean Energy"), ("TAN", "Solar"), ("LIT", "Battery/Lithium"),
            ("JETS", "Airlines"), ("HACK", "Cybersecurity"), ("BOTZ", "Robotics/AI"),
            ("GLD", "Gold"), ("SLV", "Silver"), ("USO", "Oil"),
        ],
    },
    "stocks_us": {
        "US Mega Cap": [
            ("AAPL", "Apple"), ("MSFT", "Microsoft"), ("NVDA", "Nvidia"), ("AMZN", "Amazon"),
            ("GOOGL", "Alphabet"), ("META", "Meta"), ("TSLA", "Tesla"), ("BRK-B", "Berkshire"),
            ("JPM", "JPMorgan"), ("V", "Visa"), ("XOM", "Exxon"), ("WMT", "Walmart"),
        ],
    },
    "stocks_global": {
        "Germany (Xetra)": [
            ("SAP.DE", "SAP"), ("SIE.DE", "Siemens"), ("ALV.DE", "Allianz"), ("BMW.DE", "BMW"),
            ("MBG.DE", "Mercedes-Benz"), ("VOW3.DE", "Volkswagen"), ("DTE.DE", "Deutsche Telekom"),
            ("BAS.DE", "BASF"), ("RHM.DE", "Rheinmetall"), ("DBK.DE", "Deutsche Bank"),
        ],
        "Europe": [
            ("MC.PA", "LVMH"), ("OR.PA", "L'Oreal"), ("TTE.PA", "TotalEnergies"),
            ("ASML.AS", "ASML"), ("NESN.SW", "Nestle"), ("ROG.SW", "Roche"), ("NOVN.SW", "Novartis"),
            ("SHEL.L", "Shell"), ("AZN.L", "AstraZeneca"), ("HSBA.L", "HSBC"), ("ULVR.L", "Unilever"),
        ],
        "Asia": [
            ("7203.T", "Toyota"), ("6758.T", "Sony"), ("9984.T", "SoftBank"),
            ("0700.HK", "Tencent"), ("9988.HK", "Alibaba"),
            ("RELIANCE.NS", "Reliance"), ("TCS.NS", "TCS"),
        ],
    },
}

# Human labels + ordering for the UI.
CLASS_LABELS = {
    "indices": "Indizes",
    "forex": "Devisen",
    "crypto": "Krypto",
    "commodities": "Rohstoffe",
    "rates_bonds": "Zinsen & Anleihen",
    "etf_sectors": "Sektor-ETFs",
    "etf_regions": "Regionen-ETFs",
    "etf_thematic": "Themen-ETFs",
    "stocks_us": "US-Aktien",
    "stocks_global": "Globale Aktien",
}


def all_symbols(asset_class: str | None = None) -> list[str]:
    """Flat list of every symbol, optionally filtered to one asset class."""
    out: list[str] = []
    classes = [asset_class] if asset_class else list(CATALOG)
    for cls in classes:
        for group in CATALOG.get(cls, {}).values():
            out.extend(sym for sym, _ in group)
    return out


def name_map() -> dict[str, str]:
    """symbol -> human name across the whole catalog."""
    m: dict[str, str] = {}
    for groups in CATALOG.values():
        for group in groups.values():
            for sym, nm in group:
                m[sym] = nm
    return m


_NAME_CACHE: dict[str, str] = {}


def resolve_name(symbol: str) -> str:
    """Human-readable name for a symbol: catalog first, then a cached yfinance
    lookup, else the symbol itself. Used for the 'what does this ticker mean' labels."""
    s = symbol.strip().upper()
    if s in _NAME_CACHE:
        return _NAME_CACHE[s]
    nm = name_map().get(s)
    if not nm:
        try:
            import yfinance as yf
            info = yf.Ticker(s).info or {}
            nm = info.get("shortName") or info.get("longName")
        except Exception:
            nm = None
    nm = nm or s
    _NAME_CACHE[s] = nm
    return nm


def classify(symbol: str) -> str:
    """Best-effort asset-class guess from a symbol's yfinance convention."""
    s = symbol.strip().upper()
    if s.endswith("=X") or s == "DX-Y.NYB":
        return "forex"
    if s.endswith("=F"):
        return "commodities"
    if s.endswith("-USD") or s.endswith("-EUR"):
        return "crypto"
    if s in ("^TNX", "^TYX", "^FVX", "^IRX"):
        return "rates_bonds"
    if s.startswith("^"):
        return "indices"
    # Known catalog membership wins over the suffix heuristic
    for cls, groups in CATALOG.items():
        for group in groups.values():
            if any(sym.upper() == s for sym, _ in group):
                return cls
    return "stocks_us" if "." not in s else "stocks_global"


# Curated compact set for the top "market pulse" strip.
MARKET_PULSE = [
    "^GSPC", "^IXIC", "^GDAXI", "^N225", "^VIX",
    "EURUSD=X", "USDJPY=X", "DX-Y.NYB",
    "BTC-USD", "ETH-USD",
    "GC=F", "CL=F", "^TNX",
]

if __name__ == "__main__":
    total = len(all_symbols())
    print(f"market_universe: {total} symbols across {len(CATALOG)} asset classes")
    for cls in CATALOG:
        print(f"  {CLASS_LABELS[cls]:<20} {len(all_symbols(cls))} symbols")
