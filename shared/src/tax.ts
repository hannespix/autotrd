/**
 * Steuerliche Aufbereitung der Trade-Historie (deutsches Recht).
 *
 * Owner-Auftrag 04.08.: „fürs deutsche finanzamt alle möglichen speicherungen
 * und exportfunktionen vorbereiten."
 *
 * ── Was dieses Modul IST und was es NICHT ist ──────────────────────────────
 *
 * Es ist eine **Aufbereitung**: Es paart Käufe und Verkäufe nach FIFO, rechnet
 * Haltedauern und Veräußerungsergebnisse aus und sortiert sie in die Töpfe,
 * die das deutsche Recht getrennt hält. Genau das, was jede Jahressteuer-
 * bescheinigung eines Brokers auch tut.
 *
 * Es ist **keine Steuerberatung** und rechnet bewusst KEINE Steuerschuld aus.
 * Wie viel jemand zahlt, hängt von Dingen ab, die dieses System nicht kennt
 * und nicht kennen soll: Kirchensteuerpflicht, Veranlagungsart, Freistellungs-
 * aufträge bei anderen Banken, Verlustvorträge aus Vorjahren, sonstige
 * Einkünfte. Wer aus diesen Zahlen eine Steuererklärung macht, prüft sie mit
 * einem Steuerberater — dafür sind sie da.
 *
 * ── Die vier Töpfe, und warum sie getrennt bleiben müssen ──────────────────
 *
 * Deutsches Recht verrechnet Gewinne und Verluste NICHT frei gegeneinander.
 * Wer alles in eine Summe wirft, rechnet sich systematisch zu wenig Steuer
 * aus — der häufigste Fehler in selbstgebauten Auswertungen:
 *
 *   1. `aktien`         Verluste aus Aktienveräußerungen dürfen NUR mit
 *                       Gewinnen aus Aktienveräußerungen verrechnet werden
 *                       (§ 20 Abs. 6 Satz 4 EStG). Ein Aktienverlust rettet
 *                       keinen ETF-Gewinn.
 *   2. `sonstige`       ETFs, Fonds, Anleihen — der allgemeine Topf des
 *                       § 20 EStG.
 *   3. `termin`         Leerverkäufe und Termingeschäfte (§ 20 Abs. 6 Satz 5).
 *   4. `privat`         Kryptowährungen als privates Veräußerungsgeschäft
 *                       (§ 23 EStG) — komplett anderes Regime: persönlicher
 *                       Steuersatz statt Abgeltungsteuer, und nach einem Jahr
 *                       Haltedauer steuerFREI.
 *
 * Die Ein-Jahres-Frist bei Krypto ist der größte Einzelhebel in dieser Datei.
 * Sie wird taggenau gerechnet, nicht mit 365 Tagen: Bei einem Kauf am
 * 29.02. eines Schaltjahres liegen beide Verfahren einen Tag auseinander.
 *
 * ── Warum FIFO ────────────────────────────────────────────────────────────
 *
 * Bei mehreren Käufen desselben Papiers muss feststehen, welcher davon
 * verkauft wurde — der Einstandskurs entscheidet über den Gewinn. Das Gesetz
 * schreibt für § 23 die FIFO-Methode vor (ältester Bestand zuerst), und für
 * § 20 arbeiten die Banken mit demselben Verfahren. Es gibt keine Wahl.
 *
 * ── Zur Währung ───────────────────────────────────────────────────────────
 *
 * Das Finanzamt will Euro, der Kontostand ist in USD geführt. Umgerechnet
 * wird mit dem Kurs am jeweiligen Ausführungstag — nicht mit einem Jahres-
 * mittel und schon gar nicht mit dem heutigen Kurs. Dieses Modul RECHNET
 * die Umrechnung, wenn Kurse übergeben werden, und meldet ehrlich, wenn
 * welche fehlen (`fxLuecken`). Es erfindet keine.
 */

import { brauchtUmrechnung, eurBetrag, type FxKurs } from './fx.js';

/** Steuertöpfe des deutschen Rechts — bewusst getrennt (s. Kopfkommentar). */
export type Steuertopf = 'aktien' | 'sonstige' | 'termin' | 'privat';

/** Eingabe: ein ausgeführter Trade, so wie er im Buch steht. */
export interface SteuerTrade {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  /** Ausführungskurs in Notierungswährung. */
  price: number;
  /** ISO-Zeitstempel der Ausführung. */
  executedAt: string;
  /** Ausführungskosten dieses Trades (Kommission), Kontowährung. */
  fee?: number | undefined;
  /** Anlageklasse zum Zeitpunkt des Trades (`classify`-Ergebnis). */
  assetClass?: string | undefined;
  /** Notierungswährung; fehlt sie, gilt die Kontowährung. */
  currency?: string | undefined;
  /** Echtgeld oder Papierhandel — nur Echtgeld ist steuerbar. */
  paper?: boolean | undefined;
  /**
   * EZB-Referenzkurs des Vorgangs (Fremdwährung je 1 EUR), EINGEFROREN beim
   * Trade. Nie nachträglich neu holen — sonst wandern historische Gewinne
   * (siehe `shared/src/fx.ts`).
   */
  fxRate?: number | undefined;
  /** Tag, für den der Kurs veröffentlicht wurde — kann vor dem Handelstag liegen. */
  fxDate?: string | undefined;
  fxSource?: string | undefined;
}

/** Ein nach FIFO geschlossenes Geschäft: Anschaffung ↔ Veräußerung. */
export interface Veraeusserung {
  symbol: string;
  topf: Steuertopf;
  /** 'long' = gekauft und verkauft, 'short' = leerverkauft und eingedeckt. */
  richtung: 'long' | 'short';
  menge: number;
  anschaffungAm: string;
  anschaffungKurs: number;
  veraeusserungAm: string;
  veraeusserungKurs: number;
  /** Anteilige Anschaffungsnebenkosten + Veräußerungskosten. */
  kosten: number;
  /** Erlös − Einstand − Kosten, in Kontowährung. */
  ergebnis: number;
  /** Volle Tage zwischen Anschaffung und Veräußerung. */
  haltetageGenau: number;
  /**
   * Nur bei `topf: 'privat'` gesetzt: Ein-Jahres-Frist überschritten?
   * `true` heißt steuerfrei nach § 23 Abs. 1 Nr. 2 EStG.
   */
  steuerfreiNachJahresfrist?: boolean;
  /**
   * Euro-Beträge, JE VORGANG zum Kurs seines Tages umgerechnet (M12b).
   *
   * Fehlen sie, fehlte mindestens einem der beiden Vorgänge der Kurs — dann
   * steht statt einer Zahl nichts. Ein aus dem Ergebnis hochgerechneter
   * Euro-Betrag wäre steuerlich unzulässig und sähe in der Ausgabe genauso
   * aus wie ein richtiger.
   */
  eurAnschaffung?: number;
  eurVeraeusserung?: number;
  eurKosten?: number;
  eurErgebnis?: number;
  /** Kurse beider Seiten, damit der Bericht sie ausweisen kann. */
  fx?: { anschaffung?: FxKurs; veraeusserung?: FxKurs };
}

/** Ein offener Bestand, der am Stichtag noch nicht veräußert war. */
export interface OffenerBestand {
  symbol: string;
  topf: Steuertopf;
  richtung: 'long' | 'short';
  menge: number;
  anschaffungAm: string;
  anschaffungKurs: number;
  /** Bei Krypto: Tage bis zur Steuerfreiheit (0 = Frist bereits um). */
  tageBisJahresfrist?: number;
}

/**
 * Rechtsstand-abhängige Beträge.
 *
 * BEWUSST als Datum-zu-Wert-Tabelle und nicht als Konstante: Diese Zahlen
 * ändern sich durch Gesetzgebung, und ein Bericht über 2024 muss den Stand
 * von 2024 benutzen, auch wenn er 2026 erzeugt wird. Wer hier nur den
 * aktuellen Wert hinterlegt, produziert rückwirkend falsche Altberichte.
 *
 * Die Werte sind nach bestem Wissen gepflegt, ersetzen aber keine Prüfung —
 * deshalb steht der zugrunde gelegte Stand in jedem erzeugten Bericht
 * (`rechtsstandHinweis`), damit ein Steuerberater ihn sofort sieht.
 */
export interface Rechtsstand {
  /** Sparer-Pauschbetrag § 20 Abs. 9 EStG (Einzelveranlagung). */
  sparerPauschbetrag: number;
  /** Freigrenze § 23 Abs. 3 Satz 5 EStG. FREIGRENZE, nicht Freibetrag. */
  privatFreigrenze: number;
  /** Abgeltungsteuersatz § 32d Abs. 1 EStG. */
  abgeltungsteuerSatz: number;
  /** Solidaritätszuschlag auf die Abgeltungsteuer. */
  soliSatz: number;
}

/**
 * Rechtsstände je Veranlagungsjahr.
 *
 * Ein Jahr, das hier fehlt, erbt den jüngsten davorliegenden Eintrag — neue
 * Jahre ohne Gesetzesänderung brauchen also keine Pflege, und ein Bericht
 * über ein künftiges Jahr rechnet nicht versehentlich mit Nullen.
 */
export const RECHTSSTAND: Record<number, Rechtsstand> = {
  2023: {
    sparerPauschbetrag: 1000,
    privatFreigrenze: 600,
    abgeltungsteuerSatz: 0.25,
    soliSatz: 0.055,
  },
  2024: {
    sparerPauschbetrag: 1000,
    privatFreigrenze: 1000,
    abgeltungsteuerSatz: 0.25,
    soliSatz: 0.055,
  },
};

/** Rechtsstand des Jahres — jüngster Eintrag ≤ Jahr (s. RECHTSSTAND). */
export function rechtsstandFuer(jahr: number): Rechtsstand {
  const jahre = Object.keys(RECHTSSTAND)
    .map(Number)
    .filter((j) => j <= jahr)
    .sort((a, b) => b - a);
  const treffer = jahre[0];
  // Kein Eintrag ≤ Jahr: nur bei Berichten über die Zeit vor der Tabelle.
  // Dann der ÄLTESTE bekannte Stand statt Nullen — falsch, aber erkennbar
  // falsch, statt stillschweigend jede Freigrenze auf 0 zu setzen.
  if (treffer === undefined) {
    const aeltestes = Math.min(...Object.keys(RECHTSSTAND).map(Number));
    return RECHTSSTAND[aeltestes]!;
  }
  return RECHTSSTAND[treffer]!;
}

/**
 * Anlageklasse → Steuertopf.
 *
 * `richtung` entscheidet mit: Ein Leerverkauf ist steuerlich ein Termin-
 * geschäft, egal ob er auf eine Aktie oder einen ETF lautet.
 */
export function steuertopf(assetClass: string | undefined, richtung: 'long' | 'short'): Steuertopf {
  if (richtung === 'short') return 'termin';
  const k = (assetClass ?? '').toLowerCase();
  if (k === 'crypto' || k === 'krypto') return 'privat';
  if (k === 'stocks_us' || k === 'stocks_global' || k === 'stocks') return 'aktien';
  // ETFs, Anleihen, Rohstoffe, Indizes: der allgemeine § 20-Topf.
  return 'sonstige';
}

/** Volle Tage zwischen zwei ISO-Zeitpunkten (kalendarisch, nicht 24-h-Blöcke). */
export function haltetage(vonIso: string, bisIso: string): number {
  const a = Date.parse(vonIso);
  const b = Date.parse(bisIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.floor((b - a) / 86_400_000));
}

/**
 * Ist die Ein-Jahres-Frist des § 23 überschritten?
 *
 * TAGGENAU über den Kalender, nicht über 365 Tage: Wer am 01.03.2024 kauft,
 * ist am 02.03.2025 draußen — auch wenn dazwischen ein Schalttag lag und
 * die Differenz damit 366 Tage beträgt. Die 365-Tage-Näherung würde in
 * Schaltjahren einen steuerfreien Verkauf als steuerpflichtig ausweisen.
 */
export function jahresfristUeberschritten(kaufIso: string, verkaufIso: string): boolean {
  const kauf = new Date(kaufIso);
  const verkauf = new Date(verkaufIso);
  if (Number.isNaN(kauf.getTime()) || Number.isNaN(verkauf.getTime())) return false;
  const fristEnde = new Date(kauf.getTime());
  fristEnde.setUTCFullYear(fristEnde.getUTCFullYear() + 1);
  return verkauf.getTime() > fristEnde.getTime();
}

/** Ein noch nicht verrechneter Bestandsposten in der FIFO-Schlange. */
interface Lot {
  menge: number;
  kurs: number;
  am: string;
  /** Anteilige Anschaffungsnebenkosten je Stück. */
  kostenJeStueck: number;
  assetClass: string | undefined;
  /** Notierungswährung des Vorgangs. */
  waehrung: string | undefined;
  /** Eingefrorener Kurs DIESES Vorgangs — nicht der des Verkaufs (M12b). */
  fx: FxKurs | null;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

export interface FifoErgebnis {
  veraeusserungen: Veraeusserung[];
  offen: OffenerBestand[];
  /**
   * Verkäufe ohne passenden Bestand — echte Datenlücken, keine Shorts.
   * Sie entstehen, wenn die Historie nicht bis zum Anschaffungsgeschäft
   * zurückreicht (z. B. nach einem Reset oder bei abgeschnittenem Fenster).
   * Sie werden NICHT stillschweigend als Gewinn gebucht.
   */
  unpaarbar: Array<{ symbol: string; menge: number; am: string; grund: string }>;
}

/**
 * FIFO-Verrechnung über die gesamte Historie.
 *
 * Long und Short laufen in getrennten Schlangen je Symbol: Ein Leerverkauf
 * eröffnet einen Short-Bestand, ein späterer Kauf deckt ihn ein. Ohne diese
 * Trennung würde ein Kauf, der eine Short-Position schließt, fälschlich als
 * neuer Long-Bestand gebucht — und der Gewinn aus dem Leerverkauf fiele
 * ganz unter den Tisch.
 *
 * Die Reihenfolge ist die Ausführungszeit, nicht die Eingabereihenfolge:
 * FIFO über eine unsortierte Liste ist kein FIFO.
 */
/** Eingefrorenen Kurs aus einem Trade lesen — oder null, wenn keiner da ist. */
function kursVon(t: SteuerTrade): FxKurs | null {
  if (typeof t.fxRate !== 'number' || !(t.fxRate > 0)) return null;
  return { date: t.fxDate ?? t.executedAt.slice(0, 10), rate: t.fxRate, source: t.fxSource ?? 'unbekannt' };
}

export function fifoVerrechnen(trades: readonly SteuerTrade[]): FifoErgebnis {
  const sortiert = [...trades].sort((a, b) => a.executedAt.localeCompare(b.executedAt));
  const longs = new Map<string, Lot[]>();
  const shorts = new Map<string, Lot[]>();
  const veraeusserungen: Veraeusserung[] = [];
  const unpaarbar: FifoErgebnis['unpaarbar'] = [];

  const schlange = (m: Map<string, Lot[]>, sym: string): Lot[] => {
    const v = m.get(sym);
    if (v) return v;
    const neu: Lot[] = [];
    m.set(sym, neu);
    return neu;
  };

  /**
   * Schließt `menge` gegen die Schlange und erzeugt die Veräußerungen.
   * Gibt zurück, was NICHT geschlossen werden konnte — der Rest eröffnet
   * dann eine Gegenposition (oder ist eine Datenlücke).
   */
  const schliessen = (
    queue: Lot[],
    t: SteuerTrade,
    menge: number,
    richtung: 'long' | 'short',
    kostenJeStueck: number,
  ): number => {
    let offen = menge;
    while (offen > 1e-9 && queue.length > 0) {
      const lot = queue[0]!;
      const teil = Math.min(offen, lot.menge);
      const topf = steuertopf(lot.assetClass ?? t.assetClass, richtung);
      // Bei Short dreht sich das Vorzeichen: Der Erlös fließt beim ÖFFNEN,
      // der Einstand beim Eindecken. Wer das nicht spiegelt, weist jeden
      // gewinnbringenden Leerverkauf als Verlust aus.
      const roh =
        richtung === 'long' ? (t.price - lot.kurs) * teil : (lot.kurs - t.price) * teil;
      const kosten = r2(lot.kostenJeStueck * teil + kostenJeStueck * teil);
      const tage = haltetage(lot.am, t.executedAt);
      // EUR JE VORGANG (M12b): Die Anschaffung mit dem Kurs IHRES Tages, die
      // Veräußerung mit dem Kurs ihres eigenen. Das Ergebnis erst danach
      // bilden — die Umrechnung eines Fremdwährungs-Ergebnisses ist
      // unzulässig und verschluckt genau den Währungsgewinn, der
      // steuerpflichtig ist (siehe fx.ts).
      const fxT = kursVon(t);
      const eurLot = eurBetrag(lot.kurs * teil, lot.waehrung, lot.fx);
      const eurT = eurBetrag(t.price * teil, t.currency, fxT);
      const eurKostenLot = eurBetrag(lot.kostenJeStueck * teil, lot.waehrung, lot.fx);
      const eurKostenT = eurBetrag(kostenJeStueck * teil, t.currency, fxT);
      const eintrag: Veraeusserung = {
        symbol: t.symbol,
        topf,
        richtung,
        menge: teil,
        anschaffungAm: lot.am,
        anschaffungKurs: lot.kurs,
        veraeusserungAm: t.executedAt,
        veraeusserungKurs: t.price,
        kosten,
        ergebnis: r2(roh - kosten),
        haltetageGenau: tage,
      };
      if (topf === 'privat') {
        eintrag.steuerfreiNachJahresfrist = jahresfristUeberschritten(lot.am, t.executedAt);
      }
      if (eurLot !== null && eurT !== null && eurKostenLot !== null && eurKostenT !== null) {
        const eurKosten = r2(eurKostenLot + eurKostenT);
        eintrag.eurAnschaffung = eurLot;
        eintrag.eurVeraeusserung = eurT;
        eintrag.eurKosten = eurKosten;
        // Beim Short dreht sich das Vorzeichen genauso wie in der
        // Fremdwährungs-Rechnung darüber: Der Erlös floss beim ÖFFNEN.
        eintrag.eurErgebnis = r2(
          (richtung === 'long' ? eurT - eurLot : eurLot - eurT) - eurKosten,
        );
        eintrag.fx = {
          ...(lot.fx ? { anschaffung: lot.fx } : {}),
          ...(fxT ? { veraeusserung: fxT } : {}),
        };
      }
      veraeusserungen.push(eintrag);
      lot.menge -= teil;
      offen -= teil;
      if (lot.menge <= 1e-9) queue.shift();
    }
    return offen;
  };

  for (const t of sortiert) {
    if (!(t.qty > 0) || !Number.isFinite(t.price)) continue;
    // Die Kommission verteilt sich auf die Stückzahl — nur so lässt sich ein
    // Teilverkauf anteilig belasten.
    const kostenJeStueck = t.qty > 0 ? (t.fee ?? 0) / t.qty : 0;
    const longQ = schlange(longs, t.symbol);
    const shortQ = schlange(shorts, t.symbol);

    if (t.side === 'sell') {
      // Verkauf schließt zuerst bestehende Long-Bestände …
      const rest = schliessen(longQ, t, t.qty, 'long', kostenJeStueck);
      // … was übrig bleibt, ist ein Leerverkauf und eröffnet einen Short.
      if (rest > 1e-9) {
        shortQ.push({
          menge: rest,
          kurs: t.price,
          am: t.executedAt,
          kostenJeStueck,
          assetClass: t.assetClass,
          waehrung: t.currency,
          fx: kursVon(t),
        });
      }
    } else {
      // Kauf deckt zuerst offene Shorts ein …
      const rest = schliessen(shortQ, t, t.qty, 'short', kostenJeStueck);
      // … der Rest ist eine normale Anschaffung.
      if (rest > 1e-9) {
        longQ.push({
          menge: rest,
          kurs: t.price,
          am: t.executedAt,
          kostenJeStueck,
          assetClass: t.assetClass,
          waehrung: t.currency,
          fx: kursVon(t),
        });
      }
    }
  }

  const offen: OffenerBestand[] = [];
  const jetzt = new Date().toISOString();
  for (const [sym, q] of longs) {
    for (const lot of q) {
      if (lot.menge <= 1e-9) continue;
      const topf = steuertopf(lot.assetClass, 'long');
      const eintrag: OffenerBestand = {
        symbol: sym,
        topf,
        richtung: 'long',
        menge: lot.menge,
        anschaffungAm: lot.am,
        anschaffungKurs: lot.kurs,
      };
      if (topf === 'privat') {
        const frist = new Date(lot.am);
        frist.setUTCFullYear(frist.getUTCFullYear() + 1);
        eintrag.tageBisJahresfrist = Math.max(
          0,
          Math.ceil((frist.getTime() - Date.parse(jetzt)) / 86_400_000),
        );
      }
      offen.push(eintrag);
    }
  }
  for (const [sym, q] of shorts) {
    for (const lot of q) {
      if (lot.menge <= 1e-9) continue;
      offen.push({
        symbol: sym,
        topf: 'termin',
        richtung: 'short',
        menge: lot.menge,
        anschaffungAm: lot.am,
        anschaffungKurs: lot.kurs,
      });
    }
  }

  return { veraeusserungen, offen, unpaarbar };
}

export interface TopfSumme {
  /** Summe der positiven Ergebnisse. */
  gewinne: number;
  /** Summe der negativen Ergebnisse, als POSITIVE Zahl. */
  verluste: number;
  /** gewinne − verluste. */
  saldo: number;
  /** Anzahl Veräußerungsgeschäfte. */
  n: number;
  /**
   * Dieselben Zahlen in Euro (M12b) — `null`, sobald AUCH NUR EIN Vorgang
   * dieses Topfes keinen Kurs hatte.
   *
   * Eine Teilsumme wäre schlimmer als keine: Sie sähe vollständig aus,
   * wäre aber zu klein, und niemand könnte ihr ansehen, um wie viel.
   */
  eurGewinne: number | null;
  eurVerluste: number | null;
  eurSaldo: number | null;
}

export interface Steuerbericht {
  jahr: number;
  /** Kontowährung, in der die Beträge stehen (heute immer USD). */
  waehrung: string;
  /** Nur Echtgeld ist steuerbar — Papierhandel wird separat ausgewiesen. */
  echtgeld: boolean;
  rechtsstand: Rechtsstand;
  rechtsstandHinweis: string;
  toepfe: Record<Steuertopf, TopfSumme>;
  /** Steuerfreie Krypto-Gewinne (Jahresfrist überschritten) — informativ. */
  privatSteuerfrei: number;
  /** Steuerpflichtiger § 23-Saldo VOR Anwendung der Freigrenze. */
  privatSteuerpflichtig: number;
  /**
   * Greift die Freigrenze des § 23? `true` = der gesamte privat-Saldo bleibt
   * steuerfrei. FREIGRENZE: Ein Euro darüber macht den GANZEN Betrag
   * steuerpflichtig, nicht nur den übersteigenden Teil.
   */
  privatUnterFreigrenze: boolean;
  veraeusserungen: Veraeusserung[];
  offen: OffenerBestand[];
  unpaarbar: FifoErgebnis['unpaarbar'];
  /** Trades ohne Währungskurs, obwohl Fremdwährung — Umrechnung unvollständig. */
  fxLuecken: number;
  erstelltAm: string;
}

const leererTopf = (): TopfSumme => ({
  gewinne: 0,
  verluste: 0,
  saldo: 0,
  n: 0,
  eurGewinne: 0,
  eurVerluste: 0,
  eurSaldo: 0,
});

/**
 * Jahresbericht aus der Trade-Historie.
 *
 * Verrechnet wird über die GESAMTE Historie (FIFO braucht die Anschaffung,
 * auch wenn sie Jahre zurückliegt), ausgewiesen wird nur, was im Berichtsjahr
 * VERÄUSSERT wurde — das ist der Zeitpunkt, an dem der Gewinn steuerlich
 * entsteht. Wer nur die Trades des Jahres in die FIFO-Rechnung gibt, verliert
 * jeden Einstandskurs aus Vorjahren und weist den vollen Erlös als Gewinn aus.
 */
export function steuerbericht(
  trades: readonly SteuerTrade[],
  jahr: number,
  opts: { waehrung?: string; echtgeld?: boolean } = {},
): Steuerbericht {
  const relevant = trades.filter((t) => (opts.echtgeld ?? false) === !(t.paper ?? true));
  const fifo = fifoVerrechnen(relevant);
  const imJahr = fifo.veraeusserungen.filter(
    (v) => Number(v.veraeusserungAm.slice(0, 4)) === jahr,
  );

  const toepfe: Record<Steuertopf, TopfSumme> = {
    aktien: leererTopf(),
    sonstige: leererTopf(),
    termin: leererTopf(),
    privat: leererTopf(),
  };
  let privatSteuerfrei = 0;
  let privatSteuerpflichtig = 0;

  for (const v of imJahr) {
    // Steuerfreie Krypto-Gewinne gehören in KEINEN Topf: Sie sind kein
    // Einkommen. Sie hier trotzdem zu summieren, wäre der bequeme Fehler —
    // die Zahl sähe größer aus und wäre falsch.
    if (v.topf === 'privat' && v.steuerfreiNachJahresfrist) {
      privatSteuerfrei = r2(privatSteuerfrei + v.ergebnis);
      continue;
    }
    const t = toepfe[v.topf];
    t.n += 1;
    if (v.ergebnis >= 0) t.gewinne = r2(t.gewinne + v.ergebnis);
    else t.verluste = r2(t.verluste - v.ergebnis);
    t.saldo = r2(t.gewinne - t.verluste);
    // Euro-Summen laufen getrennt mit und kippen auf null, sobald ein
    // Vorgang keinen Kurs hatte — ab da ist die Summe nicht mehr belegbar.
    if (v.eurErgebnis === undefined) {
      t.eurGewinne = null;
      t.eurVerluste = null;
      t.eurSaldo = null;
    } else if (t.eurGewinne !== null && t.eurVerluste !== null) {
      if (v.eurErgebnis >= 0) t.eurGewinne = r2(t.eurGewinne + v.eurErgebnis);
      else t.eurVerluste = r2(t.eurVerluste - v.eurErgebnis);
      t.eurSaldo = r2(t.eurGewinne - t.eurVerluste);
    }
    if (v.topf === 'privat') privatSteuerpflichtig = r2(privatSteuerpflichtig + v.ergebnis);
  }

  const stand = rechtsstandFuer(jahr);
  // Echte Lücken: Vorgänge in Fremdwährung OHNE eingefrorenen Kurs. Bis
  // 04.08. zählte diese Zahl jeden USD-Trade — sie war damit immer maximal
  // und sagte nichts. Jetzt sagt sie, wie viele Vorgänge nachgetragen
  // werden müssen, bevor die Euro-Summen vollständig sind.
  const fxLuecken = relevant.filter(
    (t) => brauchtUmrechnung(t.currency) && !(typeof t.fxRate === 'number' && t.fxRate > 0),
  ).length;

  return {
    jahr,
    waehrung: opts.waehrung ?? 'USD',
    echtgeld: opts.echtgeld ?? false,
    rechtsstand: stand,
    rechtsstandHinweis:
      `Sparer-Pauschbetrag ${stand.sparerPauschbetrag} €, § 23-Freigrenze ` +
      `${stand.privatFreigrenze} €, Abgeltungsteuer ${Math.round(stand.abgeltungsteuerSatz * 100)} % ` +
      `zzgl. ${(stand.soliSatz * 100).toFixed(1)} % Soli. Werte nach bestem Wissen — ` +
      `bitte mit dem Rechtsstand des Veranlagungsjahres abgleichen.`,
    toepfe,
    privatSteuerfrei,
    privatSteuerpflichtig,
    // Freigrenze greift nur bei GEWINN: Ein Verlust ist nie „unter der
    // Freigrenze steuerfrei", er ist ein verrechenbarer Verlust.
    privatUnterFreigrenze:
      privatSteuerpflichtig > 0 && privatSteuerpflichtig < stand.privatFreigrenze,
    veraeusserungen: imJahr,
    offen: fifo.offen,
    unpaarbar: fifo.unpaarbar,
    fxLuecken,
    erstelltAm: new Date().toISOString(),
  };
}

const csvFeld = (v: string | number | boolean | undefined): string => {
  if (v === undefined) return '';
  const s = String(v);
  // Anführungszeichen verdoppeln, Feld quoten, sobald Trenner/Zeilenumbruch
  // vorkommt. Ohne das zerreißt ein Symbol mit Komma die Spaltenzuordnung.
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Veräußerungsliste als CSV — das Format, das Steuerprogramme einlesen.
 *
 * Semikolon als Trenner und Komma als Dezimalzeichen: So erwartet es ein
 * deutsches Excel. Mit Punkt und Komma-Trenner landet jede Zahl als Text in
 * der Zelle, und der Empfänger tippt sie ab.
 */
export function veraeusserungenCsv(bericht: Steuerbericht): string {
  const kopf = [
    'Symbol',
    'Topf',
    'Richtung',
    'Menge',
    'Anschaffung',
    'Anschaffungskurs',
    'Veraeusserung',
    'Veraeusserungskurs',
    'Kosten',
    'Ergebnis',
    'Haltetage',
    'Steuerfrei',
    // Euro-Spalten (M12b): je Vorgang zum Kurs SEINES Tages umgerechnet.
    // Leere Felder heißen „kein Kurs hinterlegt" — nicht „null Euro".
    'Anschaffung EUR',
    'Veraeusserung EUR',
    'Kosten EUR',
    'Ergebnis EUR',
    'Kurs Anschaffung',
    'Kurs Veraeusserung',
  ];
  const zahl = (n: number): string => n.toFixed(2).replace('.', ',');
  const zeilen = bericht.veraeusserungen.map((v) =>
    [
      csvFeld(v.symbol),
      csvFeld(v.topf),
      csvFeld(v.richtung),
      csvFeld(zahl(v.menge)),
      csvFeld(v.anschaffungAm.slice(0, 10)),
      csvFeld(zahl(v.anschaffungKurs)),
      csvFeld(v.veraeusserungAm.slice(0, 10)),
      csvFeld(zahl(v.veraeusserungKurs)),
      csvFeld(zahl(v.kosten)),
      csvFeld(zahl(v.ergebnis)),
      csvFeld(v.haltetageGenau),
      csvFeld(v.steuerfreiNachJahresfrist === true ? 'ja' : ''),
      csvFeld(v.eurAnschaffung === undefined ? '' : zahl(v.eurAnschaffung)),
      csvFeld(v.eurVeraeusserung === undefined ? '' : zahl(v.eurVeraeusserung)),
      csvFeld(v.eurKosten === undefined ? '' : zahl(v.eurKosten)),
      csvFeld(v.eurErgebnis === undefined ? '' : zahl(v.eurErgebnis)),
      csvFeld(v.fx?.anschaffung ? `${v.fx.anschaffung.rate.toFixed(4).replace('.', ',')} (${v.fx.anschaffung.date})` : ''),
      csvFeld(v.fx?.veraeusserung ? `${v.fx.veraeusserung.rate.toFixed(4).replace('.', ',')} (${v.fx.veraeusserung.date})` : ''),
    ].join(';'),
  );
  return [kopf.join(';'), ...zeilen].join('\n');
}
