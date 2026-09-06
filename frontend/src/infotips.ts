/**
 * ⓘ-Erklär-Tooltips: Jeder Wert bekommt einen kleinen Info-Knopf mit
 * ausführlicher Erklärung — Fachbegriff, was er bedeutet und wie er sich
 * aufs Trading auswirkt. „Nicht jeder ist Profi — nur so kann man auch
 * lernen."
 *
 * EIN globales Popover, an document.body verankert (position:absolute mit
 * Scroll-Offsets — position:fixed wäre in den Glass-Cards die
 * backdrop-filter-Containing-Block-Falle). Delegierter Click-Handler:
 * funktioniert auch in nachträglich gerendertem Markup.
 */

import { sprachWahl, t as uebersetzt, type Sprache } from './i18n.js';

/** Ein Tip: Überschrift + ausführliche Erklärung. */
export interface Tip {
  t: string;
  d: string;
}

/**
 * ── Zweisprachigkeit ──────────────────────────────────────────────────────
 *
 * `INFO_DE` ist vollständig und die Quelle der Wahrheit. Der Fallback ist
 * FELDWEISE: Ein Eintrag mit übersetzter Überschrift, aber ohne übersetzten
 * Fließtext, zeigt die englische Überschrift über dem deutschen Text — nie
 * einen leeren Kasten, nie einen Schlüsselnamen. `infotips.test.ts` verlangt
 * trotzdem zu jedem deutschen Tip auch den englischen — sonst verfällt die
 * englische Oberfläche schleichend, und zwar unbemerkt, GERADE WEIL der
 * Fallback so leise ist.
 */
export const INFO_DE: Record<string, Tip> = {
  // ── Engine ──
  engine: {
    t: 'Engine',
    d: 'Der Auto-Trader handelt jede Minute für dein Konto bei Alpaca — mit genau den Strategien, die der nächtliche Optimierer je Symbol freigegeben hat (Champion). Der Schalter hier ist die einzige Eingangstür: AN heißt, der Takt nimmt dein Konto mit (verbundener Broker und Freischaltung vorausgesetzt); AUS heißt, es passiert nichts mehr — auch keine Ausstiege durch die Engine. Die Schutz-Stops liegen beim Broker und bleiben davon unberührt. Der Status darunter ist der Spiegel des letzten Takts: Equity, Cash, Tagesstart und Hoch (die Bezugsgrößen der Notbremsen), Day-Trades (PDT-Regel unter 25 000 $), offene Positionen und der Zeitpunkt des letzten Takts. Ein Stand von gestern sieht sonst aus wie ein Stand von jetzt — deshalb steht das Alter immer dabei.',
  },
  engineKommandos: {
    t: 'Halt · Resume · Flatten',
    d: 'Drei Kommandos an die Engine, die im NÄCHSTEN Takt ausgeführt werden — der Knopf hinterlegt sie nur. HALT sperrt neue Einstiege; Ausstiege und Schutz-Stops laufen weiter (Exits werden nie gesperrt). RESUME hebt einen Halt auf — aber nur über die Ursache: Ein Tages-Halt endet von selbst am nächsten Handelstag und lässt sich nicht vorzeitig lösen; ein Drawdown-Halt verlangt die ausdrückliche Bestätigung, dass der Peak neu gesetzt wird (sonst löste dieselbe Sperre im nächsten Takt sofort wieder aus). FLATTEN storniert die offenen Orders der Engine und schließt alle Positionen ihres Buchs — Handpositionen im selben Konto bleiben unberührt; bei geschlossenem Markt zurückgestellt bis zur nächsten Eröffnung. Jedes Kommando steht mit Ergebnis im Journal; ein Kommando, das älter als 24 Stunden ist, verfällt.',
  },
  engineWhy: {
    t: 'Warum handelt die Engine (nicht)?',
    d: 'Die Antwort aus zwei Quellen: dem Herzschlag der Plattform (läuft der Takt überhaupt, ist der Markt offen, gab es einen Fehler beim Laden der Kurse?) und dem Spiegel deines Kontos (Schalter, Freischaltung, Halt mit Grund, letzter Fehler, Champion, Positionslimit, zurückgestellte Ausstiege). „Es passiert nichts" sieht bei einer scharf gestellten Sperre exakt genauso aus wie bei einem toten System — hier steht der Unterschied. Die Liste nennt nur, was wirklich blockiert; steht nichts dort, handelt die Engine frei, sobald eine Strategie ein Signal gibt. Wenige Einstiege sind dabei kein Fehler: Die Strategien handeln bewusst selten, und „kein Champion" heißt, dass der Optimierer für dieses Symbol keine Strategie gefunden hat, die out-of-sample nach Kosten überlebt.',
  },
  // ── Einstellungen des Auto-Traders ──
  autoSettings: {
    t: 'Einstellungen des Auto-Traders',
    d: 'Alles, was du am Handel selbst einstellst — mehr nicht. Welche Strategie mit welchen Parametern handelt, entscheidet der nächtliche Optimierer je Symbol (Champion); Signale, Stops und Ziele kommen aus diesen Strategien. Du bestimmst das Risiko: wie viel je Trade auf dem Spiel steht, wie groß eine Position höchstens wird, wie viele gleichzeitig offen sind, wann die Tages-Notbremse und die Drawdown-Sperre greifen, ob Leerverkäufe erlaubt sind — und welche Symbole des Plattform-Universums gehandelt werden dürfen. Gespeichert wird per Knopf; der Server prüft jeden Wert erneut und lehnt ab, was der Takt nicht nähme.',
  },
  riskPerTrade: {
    t: 'Risiko je Trade',
    d: 'Wie viel Prozent der Equity ein einzelner Trade höchstens verlieren darf, wenn sein Stop greift. Die Stückzahl folgt daraus: Risiko-Budget geteilt durch den Abstand zwischen Einstand und Stop. Ein Titel mit engem Stop bekommt mehr Stücke, einer mit weitem weniger — jede Position trägt denselben Risikobeitrag, statt dass zwei, drei unruhige Titel das ganze Depot bestimmen. Bei 0,5 % kostet JEDER ausgestoppte Trade rund ein halbes Prozent des Depots. „Max. Positionsgröße" bleibt als harte Obergrenze — ein sehr enger Stop ergäbe sonst rechnerisch ein Vielfaches der Equity. 0 heißt: kein Risiko-Budget, also keine Einstiege.',
  },
  maxPos: {
    t: 'Maximale Positionsgröße',
    d: 'Wie viel Prozent der Equity eine EINZELNE Position höchstens binden darf. Das klassische Risikomanagement-Werkzeug gegen Klumpenrisiko: 20 % heißt, ein Totalausfall eines Symbols kostet maximal ein Fünftel des Depots. Der Deckel greift NACH der Risiko-Rechnung — er kappt Positionen, die wegen eines engen Stops sonst zu groß würden.',
  },
  maxOpenPositions: {
    t: 'Max. gleichzeitige Positionen',
    d: 'Wie viele Positionen höchstens gleichzeitig offen sein dürfen. Ist das Limit erreicht, ignoriert die Engine jedes weitere Einstiegssignal — bis eine Position schließt. Zusammen mit der Positionsgröße bestimmt das, wie voll das Depot maximal wird: 4 Positionen à 20 % binden vier Fünftel, der Rest bleibt Cash. Mehr Positionen streuen das Risiko, machen aber jede einzelne unbedeutender.',
  },
  dailyLossLimit: {
    t: 'Tages-Notbremse',
    d: 'Die Grenze, ab der für heute Schluss ist — gemessen an der Equity zu Tagesbeginn, inklusive Buchverlusten. WOZU, WENN ES DOCH STOPS GIBT: Der Stop schützt eine POSITION. Er hilft nicht gegen den Fall, der Konten wirklich leert: viele kleine Verluste hintereinander an einem Tag, jeder für sich regelkonform gestoppt. Ein Tages-Limit beantwortet die Frage, die kein einzelner Stop beantworten kann: Wann hört man auf? WARUM BUCHVERLUSTE MITZÄHLEN: Zählte nur, was realisiert ist, löste die Bremse nie aus, solange niemand verkauft. WAS SIE TUT: Sie stellt glatt und sperrt Einstiege bis zum nächsten Handelstag. WIE SIE SICH LÖST: Am nächsten Handelstag von selbst — nicht per Knopf und nicht, weil der Kurs kurz zurückkommt; sonst hätte sie an genau dem Tag nichts verhindert, an dem sie gebraucht wird. 0 = aus.',
  },
  maxDrawdown: {
    t: 'Drawdown-Sperre',
    d: 'Der Abstand zum höchsten je gesehenen Equity-Stand (Peak), ab dem die Engine keine Einstiege mehr macht. Anders als die Tages-Notbremse endet diese Sperre NICHT von selbst: Sie bleibt, bis du sie mit RESUME bewusst aufhebst — und dabei bestätigst, dass der Peak auf die aktuelle Equity gesetzt wird. Genau das ist der Sinn: Ein System, das 10 % vom Hoch verloren hat, soll nicht still weiterhandeln, sondern angesehen werden — was lief, was nicht, ob die Strategie noch trägt. Ausstiege und Schutz-Stops laufen im Halt weiter. 0 = aus.',
  },
  allowShort: {
    t: 'Shorten (Leerverkäufe)',
    d: 'Erlaubt den Strategien, auf FALLENDE Kurse zu setzen: Ein Short-Signal eröffnet einen Leerverkauf (der Broker leiht die Stücke), das Eindecken schließt ihn. Gewinn = Einstand minus Rückkaufkurs. Wichtig: Beim Shorten sind Verluste theoretisch unbegrenzt (der Kurs kann beliebig steigen) — deshalb ist das bewusst ein Opt-in. Stop (über dem Einstand) und Ziel liegen gespiegelt als Bracket-Order beim Broker; die Notbremsen gelten unverändert.',
  },
  telegram: {
    t: 'Telegram-Benachrichtigungen',
    d: 'Die Engine meldet über den Plattform-Bot, was sie getan hat: Einstiege, Ausstiege, ausgelöste Notbremsen, Halt und Resume, Fehler. Nur Ereignisse, nie Kurse — ein Bot, der jede Minute schreibt, wird stummgeschaltet und ist dann bei der einen Meldung, die zählt, nicht mehr da. Die Zuordnung deines Telegram-Kontos richtet der Betreiber ein.',
  },
  symbolauswahl: {
    t: 'Symbole',
    d: 'Das Plattform-Universum sind die Symbole, für die Kurse geladen und Strategien optimiert werden — für alle Konten dieselben. Du wählst daraus, was DEIN Konto handeln darf. Sind alle gewählt, wächst deine Auswahl mit dem Universum; eine Teilmenge bleibt eine Teilmenge. Das Häkchen ✓ steht für einen freigegebenen Champion (der Optimierer hat eine Strategie gefunden, die out-of-sample nach Kosten trägt); „kein Handel" heißt, dass keine Strategie die Prüfung bestanden hat — dieses Symbol handelt die Engine nicht, auch wenn es gewählt ist. Das ist ein zulässiges Ergebnis, kein Fehler.',
  },
  // ── Champion ──
  champion: {
    t: 'Champion je Symbol',
    d: 'Welche Strategie mit welchen Parametern für ein Symbol handelt — entschieden vom nächtlichen Optimierer, nicht von Hand. Ein Kandidat wird nur Champion, wenn er die Robustheits-Tore besteht (mindestens 60 Trades out-of-sample, Wahrscheinlichkeit eines echten Vorteils ≥ 90 %, Gebührenanteil ≤ 50 %, stabile Nachbarschaft der Parameter) UND den amtierenden Champion auf sauberem, späterem OOS-Fenster schlägt. „Score" ist der OOS-Zielwert, „Trades" und „netto" die OOS-Kette nach Kosten, „Folds+" der Anteil positiver Walk-Forward-Abschnitte. Symbole unter „kein Handel" haben keine Strategie, die diese Prüfung bestanden hat — die Engine lässt sie in Ruhe. Der Bericht zeigt den vollständigen Lauf der letzten Nacht.',
  },
  // ── Konto ──
  resetWallet: {
    t: 'Konto zurücksetzen',
    d: 'Löscht Handelshistorie, offene Positionen im Buch und alle Kennzahlen und stellt den Kontostand auf das Startkapital. Wozu das gut ist: Nach einem Umbau messen die alten Trades ein System, das es nicht mehr gibt — sie stehen zu lassen hieße, monatelang nicht unterscheiden zu können, ob eine Verbesserung echt ist oder nur Verdünnung. WAS BLEIBT: alle Kursdaten, der Champion und deine Einstellungen. WAS GEHT: Trades, Positionen, Equity-Kurve, Kennzahlen. Es wird eine Schnittmarke gesetzt, damit nachvollziehbar bleibt, ab wann gemessen wurde. Ein Reset leert NUR das Buch, nie das Broker-Depot — was dort liegt, liegt weiter dort. Nicht rückgängig zu machen.',
  },
  brokerStatus: {
    t: 'Echtgeld-Anbindung',
    d: 'DIE LIVE-REIFE ist die wichtigste Zeile dieser Karte. Sie setzt die Regel um, dass erst umgeschaltet wird, wenn das System nachweislich Gewinn schreibt — und zwar nicht als Merkzettel, sondern als Sperre im Ausführungspfad. Selbst wenn beide Freigaben stehen, bleibt der Handel auf Papier, solange ein Kriterium fehlt. Der Grund für diese Härte: Der Moment, in dem jemand den Schalter gegen die Datenlage umlegen will, ist genau der Moment, in dem er die Datenlage am wenigsten sehen will. FÜNF KRITERIEN: Stichprobe, Profitfaktor ≥ 1,20 (Papierhandel unterschätzt die Wirklichkeit systematisch — Teilausführungen, echte Slippage, verpasste Kurse), Gebührenanteil ≤ 50 % des Bruttoergebnisses, Nettoergebnis über null, Messstrecke ohne Unterbrechung (Gewinn über drei Tage ist Wetter, nicht Klima). DIE KANTE JE TRADE darunter ist die Zahl, an der alles hängt: Was ein Trade im Mittel einbringt, gegen das, was er kostet. Deckung unter 1 heißt, dass jeder einzelne Trade im Erwartungswert Geld verliert — dann hilft keine bessere Marktphase, sondern nur weniger und bessere Trades. Prüft die Verbindung zum Broker (Alpaca), OHNE eine Order zu senden — wer die Anbindung erst beim ersten Trade testet, testet sie mit Geld. WARUM ALPACA: weil es ein Papierkonto mit derselben Schnittstelle betreibt wie das Echtgeldkonto; nur die Adresse unterscheidet sich. DREI SCHALTER, ALLE DREI NÖTIG: (1) Echtgeld-Schlüssel (AK…) hinterlegt — verschlüsselt, nie im Browser. (2) Echtgeld-Schalter in diesen Optionen. (3) Umgebungs-Freigabe ALPACA_ALLOW_LIVE — ein zweiter Schalter an einem anderen Ort, an den keine Oberfläche herankommt. Fehlt einer, läuft alles weiter auf Papier. GEGEN DOPPELORDERS: Jede Order trägt eine Kennung aus Symbol und Takt; läuft eine Function nach einem Fehler erneut an, erkennt der Broker die Kennung wieder und lehnt die Wiederholung ab.',
  },
  taxReport: {
    t: 'Steuer-Export (Deutschland)',
    d: 'Bereitet die Handelshistorie so auf, wie das deutsche Steuerrecht sie sehen will — und zwar getrennt nach Töpfen, weil Gewinne und Verluste hier NICHT frei gegeneinander verrechnet werden dürfen. Wer alles in eine Summe wirft, rechnet sich systematisch zu wenig Steuer aus; das ist der häufigste Fehler in selbstgebauten Auswertungen. DIE VIER TÖPFE: (1) Aktien — Verluste aus Aktienverkäufen dürfen nur gegen Gewinne aus Aktienverkäufen (§ 20 Abs. 6 Satz 4 EStG); ein Aktienverlust rettet keinen ETF-Gewinn. (2) Sonstige — ETFs, Fonds, Anleihen. (3) Termingeschäfte — dazu zählt JEDER Leerverkauf, auch auf Krypto. (4) Privat — Kryptowährungen laufen als privates Veräußerungsgeschäft (§ 23 EStG) unter einem ganz anderen Regime: persönlicher Steuersatz statt Abgeltungsteuer, dafür nach EINEM JAHR Haltedauer komplett steuerfrei. Diese Frist wird taggenau gerechnet, nicht mit 365 Tagen — in Schaltjahren liegt das einen Tag auseinander, und ein Tag entscheidet hier über den vollen Gewinn. FIFO: Bei mehreren Käufen desselben Papiers gilt der älteste Bestand als zuerst verkauft — so schreibt es das Gesetz vor, und der Einstandskurs entscheidet über den Gewinn. Die Rechnung nutzt die volle Historie inklusive der Trades, die ein Konto-Reset ins Archiv verschoben hat: Ein Verkauf im Januar bleibt steuerpflichtig, auch wenn du im März zurückgesetzt hast. FREIGRENZE, nicht Freibetrag: Bleibt der Krypto-Gewinn unter der Grenze, ist er ganz steuerfrei — ein Euro darüber macht den GANZEN Betrag steuerpflichtig. WAS DAS NICHT IST: eine Steuerberatung. Es wird bewusst keine Steuerschuld gerechnet — die hängt von Kirchensteuer, Veranlagungsart, Freistellungsaufträgen bei anderen Banken und Verlustvorträgen ab, die dieses System nicht kennt. Die CSV-Datei ist für deinen Steuerberater gedacht.',
  },
  // ── Performance ──
  gesamtPnl: {
    t: 'Gesamt P&L — was diese Zahl misst (und was nicht)',
    d: 'Gesamt P&L = Equity (live) − Kapitalbasis. Die Basis wird bei einem Reset NEU geankert — die Zahl zählt dann erst ab diesem Schnitt und ist die Summe aus „Realisiert" (geschlossen seit dem Schnitt) und „Offen" (unrealisierter Stand der offenen Positionen; wird erst beim Schließen zu echtem Ergebnis). Die Handelshistorie beantwortet eine ANDERE Frage: Was hat jeder einzelne geschlossene Trade gebracht — auch die vor dem Schnitt. Deshalb können beide gleichzeitig stimmen und gegenläufig aussehen: alte Abschlüsse im Minus, offene Positionen gerade im Plus. Der ehrlichste Einzelwert bleibt Equity (live) — der broker-identische Kontostand.',
  },
  equityCurve: {
    t: 'Equity-Kurve',
    d: 'Der Verlauf deines GESAMTEN Depotwerts (Cash + alle offenen Positionen zum jeweiligen Tageskurs). Einmal täglich nach US-Börsenschluss wird ein Punkt festgeschrieben — anders als die Live-Anzeige kann die Kurve deshalb nicht durch Zwischenstände „schön" wirken. Sie ist die ehrlichste Einzelgrafik, die es über eine Strategie gibt: Nicht einzelne Gewinner zählen, sondern ob die Linie über Wochen steigt. Solange es noch keine zwei Tages-Snapshots gibt, zeichnet die Karte die REALISIERTE Kurve aus den Abschlüssen — sie steht still, während eine offene Position läuft, und sagt das dazu.',
  },
  drawdown: {
    t: 'Drawdown-Verlauf',
    d: 'Für jeden Tag: der Abstand zum bis dahin höchsten Kontostand, in Prozent. 0 bedeutet neues Hoch, jeder Ausschlag nach unten ist ein laufender Einbruch. Das Panel teilt sich die Zeitachse mit der Equity-Kurve darüber — ein Tal in der Kurve und sein Drawdown stehen exakt untereinander. So sieht man auf einen Blick, ob Verluste kurze Dellen waren oder lange Durststrecken, und wie lange die Erholung zurück ans Hochwasser dauerte. Die Kennzahl „Max DD" in der Tabelle rechnet der Server aus derselben Serie.',
  },
  sharpe: {
    t: 'Sharpe-Ratio',
    d: 'Rendite pro Einheit Risiko: durchschnittliche Tagesrendite geteilt durch deren Schwankung, aufs Jahr skaliert (√252). Über 1 gilt als gut, über 2 als sehr gut. Eine hohe Rendite mit wilden Schwankungen kann eine SCHLECHTERE Sharpe haben als eine ruhige moderate. Im Portfolio steht „30" bzw. „90" für die letzten 30 bzw. 90 Tages-Snapshots. „--" heißt: noch zu wenig Kurve oder eine völlig flache Serie — bewusst kein geschöntes 0.',
  },
  maxdd: {
    t: 'Max Drawdown',
    d: 'Der tiefste Einbruch vom zwischenzeitlichen Höchststand, in Prozent — „wie weh tat es maximal?". Wichtigste Kennzahl fürs Durchhalten: −30 % braucht +43 % nur zum Ausgleich, −40 % schon +67 %. Kleiner ist besser, auch wenn die Rendite dafür etwas niedriger ausfällt.',
  },
  hwm: {
    t: 'Hochwasser-Marke (High-Water-Mark)',
    d: 'Der höchste Depotwert, den dein Konto je erreicht hat. Bezugspunkt für den Drawdown: Alles darunter ist noch nicht wieder aufgeholt. Steigt nur, wenn ein neuer Rekordstand erreicht wird.',
  },
  profitFactor: {
    t: 'Profit-Faktor',
    d: 'Summe aller Gewinne geteilt durch die Summe aller Verluste, über die abgeschlossenen Trades. Über 1 heißt: unterm Strich verdienst du Geld; 1,5 gilt als solide, unter 1 verliert die Strategie. Angenehm an dieser Zahl: Sie funktioniert unabhängig von der Trefferquote — wenige große Gewinner können viele kleine Verluste tragen. „--" erscheint, solange es noch keinen einzigen Verlust-Trade gibt (dann wäre der Wert unendlich, was nichts aussagt).',
  },
  expectancy: {
    t: 'Erwartungswert je Trade',
    d: 'Was ein durchschnittlicher abgeschlossener Trade eingebracht hat (Gesamt-P&L geteilt durch die Anzahl). Die Zahl übersetzt die Strategie in einen Satz: „Jeder Trade bringt im Mittel X $." Negativ heißt: Häufiger handeln verliert schneller Geld — Frequenz erhöhen lohnt nur bei positivem Erwartungswert.',
  },
};

/** Englische Fassung — vollständig; der Fallback bleibt trotzdem das Laufzeit-Netz. */
export const INFO_EN: Record<string, Partial<Tip>> = {
  engine: {
    t: 'Engine',
    d: 'The auto-trader trades your Alpaca account every minute — with exactly the strategies the nightly optimiser has cleared per symbol (champion). The switch here is the only entrance: ON means the tick includes your account (a connected broker and approval provided); OFF means nothing happens any more — not even engine exits. The protective stops sit at the broker and are unaffected. The status below is the mirror of the last tick: equity, cash, day start and peak (the reference points of the brakes), day trades (PDT rule below $25,000), open positions and the time of the last tick. A reading from yesterday would otherwise look like one from now — which is why the age is always shown.',
  },
  engineKommandos: {
    t: 'Halt · Resume · Flatten',
    d: 'Three commands to the engine, executed on the NEXT tick — the button only files them. HALT blocks new entries; exits and protective stops keep running (exits are never blocked). RESUME lifts a halt — but only via its cause: a daily halt ends by itself on the next trading day and cannot be released early; a drawdown halt requires the explicit acknowledgement that the peak is reset (otherwise the same lock would trigger again on the next tick). FLATTEN cancels the engine\'s open orders and closes all positions in its book — manual positions in the same account stay untouched; deferred to the next open while the market is closed. Every command lands in the journal with its outcome; a command older than 24 hours expires.',
  },
  engineWhy: {
    t: 'Why is the engine (not) trading?',
    d: 'The answer from two sources: the platform heartbeat (is the tick running at all, is the market open, did loading prices fail?) and the mirror of your account (switch, approval, halt with reason, last error, champion, position limit, deferred exits). “Nothing is happening” looks exactly the same under a sharply set lock as under a dead system — this is where the difference shows. The list names only what really blocks; if nothing is listed, the engine trades freely as soon as a strategy signals. Few entries are not a fault: the strategies deliberately trade rarely, and “no champion” means the optimiser found no strategy for this symbol that survives out of sample after costs.',
  },
  autoSettings: {
    t: 'Auto-trader settings',
    d: 'Everything you set about the trading yourself — and nothing more. Which strategy trades with which parameters is decided per symbol by the nightly optimiser (champion); signals, stops and targets come from those strategies. You decide the risk: how much is at stake per trade, how large a position may get, how many may be open at once, when the daily brake and the drawdown lock bite, whether short sales are allowed — and which symbols of the platform universe may be traded. Saving is explicit; the server re-checks every value and rejects what the tick would not accept.',
  },
  riskPerTrade: {
    t: 'Risk per trade',
    d: 'The share of equity a single trade may lose at most when its stop is hit. The quantity follows from it: risk budget divided by the distance between entry and stop. A name with a tight stop gets more shares, one with a wide stop fewer — every position carries the same risk contribution, instead of two or three restless names driving the whole portfolio. At 0.5 %, EVERY stopped-out trade costs roughly half a percent of the portfolio. “Maximum position size” remains as a hard ceiling — a very tight stop would otherwise compute to a multiple of the equity. 0 means: no risk budget, hence no entries.',
  },
  maxPos: {
    t: 'Maximum position size',
    d: 'The largest share of equity a SINGLE position may tie up. The classic risk-management tool against concentration risk: 20 % means a total loss on one symbol costs at most a fifth of the portfolio. The cap applies AFTER the risk calculation — it trims positions that would otherwise grow too large because of a tight stop.',
  },
  maxOpenPositions: {
    t: 'Max. concurrent positions',
    d: 'How many positions may be open at the same time at most. Once the limit is reached, the engine ignores every further entry signal — until a position closes. Together with the position size this determines how full the portfolio gets at most: 4 positions at 20 % tie up four fifths, the rest stays in cash. More positions spread the risk but make each one less meaningful.',
  },
  dailyLossLimit: {
    t: 'Daily loss brake',
    d: 'The limit at which the day is over — measured against the equity at the start of the day, including unrealised losses. WHY, GIVEN THERE ARE STOPS: a stop protects a POSITION. It does not help against the case that really empties accounts: many small losses in a row on one day, each of them stopped by the rules. A daily limit answers the question no single stop can: when do you stop? WHY UNREALISED LOSSES COUNT: if only realised losses counted, the brake would never trigger as long as nobody sells. WHAT IT DOES: it flattens and blocks entries until the next trading day. HOW IT RELEASES: by itself on the next trading day — not by button and not because the price briefly recovers; otherwise it would have prevented nothing on exactly the day it is needed. 0 = off.',
  },
  maxDrawdown: {
    t: 'Drawdown lock',
    d: 'The distance from the highest equity ever seen (peak) at which the engine stops entering. Unlike the daily brake this lock does NOT end by itself: it stays until you lift it deliberately with RESUME — acknowledging that the peak is reset to the current equity. That is the point: a system 10 % below its high should not quietly keep trading but be looked at — what worked, what did not, whether the strategy still carries. Exits and protective stops keep running during the halt. 0 = off.',
  },
  allowShort: {
    t: 'Shorting (short sales)',
    d: 'Allows the strategies to bet on FALLING prices: a short signal opens a short sale (the broker lends the shares), covering closes it. Profit = entry minus repurchase price. Important: when shorting, losses are theoretically unlimited (the price can rise arbitrarily) — which is why this is deliberately opt-in. Stop (above the entry) and target sit mirrored as a bracket order at the broker; the brakes apply unchanged.',
  },
  telegram: {
    t: 'Telegram notifications',
    d: 'The engine reports through the platform bot what it did: entries, exits, triggered brakes, halt and resume, errors. Events only, never prices — a bot that writes every minute gets muted and is then gone for the one message that matters. The operator sets up the link to your Telegram account.',
  },
  symbolauswahl: {
    t: 'Symbols',
    d: 'The platform universe is the set of symbols for which prices are loaded and strategies optimised — the same for all accounts. You pick from it what YOUR account may trade. With all selected, your selection grows with the universe; a subset stays a subset. The tick ✓ marks a cleared champion (the optimiser found a strategy that carries out of sample after costs); “no trade” means no strategy passed the test — the engine will not trade that symbol even if selected. That is a legitimate outcome, not an error.',
  },
  champion: {
    t: 'Champion per symbol',
    d: 'Which strategy trades a symbol with which parameters — decided by the nightly optimiser, not by hand. A candidate only becomes champion if it passes the robustness gates (at least 60 out-of-sample trades, probability of a real edge ≥ 90 %, fee share ≤ 50 %, a stable parameter neighbourhood) AND beats the incumbent on a clean, later OOS window. “Score” is the OOS objective, “trades” and “net” the OOS chain after costs, “folds+” the share of positive walk-forward segments. Symbols under “no trade” have no strategy that passed — the engine leaves them alone. The report shows the complete run of the last night.',
  },
  resetWallet: {
    t: 'Reset account',
    d: 'Deletes the trading history, open positions in the book and all metrics, and sets the balance back to the starting capital. WHAT IT IS FOR: after a rebuild, the old trades measure a system that no longer exists — leaving them would mean not being able to tell for months whether an improvement is real or mere dilution. WHAT STAYS: all price data, the champion and your settings. WHAT GOES: trades, positions, equity curve, metrics. A cut mark is recorded so it stays traceable from when measurement started. A reset empties ONLY the book, never the broker account — what sits there keeps sitting there. Cannot be undone.',
  },
  brokerStatus: {
    t: 'Live-money connection',
    d: 'LIVE MATURITY is the most important line on this card. It implements the rule that the switch is only thrown once the system demonstrably makes money — and not as a sticky note but as a lock in the execution path. Even with both approvals in place, trading stays on paper as long as one criterion is missing. The reason for that hardness: the moment somebody wants to flip the switch against the data is exactly the moment they least want to look at the data. FIVE CRITERIA: sample size, profit factor ≥ 1.20 (paper trading systematically understates reality — partial fills, real slippage, prices missed), fee share ≤ 50 % of the gross result, net result above zero, an uninterrupted measurement run (a profit over three days is weather, not climate). THE EDGE PER TRADE below is the number everything hangs on: what a trade brings in on average against what it costs. A coverage below 1 means every single trade loses money in expectation — no better market phase fixes that, only fewer and better trades. It checks the connection to the broker (Alpaca) WITHOUT sending an order — testing the connection with your first trade means testing it with money. WHY ALPACA: because it runs a paper account on the same interface as the live account; only the address differs. THREE SWITCHES, ALL THREE REQUIRED: (1) live keys (AK…) stored — encrypted, never in the browser. (2) The live-money switch in these options. (3) Environment approval ALPACA_ALLOW_LIVE — a second switch in a different place that no user interface can reach. If one is missing, everything keeps running on paper. AGAINST DOUBLE ORDERS: every order carries an identifier built from symbol and tick; if a function restarts after an error, the broker recognises the identifier and rejects the repeat.',
  },
  taxReport: {
    t: 'Tax export (Germany)',
    d: 'Prepares the trading history the way German tax law wants to see it — separated into pots, because gains and losses may NOT be freely offset against each other here. Throwing everything into one sum systematically understates the tax owed; that is the most common mistake in home-made evaluations. THE FOUR POTS: (1) Equities — losses from share sales may only offset gains from share sales (§ 20 (6) sentence 4 EStG); an equity loss does not rescue an ETF gain. (2) Other — ETFs, funds, bonds. (3) Futures and derivatives — this includes EVERY short sale, crypto included. (4) Private — cryptocurrencies count as a private disposal transaction (§ 23 EStG) under an entirely different regime: your personal tax rate instead of the flat withholding tax, but completely tax-free after ONE YEAR of holding. That deadline is computed to the day, not as 365 days — in leap years those differ by one day, and one day decides the entire gain here. FIFO: with several purchases of the same instrument, the oldest holding counts as sold first — the law prescribes it, and the entry price decides the gain. The calculation uses the full history including trades an account reset moved into the archive: a sale in January stays taxable even if you reset in March. EXEMPTION LIMIT, not an allowance: if the crypto gain stays below the limit it is entirely tax-free — one euro above and the WHOLE amount becomes taxable. WHAT THIS IS NOT: tax advice. No tax liability is computed, deliberately — that depends on church tax, filing status, exemption orders at other banks and loss carry-forwards this system does not know about. The CSV file is meant for your tax adviser.',
  },
  gesamtPnl: {
    t: 'Total P&L — what this number measures (and what it does not)',
    d: 'Total P&L = equity (live) − capital base. The base is RE-ANCHORED on a reset — the number then counts only from that cut, and it is the sum of “realised” (closed since the cut) and “open” (the unrealised standing of open positions; only a real result once closed). The trade history answers a DIFFERENT question: what did each closed trade produce — including the ones before the cut. So both can be right at the same time and look contradictory: old closings in the red, open positions currently in the green. The most honest single value stays equity (live) — the balance identical to the broker’s.',
  },
  equityCurve: {
    t: 'Equity curve',
    d: 'The course of your ENTIRE portfolio value (cash plus all open positions at that day’s price). One point is written down once a day after the US close — unlike the live display, the curve therefore cannot be made to look “nice” by an interim reading. It is the most honest single chart there is about a strategy: individual winners do not count, only whether the line rises over weeks. As long as there are not yet two daily snapshots, the card draws the REALISED curve from the closings — it stands still while a position is open, and says so.',
  },
  drawdown: {
    t: 'Drawdown history',
    d: 'For each day: the distance to the highest account balance up to that point, in percent. 0 means a new high; every downward excursion is an ongoing decline. This panel shares its time axis with the equity curve above — a trough in the curve and its drawdown sit exactly one below the other. That shows at a glance whether losses were short dips or long dry spells, and how long the recovery back to the high-water mark took. The “Max DD” figure in the table is computed by the server from the same series.',
  },
  sharpe: {
    t: 'Sharpe ratio',
    d: 'Return per unit of risk: the average daily return divided by its volatility, scaled to a year (√252). Above 1 counts as good, above 2 as very good. A high return with wild swings can have a WORSE Sharpe than a calm moderate one. In the portfolio, “30” and “90” stand for the last 30 or 90 daily snapshots. “--” means: not enough curve yet, or a completely flat series — deliberately not a flattering 0.',
  },
  maxdd: {
    t: 'Max drawdown',
    d: 'The deepest fall from an interim high, in percent — “how much did it hurt at worst?”. The most important number for staying the course: −30 % needs +43 % just to break even, −40 % already needs +67 %. Smaller is better, even at the cost of a slightly lower return.',
  },
  hwm: {
    t: 'High-water mark',
    d: 'The highest portfolio value your account has ever reached. The reference point for the drawdown: everything below it has not been made back yet. It only rises when a new record is set.',
  },
  profitFactor: {
    t: 'Profit factor',
    d: 'The sum of all gains divided by the sum of all losses, across the closed trades. Above 1 means you make money on balance; 1.5 counts as solid, below 1 the strategy loses. The pleasant thing about this number: it works independently of the hit rate — a few large winners can carry many small losses. “--” appears as long as there is not a single losing trade (the value would be infinite, which says nothing).',
  },
  expectancy: {
    t: 'Expectancy per trade',
    d: 'What an average closed trade brought in (total P&L divided by the count). The number translates the strategy into one sentence: “every trade returns $X on average.” Negative means: trading more often loses money faster — raising the frequency only pays with a positive expectancy.',
  },
};

/**
 * Pure Auswahl-Regel — als eigene Funktion, damit der Test die
 * Fallback-Semantik mit beliebigen Wörterbüchern prüfen kann.
 */
export function waehleTips(
  de: Record<string, Tip>,
  en: Record<string, Partial<Tip>>,
  sprache: Sprache,
): Record<string, Tip> {
  if (sprache !== 'en') return de;
  const out: Record<string, Tip> = {};
  for (const [id, tip] of Object.entries(de)) {
    const u = en[id];
    out[id] = {
      t: u?.t && u.t.length > 0 ? u.t : tip.t,
      d: u?.d && u.d.length > 0 ? u.d : tip.d,
    };
  }
  return out;
}

/* Auswahl zur MODUL-Ladezeit: sicher, weil der Sprachwechsel bewusst per
 * location.reload() arbeitet (s. i18n.ts) — jede Seite lädt das Modul in
 * genau einer Sprache. */
export const INFO: Record<string, Tip> = waehleTips(INFO_DE, INFO_EN, sprachWahl());

let pop: HTMLElement | null = null;
let openKey: string | null = null;

function ensurePop(): HTMLElement {
  if (pop) return pop;
  pop = document.createElement('div');
  pop.id = 'infoPop';
  pop.className = 'ipop';
  pop.hidden = true;
  pop.setAttribute('role', 'note');
  document.body.appendChild(pop);
  return pop;
}

function hidePop(): void {
  if (pop) pop.hidden = true;
  openKey = null;
}

/** ⓘ-Knopf-Markup für einen Dictionary-Schlüssel (unbekannt ⇒ leer). */
export function iBtn(key: string): string {
  const info = INFO[key];
  if (!info) return '';
  return `<button type="button" class="ibtn" data-info="${key}" aria-label="${uebersetzt('tip.erklaerung')}: ${info.t}" title="${uebersetzt('tip.wasBedeutet')}">ⓘ</button>`;
}

let wired = false;

/** Einmalige Verdrahtung (delegiert) — mehrfacher Aufruf ist ein No-op. */
export function initInfoTips(): void {
  if (wired) return;
  wired = true;
  document.addEventListener('click', (ev) => {
    const el = ev.target as HTMLElement;
    const btn = el.closest?.('.ibtn') as HTMLElement | null;
    const p = ensurePop();
    if (btn) {
      const key = btn.dataset['info'] ?? '';
      const info = INFO[key];
      if (!info) return;
      if (openKey === key && !p.hidden) {
        hidePop(); // zweiter Klick auf denselben Knopf schließt
        return;
      }
      openKey = key;
      p.innerHTML = `<b>${info.t}</b><p>${info.d}</p>`;
      p.hidden = false;
      // Unter dem Knopf platzieren, an den Viewport geklemmt (absolute + Scroll)
      const r = btn.getBoundingClientRect();
      const pw = Math.min(340, window.innerWidth - 16);
      p.style.width = `${pw}px`;
      const minLeft = window.scrollX + 8;
      const maxLeft = window.scrollX + window.innerWidth - pw - 8;
      p.style.left = `${Math.max(minLeft, Math.min(r.left + window.scrollX - 10, maxLeft))}px`;
      p.style.top = `${r.bottom + window.scrollY + 6}px`;
      return;
    }
    if (!el.closest?.('#infoPop')) hidePop();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') hidePop();
  });
}
