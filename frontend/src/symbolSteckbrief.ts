/**
 * Symbol-Steckbriefe (Owner 21.08., 16:5x: „mehr Infos zu den einzelnen
 * Symbolen … welche Marken, welche Märkte, was verbirgt sich hinter dem
 * Kürzel — sei kreativ, ohne zu überladen").
 *
 * Eine kuratierte Zeile je Katalog-Symbol: Bei ETFs die Antwort „was steckt
 * WIRKLICH drin" (größte Positionen/Markt), bei Aktien das Geschäft hinter
 * dem Namen, bei Krypto/Rohstoffen die Einordnung. Klasse und Gruppe kommen
 * aus dem Katalog selbst (shared/universe) — hier lebt nur der Erklärtext.
 *
 * Deutsch zuerst (i18n-Fallback-Prinzip der phasenweisen Übersetzung); die
 * EN-Fassung folgt als eigene Tranche. Die Texte sind Stand August 2026 und
 * BESCHREIBUNG, keine Empfehlung — Gewichtungen in ETFs verschieben sich.
 */
import { CATALOG, CLASS_LABELS } from '@autotrd/shared';

export interface SymbolHerkunft {
  klasse: string;
  klassenLabel: string;
  gruppe: string;
  name: string;
}

/** Klasse, Gruppe und Klarname eines Katalog-Symbols (null = nicht im Katalog). */
export function symbolHerkunft(sym: string): SymbolHerkunft | null {
  for (const [klasse, gruppen] of Object.entries(CATALOG)) {
    for (const [gruppe, eintraege] of Object.entries(gruppen)) {
      for (const [s, name] of eintraege) {
        if (s === sym) {
          return { klasse, klassenLabel: CLASS_LABELS[klasse] ?? klasse, gruppe, name };
        }
      }
    }
  }
  return null;
}

/** Kuratierte Kurzbeschreibung je Symbol — die Marken/Märkte hinterm Kürzel. */
export const STECKBRIEFE: Record<string, string> = {
  // ── Indizes (nur Signal, nie gekauft) ──
  '^GSPC': 'Der S&P-500-INDEX selbst — 500 größte US-Konzerne. Dient hier als Marktfilter; handelbar ist sein ETF-Vertreter SPY.',
  '^VIX': 'Das „Angstbarometer": erwartete 30-Tage-Schwankung des S&P 500. Steuert die Regime-Ampel; wird nie gehandelt.',
  // ── Krypto ──
  'BTC-USD': 'Bitcoin gegen US-Dollar — größte Kryptowährung, digitales Knappheitsgut, 24/7 gehandelt.',
  'ETH-USD': 'Ethereum — zweitgrößte Kryptowährung und Plattform für Smart Contracts und DeFi.',
  'BNB-USD': 'BNB — Börsen-Token des Binance-Ökosystems (Gebühren-Rabatte, BNB Chain).',
  'XRP-USD': 'XRP — auf schnelle, günstige Zahlungsabwicklung ausgerichtet (Ripple-Ökosystem).',
  'SOL-USD': 'Solana — Hochdurchsatz-Blockchain, beliebt für DeFi und NFT-Anwendungen.',
  'ADA-USD': 'Cardano — forschungsgetriebene Proof-of-Stake-Blockchain.',
  'DOGE-USD': 'Dogecoin — die bekannteste Meme-Währung; extrem stimmungsgetrieben.',
  'AVAX-USD': 'Avalanche — Smart-Contract-Plattform mit Subnetz-Architektur.',
  'DOT-USD': 'Polkadot — verbindet spezialisierte Blockchains („Parachains") zu einem Netz.',
  'LINK-USD': 'Chainlink — Orakel-Netzwerk: bringt echte Daten (Kurse, Wetter) auf Blockchains.',
  'LTC-USD': 'Litecoin — früher Bitcoin-Ableger mit schnelleren Blöcken.',
  'TRX-USD': 'TRON — Blockchain mit Fokus auf Stablecoin-Transfers (viel USDT-Verkehr).',
  'ATOM-USD': 'Cosmos — „Internet der Blockchains": Standard für Ketten-zu-Ketten-Kommunikation.',
  // ── Anleihen-ETFs ──
  TLT: 'US-Staatsanleihen mit 20+ Jahren Laufzeit — DER Zins-Hebel: fällt, wenn Langfristzinsen steigen.',
  IEF: 'US-Staatsanleihen 7–10 Jahre — mittlere Zinssensitivität.',
  SHY: 'US-Staatsanleihen 1–3 Jahre — kaum Zinsrisiko, kaum Bewegung.',
  AGG: 'Der breite US-Anleihenmarkt in einem ETF (Staats-, Hypotheken-, Unternehmensanleihen).',
  LQD: 'Unternehmensanleihen guter Bonität (Investment Grade) — Apple, Banken & Co. als Schuldner.',
  HYG: 'Hochzins-Unternehmensanleihen („Junk Bonds") — mehr Rendite, mehr Ausfallrisiko; läuft oft mit Aktien.',
  TIP: 'Inflationsgeschützte US-Staatsanleihen — Nennwert wächst mit den Verbraucherpreisen.',
  BIL: 'US-Geldmarkt (1–3-Monats-T-Bills) — der „Parkplatz" fürs Cash.',
  // ── US-Sektoren (SPDR-Familie: je die Sektor-Schwergewichte des S&P 500) ──
  XLK: 'US-Technologie-Sektor — dominiert von Apple, Microsoft und Nvidia.',

  XLF: 'US-Finanzsektor — Berkshire, JPMorgan, Visa/Mastercard, Großbanken.',
  XLE: 'US-Energiesektor — Exxon und Chevron stellen zusammen fast die Hälfte; hängt am Ölpreis.',
  XLV: 'US-Gesundheitssektor — Eli Lilly, UnitedHealth, Johnson & Johnson, Pharma und Versicherer.',
  XLI: 'US-Industriesektor — Caterpillar, GE Aerospace, Boeing, Bahnen und Rüstung.',
  XLY: 'Zyklischer US-Konsum — Amazon und Tesla vorneweg, dazu Home Depot, Nike, McDonald’s.',
  XLP: 'Defensiver US-Konsum — Procter & Gamble, Coca-Cola, Walmart, Costco; läuft in Schwächephasen stabiler.',
  XLU: 'US-Versorger — NextEra, Duke & Co.; dividendenstark und zinssensibel.',
  XLB: 'US-Grundstoffe — Chemie (Linde, Sherwin-Williams), Bergbau, Verpackung.',
  XLRE: 'US-Immobilien (REITs) — Funkmasten, Rechenzentren, Logistikhallen; zinssensibel.',
  XLC: 'US-Kommunikation — Meta und Alphabet dominieren, dazu Netflix, Disney, Telekoms.',
  // ── Breite Markt-ETFs ──
  SPY: 'Der Klassiker: die 500 größten US-Konzerne in einem ETF — Referenz für „den Markt".',
  QQQ: 'Nasdaq 100 — die 100 größten Nicht-Finanzwerte der Nasdaq; tech-lastig (Apple, Microsoft, Nvidia).',
  DIA: 'Dow Jones 30 — 30 US-Blue-Chips, preisgewichtet (alter Index-Mechanik).',
  IWM: 'Russell 2000 — 2000 US-Nebenwerte; konjunktursensibler als die Großen.',
  VTI: 'Der GESAMTE US-Aktienmarkt (~3.500 Titel) in einem ETF.',
  EFA: 'Industrieländer außerhalb der USA — Japan, UK, Frankreich, Schweiz (Nestlé, ASML, Toyota).',
  EEM: 'Schwellenländer — China, Indien, Taiwan (TSMC, Tencent, Samsung).',
  VGK: 'Europa gesamt — Nestlé, Novo Nordisk, ASML, SAP, LVMH.',
  EWJ: 'Japan — Toyota, Sony, Mitsubishi; hängt oft am Yen-Kurs.',
  FXI: 'Chinas Großkonzerne — Tencent, Alibaba, Meituan (Hongkong-notiert).',
  EWG: 'Deutschland — SAP, Siemens, Allianz, Deutsche Telekom.',
  EWZ: 'Brasilien — Vale, Petrobras, Banken; rohstoff- und währungsgetrieben.',
  INDA: 'Indien — Reliance, Infosys, HDFC Bank; Wachstumsmarkt mit eigener Dynamik.',
  // ── Themen-ETFs ──
  ARKK: 'ARK Innovation (Cathie Wood) — Tesla, Coinbase, Roku; hochvolatile „Disruptions"-Wetten.',
  SMH: 'Halbleiter — Nvidia, TSMC, Broadcom; der KI-Zyklus in einem ETF.',
  SOXX: 'Halbleiter (iShares-Variante) — AMD, Nvidia, Qualcomm; US-lastiger als SMH.',
  IBB: 'Biotech — Amgen, Gilead, Vertex; nachrichten- und zulassungsgetrieben.',
  ICLN: 'Saubere Energie weltweit — First Solar, Iberdrola, Vestas.',
  TAN: 'Solar pur — First Solar, Enphase; extrem zyklisch und zinssensibel.',
  LIT: 'Batterie-Wertschöpfungskette — Albemarle (Lithium), CATL, Panasonic.',
  JETS: 'Airlines — Delta, United, Southwest; hängt an Ölpreis und Reisekonjunktur.',
  HACK: 'Cybersecurity — CrowdStrike, Palo Alto, Fortinet.',
  BOTZ: 'Robotik & KI — Nvidia, Intuitive Surgical, Fanuc, Keyence.',
  // ── Rohstoffe ──
  GLD: 'Physisches Gold im Tresor — der klassische Krisen- und Inflationsanker.',
  SLV: 'Physisches Silber — Edelmetall MIT Industrienachfrage (Solar, Elektronik); schwankt stärker als Gold.',
  PPLT: 'Physisches Platin — Autokatalysatoren und Schmuck; kleines, enges Marktsegment.',
  CPER: 'Kupfer über Futures — „Dr. Copper" gilt als Konjunktur-Frühindikator.',
  USO: 'US-Rohöl (WTI) über Futures — bildet den Ölpreis kurzfristig ab, langfristig nagt der Rollverlust.',
  BNO: 'Nordsee-Öl (Brent) über Futures — der Weltmarkt-Ölpreis, gleiche Roll-Mechanik wie USO.',
  UNG: 'US-Erdgas über Futures — extrem volatil (Wetter!), hoher Rollverlust; nichts zum Liegenlassen.',
  DBA: 'Agrar-Korb über Futures — Mais, Weizen, Zucker, Kaffee, Sojabohnen.',
  PDBC: 'Breiter Rohstoffkorb (Energie, Metalle, Agrar) ohne K-1-Steuerformular.',
  // ── Einzelaktien: Tech ──
  AAPL: 'iPhone, Mac, Services — größter Konzern der Welt nach Marktwert, riesiges Ökosystem.',
  MSFT: 'Windows, Office, Azure-Cloud und OpenAI-Partnerschaft — der Unternehmens-Standard.',
  NVDA: 'KI-Chips (GPUs) — die Schaufeln des KI-Goldrauschs; Rechenzentren als Hauptgeschäft.',
  AVGO: 'Broadcom — Netzwerk-Chips und Infrastruktur-Software (VMware); stiller KI-Profiteur.',
  AMD: 'Prozessoren und KI-Beschleuniger — der Herausforderer von Intel und Nvidia.',
  INTC: 'Intel — PC- und Server-Chips plus eigener Fertigung (Foundry); im Umbau.',
  QCOM: 'Qualcomm — Smartphone-Chips und Funklizenzen; fast jedes Android-Flaggschiff rechnet mit Snapdragon.',
  TXN: 'Texas Instruments — Analog-Chips für Industrie und Auto; unspektakulär, margenstark.',
  MU: 'Micron — Speicherchips (DRAM/NAND); extrem zyklisch, KI-Nachfrage treibt HBM.',
  ORCL: 'Oracle — Datenbanken und wachsende Cloud-Infrastruktur (auch für KI-Training).',
  CRM: 'Salesforce — führendes CRM (Kundenverwaltung) aus der Cloud, dazu Slack und Tableau.',
  ADBE: 'Adobe — Photoshop, Acrobat/PDF, Marketing-Cloud; Kreativ-Software im Abo.',
  CSCO: 'Cisco — Netzwerk-Ausrüstung (Router, Switches) und Security (Splunk).',
  IBM: 'IBM — Beratung, Mainframes, Red-Hat-Software; Dividenden-Klassiker im KI-Umbau.',
  PLTR: 'Palantir — Datenanalyse-Plattformen für Behörden und Konzerne; hoch bewertet, stark KI-erzählungsgetrieben.',
  // ── Einzelaktien: Kommunikation/Konsum ──
  GOOGL: 'Alphabet — Google-Suche, YouTube, Android und Gemini-KI; Werbegeschäft als Motor.',
  META: 'Meta — Facebook, Instagram, WhatsApp; Werbemaschine plus KI- und Brillen-Wetten.',
  NFLX: 'Netflix — größter Streaming-Dienst; wächst über Werbe-Abo und Passwort-Sharing-Ende.',
  DIS: 'Disney — Filme, Parks, Disney+; Marken von Marvel bis Star Wars.',
  AMZN: 'Amazon — E-Commerce plus AWS-Cloud (der eigentliche Gewinnbringer) und Werbung.',
  TSLA: 'Tesla — E-Autos, Energiespeicher und die Robotaxi/KI-Erzählung; notorisch schwankungsfreudig.',
  HD: 'Home Depot — größte Baumarktkette der USA; hängt am Häusermarkt.',
  LOW: 'Lowe’s — zweitgrößte US-Baumarktkette; gleicher Häusermarkt-Puls wie Home Depot.',
  MCD: 'McDonald’s — größte Restaurantkette der Welt; Franchise-Modell mit Immobilien-Kern.',
  NKE: 'Nike — größte Sportmarke der Welt; China- und Lagerbestands-sensibel.',
  SBUX: 'Starbucks — globale Kaffeehauskette; China als zweiter Heimatmarkt.',
  BKNG: 'Booking Holdings — Booking.com, Kayak, OpenTable; verdient an jeder Reisebuchung.',
  // ── Einzelaktien: Finanzen ──
  'BRK-B': 'Berkshire Hathaway — Warren Buffetts Beteiligungs-Konglomerat (Versicherung, Bahn, Apple-Paket).',
  JPM: 'JPMorgan — größte US-Bank; Investmentbanking bis Privatkunden.',
  BAC: 'Bank of America — zweitgrößte US-Bank, stark im Einlagengeschäft (zinssensibel).',
  WFC: 'Wells Fargo — US-Privat- und Hypothekenbank.',
  GS: 'Goldman Sachs — Investmentbank: M&A-Beratung und Handel.',
  MS: 'Morgan Stanley — Investmentbank mit großem Vermögensverwaltungs-Arm.',
  V: 'Visa — Zahlungsnetzwerk: verdient an fast jeder Kartenzahlung, ohne Kreditrisiko.',
  MA: 'Mastercard — das zweite globale Zahlungsnetzwerk; gleiches Modell wie Visa.',
  AXP: 'American Express — Karten UND eigenes Kreditbuch; Premium-Kundschaft.',
  BLK: 'BlackRock — größter Vermögensverwalter der Welt (iShares-ETFs).',
  SCHW: 'Charles Schwab — Broker und Bank für US-Privatanleger.',
  // ── Einzelaktien: Gesundheit ──
  UNH: 'UnitedHealth — größter US-Krankenversicherer plus Gesundheitsdienste (Optum).',
  JNJ: 'Johnson & Johnson — Pharma und Medizintechnik; Dividenden-Aristokrat.',
  LLY: 'Eli Lilly — Abnehm- und Diabetes-Blockbuster (Zepbound/Mounjaro) treiben das Wachstum.',
  ABBV: 'AbbVie — Immunologie-Pharma (Humira-Nachfolger Skyrizi/Rinvoq), Allergan-Ästhetik.',
  MRK: 'Merck — Krebsimmuntherapie Keytruda als umsatzstärkstes Medikament.',
  PFE: 'Pfizer — Impfstoffe und Krebsmedikamente; nach dem Covid-Boom in der Neuaufstellung.',
  TMO: 'Thermo Fisher — Laborausrüstung und Auftragsforschung; „Schaufelverkäufer" der Pharmabranche.',
  ABT: 'Abbott — Diagnostik, Medizintechnik (Libre-Glukosesensor), Ernährung.',
  AMGN: 'Amgen — Biotech-Pionier; Osteoporose-, Cholesterin- und Abnehm-Pipeline.',
  // ── Einzelaktien: Energie/Industrie ──
  XOM: 'Exxon Mobil — größter westlicher Ölkonzern; Förderung bis Tankstelle.',
  CVX: 'Chevron — integrierter Öl- und Gaskonzern, dividendenstark.',
  COP: 'ConocoPhillips — reine Öl- und Gasförderung (kein Tankstellengeschäft); ölpreissensibler.',
  SLB: 'SLB (Schlumberger) — größter Ölfeld-Dienstleister: Technik für die Förderer.',
  CAT: 'Caterpillar — Bau- und Bergbaumaschinen; globaler Konjunktur-Gradmesser.',
  DE: 'Deere — Traktoren und Landtechnik (John Deere); hängt an Ernte-Einkommen.',
  BA: 'Boeing — Verkehrsflugzeuge und Rüstung; Duopol mit Airbus.',
  GE: 'GE Aerospace — Triebwerke für Boeing und Airbus plus Wartungsgeschäft.',
  HON: 'Honeywell — Luftfahrt-Elektronik, Gebäudetechnik, Automatisierung.',
  UPS: 'UPS — weltweites Paketnetz; Frühindikator für Konsum und Handel.',
  LMT: 'Lockheed Martin — größter Rüstungskonzern (F-35, Raketenabwehr).',
  // ── Einzelaktien: Defensiver Konsum/Versorger ──
  WMT: 'Walmart — größter Einzelhändler der Welt; wächst mit Werbung und E-Commerce.',
  COST: 'Costco — Mitgliederclub-Großhandel mit treuester Kundschaft im Handel.',
  PG: 'Procter & Gamble — Pampers, Gillette, Ariel; Preissetzungsmacht im Alltag.',
  KO: 'Coca-Cola — das Getränke-Markenimperium; Dividenden-Aristokrat.',
  PEP: 'PepsiCo — Getränke PLUS Snacks (Lay’s, Doritos); breiter als Coca-Cola.',
  PM: 'Philip Morris — Marlboro international plus rauchfreie Produkte (IQOS, ZYN).',
  NEE: 'NextEra — größter US-Versorger und weltgrößter Wind-/Solar-Betreiber.',
  DUK: 'Duke Energy — regulierter Strom- und Gasversorger im Südosten der USA.',
};

/** Beschreibung fürs UI: kuratiert, sonst ehrlicher Katalog-Fallback. */
export function steckbriefText(sym: string): string {
  const kuratiert = STECKBRIEFE[sym];
  if (kuratiert) return kuratiert;
  const h = symbolHerkunft(sym);
  return h ? `${h.name} — ${h.klassenLabel} (${h.gruppe}).` : '';
}
