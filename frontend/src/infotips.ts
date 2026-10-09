/**
 * ⓘ-Erklär-Tooltips (User-Wunsch 25.07.): Jeder Wert bekommt einen kleinen
 * Info-Knopf mit ausführlicher deutscher Erklärung — Fachbegriff, was er
 * bedeutet und wie er sich aufs Trading auswirkt. „Nicht jeder ist Profi —
 * nur so kann man auch lernen."
 *
 * EIN globales Popover, an document.body verankert (position:absolute mit
 * Scroll-Offsets — position:fixed wäre in den Glass-Cards die
 * backdrop-filter-Containing-Block-Falle, CLAUDE.md §6). Delegierter
 * Click-Handler: funktioniert auch in nachträglich gerendertem Markup
 * (Karten werden komplett neu gerendert).
 */

import { sprachWahl, t as uebersetzt, type Sprache } from './i18n.js';

/** Ein Tip: Überschrift + ausführliche Erklärung. */
export interface Tip {
  t: string;
  d: string;
}

/**
 * ── Zweisprachigkeit (Task #139, Tranche 5) ───────────────────────────────
 *
 * Die Tips sind der größte Textbestand der App (70 Einträge, viele davon
 * mehrere Sätze). Sie werden deshalb NICHT einzeln ins allgemeine Wörterbuch
 * gehoben, sondern bleiben hier — als zwei Records nebeneinander.
 *
 * `INFO_DE` ist vollständig und die Quelle der Wahrheit. Der Fallback ist
 * FELDWEISE: Ein Eintrag mit übersetzter Überschrift, aber ohne übersetzten
 * Fließtext, zeigt die englische Überschrift über dem deutschen Text — nie
 * einen leeren Kasten, nie einen Schlüsselnamen.
 *
 * ── Stand seit 18.08. (Tranche 5c): `INFO_EN` ist VOLLSTÄNDIG ─────────────
 *
 * Alle 70 Einträge sind übersetzt. Der Fallback bleibt trotzdem, und das ist
 * kein Widerspruch — die beiden Regeln greifen an verschiedenen Stellen:
 *
 *   - Zur LAUFZEIT ist der Fallback das Sicherheitsnetz. Ein fehlendes Feld
 *     darf nie zu einem leeren Popover führen, egal wodurch es entsteht.
 *   - Im REVIEW ist Vollständigkeit Pflicht. `infotips.test.ts` verlangt zu
 *     jedem neuen deutschen Tip auch den englischen; sonst verfällt die
 *     englische Oberfläche wieder schleichend, und zwar unbemerkt — genau
 *     weil der Fallback so leise ist.
 */
export const INFO_DE: Record<string, Tip> = {
  // ── Klassische Strategie-Parameter ──
  rsiBuy: {
    t: 'RSI-Kaufschwelle',
    d: 'Der Relative-Stärke-Index (RSI, 14 Perioden) misst von 0–100, wie überkauft oder überverkauft ein Markt ist. Fällt der RSI UNTER diese Schwelle (klassisch 30), gilt der Markt als überverkauft — der Indikator gibt eine Kauf-Stimme in die Konfluenz. Niedrigere Schwelle = seltenere, aber konservativere Kaufsignale.',
  },
  rsiSell: {
    t: 'RSI-Verkaufsschwelle',
    d: 'Steigt der RSI ÜBER diese Schwelle (klassisch 70), gilt der Markt als überkauft — der Indikator stimmt für Verkauf. Höhere Schwelle = du lässt Gewinne länger laufen, riskierst aber, den Wendepunkt zu verpassen.',
  },
  scan: {
    t: 'Scan-Intervall',
    d: 'So oft (in Minuten) prüft die Engine alle Watchlist-Symbole auf neue Signale. 5 Minuten ist die feinste Stufe — kürzer liefern die Gratis-Marktdaten nicht zuverlässig.',
  },
  konfluenz: {
    t: 'Minimale Konfluenz',
    d: 'Konfluenz = Übereinstimmung mehrerer unabhängiger Stimmen (RSI, MACD, Bollinger, Prognose). Erst wenn mindestens SO viele Stimmen in dieselbe Richtung zeigen, handelt die Engine. Höher = weniger, aber verlässlichere Trades; niedriger = aktiver, aber fehleranfälliger.',
  },
  periode: {
    t: 'Daten-Periode',
    d: 'Wie viel Kurshistorie die Indikator-Berechnung sieht (z. B. 1 Jahr Tageskerzen). Beeinflusst gleitende Durchschnitte und den Kontext der Signale, nicht die Handelsfrequenz.',
  },
  maxPos: {
    t: 'Maximale Positionsgröße',
    d: 'Wieviel Prozent des Startkapitals eine EINZELNE Position höchstens binden darf. Das klassische Risikomanagement-Werkzeug gegen Klumpenrisiko: 10 % heißt, ein Totalausfall eines Symbols kostet maximal ein Zehntel des Depots.',
  },
  trailingStop: {
    t: 'Nachziehender Stop (Trailing-Stop)',
    d: 'Ein Stop, der mitwandert: Steigt der Kurs, zieht er nach; fällt er, bleibt er stehen. Verkauft wird, wenn der Kurs um diesen Prozentsatz unter den HÖCHSTKURS seit Einstieg fällt. Er greift bewusst erst, wenn die Position im Plus war — solange sie nie im Gewinn stand, ist der feste Stop zuständig. Ohne ihn schließt eine Position nur beim starren Ziel oder beim Stop, in Trendphasen also fast nie. 0 = aus.',
  },
  maxHold: {
    t: 'Maximale Haltedauer',
    d: 'Zwangsausstieg nach so vielen Kalendertagen, egal wie der Kurs steht. Sinn: Eine Position, die monatelang seitwärts läuft, bindet Kapital, das anderswo arbeiten könnte. 0 = aus (unbegrenzt halten).',
  },
  atrStop: {
    t: 'ATR-Stop (volatilitätsadaptiv)',
    d: 'Statt eines festen Prozentsatzes wird der Stop als Vielfaches der ATR gesetzt — der durchschnittlichen Tagesschwankung des Instruments. 2 % Stop sind bei Bitcoin (±4 % am Tag) reines Rauschen und werfen dich sofort raus, bei einem Index (±0,6 %) dagegen ein echtes Signal. Mit ATR passt sich der Abstand automatisch an Instrument UND Marktphase an. Typisch: 1,5–3. 0 = aus, dann gilt der Prozentwert.',
  },
  atrTake: {
    t: 'ATR-Ziel',
    d: 'Dasselbe Prinzip für die Gewinnmitnahme: Das Ziel liegt bei diesem Vielfachen der durchschnittlichen Tagesschwankung über dem Einstieg. Sinnvoll meist größer als der ATR-Stop (etwa doppelt), damit Gewinne die Verluste überwiegen können. 0 = aus, dann gilt der Prozentwert.',
  },
  exitConfluence: {
    t: 'Konfluenz für den Ausstieg',
    d: 'Wie viele Indikator-Stimmen ein VERKAUF braucht — getrennt vom Einstieg und bewusst niedriger. Der Grund ist asymmetrisch: Ein verpasster Einstieg kostet nur eine Chance, ein verpasster Ausstieg kostet Geld. Bei Gleichstand der Stimmen gewinnt deshalb der Verkauf. Vorher galt für beides dieselbe Schwelle — und weil RSI und Bollinger in fallenden Märkten „überverkauft, also kaufen" sagen, blockierten sie den Ausstieg genau dann, wenn er nötig gewesen wäre.',
  },
  forecastSolo: {
    t: 'Prognose darf allein entscheiden',
    d: 'Normalerweise ist das AUS: Die Prognose zählt beim Einstieg höchstens so viel, dass noch eine echte Indikator-Stimme dazukommen muss. Sonst reißt sie mit Gewicht 2 die Schwelle 2 im Alleingang — die „Konfluenz aus drei Indikatoren" wäre dann nur ein Etikett. Beim AUSSTIEG zählt sie ohnehin immer voll. Einschalten, wenn du der Prognose bewusst die Führung geben willst.',
  },
  signalTimeframe: {
    t: 'Signal-Zeitrahmen',
    d: 'Auf welchen Kerzen die Handels-Signale rechnen. „5-Minuten" (Standard): RSI, MACD, Bollinger und die Kurzfrist-Prognose laufen auf 5-Minuten-Kerzen — Signale drehen im Takt des 5-Minuten-Scans, die Engine handelt DEUTLICH häufiger (Daytrading-Stil). „Tageskerzen": die ruhige Sicht — Signale wechseln nur alle paar Tage, dafür weniger Rauschen und weniger Gebühren. Ehrlich gesagt: Jeder Trade kostet 0,1 % + Slippage — hohe Frequenz frisst Rendite, Paper-Trading ist der richtige Ort, das gefahrlos zu erleben.',
  },
  cooldownMin: {
    t: 'Kauf-Pause nach Verkauf',
    d: 'Wie viele Minuten ein Symbol nach einem Verkauf (auch Stop-Loss/Take-Profit) nicht wieder gekauft wird. Verhindert das Hin-und-Her (Whipsaw): Ein Stop-Loss feuert in fallenden Märkten — genau dann rufen RSI/Bollinger oft „überverkauft, kaufen!" und ohne Pause wäre das Symbol im nächsten Scan sofort wieder im Depot, minus Gebühren. Kleiner = mehr Trades; unter 5 Minuten (Scan-Takt) wäre die Pause wirkungslos, deshalb klemmt die Risiko-Hülle dort.',
  },
  minConfluence: {
    t: 'Konfluenz für den Einstieg',
    d: 'Wie viele Indikator-Stimmen ein KAUF braucht. Bei 2 müssen z. B. RSI und MACD gleichzeitig „kaufen" sagen; die Prognose zählt als gewichtete Zusatzstimme (gedeckelt, außer du erlaubst ihr den Alleingang). Niedriger = mehr Trades, aber mehr Fehlsignale — 1 heißt „jede einzelne Stimme kauft sofort".',
  },
  allowShort: {
    t: 'Shorten (Leerverkäufe)',
    d: 'Erlaubt der Engine, auf FALLENDE Kurse zu setzen: Ein Verkaufs-Signal ohne Position eröffnet einen Short (das Depot „leiht" die Stücke und verkauft sie), ein Kauf-Signal deckt ihn wieder ein. Gewinn = Einstand minus Rückkaufkurs. Als Sicherheitsleistung wird der volle Gegenwert vom Cash reserviert und beim Eindecken mit dem Gewinn/Verlust zurückgebucht. Wichtig: Beim Shorten sind Verluste theoretisch unbegrenzt (der Kurs kann beliebig steigen) — deshalb ist das bewusst ein Opt-in; Stop-Loss (über dem Einstand), nachziehender Stop und die 25-%-Notbremse gelten gespiegelt.',
  },
  resetWallet: {
    t: 'Konto zurücksetzen',
    d: 'Löscht Handelshistorie, offene Positionen und alle Kennzahlen und stellt den Kontostand auf dein Startkapital. Wozu das gut ist: Nach einem größeren Strategie-Umbau messen die alten Trades ein System, das es nicht mehr gibt. Sie stehen zu lassen wäre nicht harmlos: Die Kennzahlen laufen über die letzten 500 Trades, und weil die neue Engine bewusst viel seltener handelt, würden die alten Zahlen den Durchschnitt noch monatelang mitziehen — du könntest nie unterscheiden, ob eine Verbesserung von den Filtern kommt oder nur von der Verdünnung. WAS BLEIBT: alle Kursdaten, Kerzen und Indikatoren, die Prognose-Trefferquoten (die messen Vorhersagen, nicht Trades — und sind die Trainingshistorie der Selbstoptimierung), deine Strategien und deine gezeichneten Prognose-Pfeile. WAS GEHT: Trades, Positionen, Equity-Kurve, Kennzahlen, Tuner-Flotte, Schattendepots. Es wird eine Schnittmarke gesetzt, damit später nachvollziehbar bleibt, ab wann gemessen wurde. Nicht rückgängig zu machen.',
  },
  brokerStatus: {
    t: 'Echtgeld-Anbindung',
    d: 'DIE LIVE-REIFE ist die wichtigste Zeile dieser Karte. Sie setzt die Regel um, dass erst umgeschaltet wird, wenn das System nachweislich Gewinn schreibt — und zwar nicht als Merkzettel, sondern als Sperre im Ausführungspfad. Selbst wenn beide Freigaben stehen, bleibt der Handel im eigenen Buch, solange ein Kriterium fehlt. Der Grund für diese Härte: Der Moment, in dem jemand den Schalter gegen die Datenlage umlegen will, ist genau der Moment, in dem er die Datenlage am wenigsten sehen will. FÜNF KRITERIEN: (1) Stichprobe ≥ 40 Trades — kalibriert aufs Tages-Regime (13.08., Owner-Entscheidung: „in ca. zwei Wochen live, wenn alles gut funktioniert"); ein Tages-Trade trägt statistisch mehr als ein 5-Minuten-Trade, und die früheren 200 stammten aus der 5-Minuten-Ära. (2) Profitfaktor ≥ 1,20, nicht 1,00 — Papierhandel unterschätzt die Wirklichkeit systematisch (Teilausführungen, echte Slippage in dünnen Büchern, verpasste Kurse zwischen Signal und Order); wer bei exakt 1,0 umschaltet, schaltet live auf darunter. (3) Gebührenanteil ≤ 50 % des Bruttoergebnisses — darüber trägt das System zwar rechnerisch, aber jede Verschlechterung der Ausführung kippt es sofort. (4) Nettoergebnis über null. (5) Messstrecke ≥ 14 Tage ununterbrochen — Gewinn über drei Tage ist Wetter, nicht Klima; die Strecke zählt ab dem letzten Konto-Reset, denn wer eine schlechte Strecke wegwirft, behält nicht ihre Reife. Die Kriterien 2–4 sind die Bedingung hinter „wenn alles gut funktioniert": Zwei schlechte Wochen öffnen genauso wenig wie vorher. DIE KANTE JE TRADE darunter ist die Zahl, an der alles hängt: Was ein Trade im Mittel einbringt, gegen das, was er kostet. Deckung unter 1 heißt, dass jeder einzelne Trade im Erwartungswert Geld verliert — dann hilft keine bessere Marktphase und kein Glück, sondern nur weniger und bessere Trades. Prüft die Verbindung zum Broker (Alpaca), OHNE eine Order zu senden — wer die Anbindung erst beim ersten Trade testet, testet sie mit Geld. WARUM ALPACA: weil es als einziger Anbieter ein Papierkonto mit derselben Schnittstelle betreibt wie das Echtgeldkonto; nur die Adresse unterscheidet sich. Damit lässt sich die ganze Kette — Schlüssel, Orderformat, Abgleich, Fehlerfälle — an einem echten Konto durchspielen, ohne einen Cent zu riskieren. DREI SCHALTER, ALLE DREI NÖTIG: (1) Schlüssel hinterlegt — nur in der Serverumgebung, nie in der Datenbank, nie im Browser. (2) Strategie auf Echtgeld — der Schalter in deinen Einstellungen. (3) Umgebungs-Freigabe ALPACA_ALLOW_LIVE — ein zweiter Schalter an einem anderen Ort, an den keine Oberfläche herankommt. Fehlt einer, läuft alles weiter im eigenen Buch. Das ist Absicht: Ein verirrter Klick soll kein echtes Geld bewegen können, und ein versehentlich gesetztes Env auch nicht. DER ABGLEICH ist die wichtigste laufende Kontrolle im Echtgeldbetrieb, und er prüft in beide Richtungen: Eine Position, die nur beim Broker liegt, ist ein Risiko, von dem die Engine nichts weiß — sie wird es nie schließen. Eine Position, die nur im eigenen Buch steht, lässt die Engine mit einer Deckung rechnen, die es nicht gibt. Long und Short werden dabei unterschieden, auch wenn die Stückzahl gleich ist. GEGEN DOPPELORDERS: Jede Order trägt eine Kennung aus dem auslösenden Scan. Läuft eine Cloud Function nach einem Fehler erneut an, erkennt der Broker die Kennung wieder und lehnt die Wiederholung ab — statt eine zweite Position aufzumachen, die niemand wollte.',
  },
  taxReport: {
    t: 'Steuer-Export (Deutschland)',
    d: 'Bereitet die Handelshistorie so auf, wie das deutsche Steuerrecht sie sehen will — und zwar getrennt nach Töpfen, weil Gewinne und Verluste hier NICHT frei gegeneinander verrechnet werden dürfen. Wer alles in eine Summe wirft, rechnet sich systematisch zu wenig Steuer aus; das ist der häufigste Fehler in selbstgebauten Auswertungen. DIE VIER TÖPFE: (1) Aktien — Verluste aus Aktienverkäufen dürfen nur gegen Gewinne aus Aktienverkäufen (§ 20 Abs. 6 Satz 4 EStG); ein Aktienverlust rettet keinen ETF-Gewinn. (2) Sonstige — ETFs, Fonds, Anleihen. (3) Termingeschäfte — dazu zählt JEDER Leerverkauf, auch auf Krypto. (4) Privat — Kryptowährungen laufen als privates Veräußerungsgeschäft (§ 23 EStG) unter einem ganz anderen Regime: persönlicher Steuersatz statt Abgeltungsteuer, dafür nach EINEM JAHR Haltedauer komplett steuerfrei. Diese Frist wird taggenau gerechnet, nicht mit 365 Tagen — in Schaltjahren liegt das einen Tag auseinander, und ein Tag entscheidet hier über den vollen Gewinn. FIFO: Bei mehreren Käufen desselben Papiers gilt der älteste Bestand als zuerst verkauft — so schreibt es das Gesetz vor, und der Einstandskurs entscheidet über den Gewinn. Die Rechnung nutzt die volle Historie inklusive der Trades, die ein Konto-Reset ins Archiv verschoben hat: Ein Verkauf im Januar bleibt steuerpflichtig, auch wenn du im März zurückgesetzt hast. FREIGRENZE, nicht Freibetrag: Bleibt der Krypto-Gewinn unter der Grenze, ist er ganz steuerfrei — ein Euro darüber macht den GANZEN Betrag steuerpflichtig. WAS DAS NICHT IST: eine Steuerberatung. Es wird bewusst keine Steuerschuld gerechnet — die hängt von Kirchensteuer, Veranlagungsart, Freistellungsaufträgen bei anderen Banken und Verlustvorträgen ab, die dieses System nicht kennt. Die CSV-Datei ist für deinen Steuerberater gedacht.',
  },
  dailyLossLimit: {
    t: 'Tages-Notbremse',
    d: 'Die Grenze, ab der für heute Schluss ist — gemessen am Eigenkapital vom Vortag, inklusive Buchverlusten. WOZU, WENN ES DOCH STOP-LOSS GIBT: Der Stop-Loss schützt eine POSITION. Er hilft nicht gegen den Fall, der Konten wirklich leert: viele kleine Verluste hintereinander an einem Tag, jeder für sich regelkonform gestoppt. Bei 39 beobachteten Symbolen, einem 5-Minuten-Takt und rund 24 % Trefferquote ist eine Verlustserie kein Ausnahmefall, sondern der Normalfall — sie kostet nur an manchen Tagen mehr. Ein Tages-Limit beantwortet die Frage, die kein einzelner Stop beantworten kann: Wann hört man auf? WARUM BUCHVERLUSTE MITZÄHLEN: Zählte nur, was realisiert ist, löste die Bremse nie aus, solange niemand verkauft — und genau das Verhalten (Verlierer laufen lassen) soll sie bremsen. WAS SIE TUT: Sie sperrt EINSTIEGE, und zwar in beiden Pfaden — Automatik wie Handklick. Eine Bremse, die man mit einem Handel umgehen kann, ist keine. Bestehende Ausstiege (Stop, Ziel, Trailing, Signal) laufen weiter; ein Verkauf bleibt immer möglich, sonst sperrte sie genau den Ausweg, für den sie ausgelöst hat. WIE SIE SICH LÖST: Am nächsten Handelstag von selbst, oder vorher mit einem bewussten Klick. Sie löst sich NICHT, weil der Kurs kurz zurückkommt — sonst hätte sie an genau dem Tag nichts verhindert, an dem sie gebraucht wird. Höchstwert ist 25 %: Darüber ist es keine Notbremse mehr, sondern Dekoration, und der Deckel fängt außerdem den Tippfehler ab (250 statt 2,5 hätte die Bremse still abgeschaltet). 0 = aus.',
  },
  flattenOnBreach: {
    t: 'Bei Notbremse glattstellen',
    d: 'Schließt beim Auslösen der Tages-Notbremse zusätzlich ALLE offenen Positionen. Standard ist AUS, und das ist die wichtigere Einstellung: Zwangsverkauf klingt entschlossen und ist meist falsch. Er realisiert Buchverluste zum schlechtesten Zeitpunkt des Tages und macht aus einer Zwischenkorrektur einen endgültigen Verlust — ausgerechnet an einem Tag, an dem der Markt ohnehin schon gegen dich läuft. Die bestehenden Ausstiege laufen ohnehin weiter; sie sind die richtige Instanz für die Frage, wann eine EINZELNE Position aufgibt, weil sie deren Stop, Ziel und Trailing kennen. Diese Option ist für den Fall gedacht, dass jemand ausdrücklich einen harten Schnitt will — etwa vor einer Reise oder wenn die Strategie gerade umgebaut wird.',
  },
  classWeights: {
    t: 'Kapital je Anlageklasse',
    d: 'Ein Faktor auf die Positionsgröße, getrennt für jede Anlageklasse: 0 = handelt nicht mehr, 1 = normal, 1,5 = größere Stücke. WARUM EIN REGLER UND KEIN SCHALTER: Die gemessenen Klassen-Kanten liegen zwischen −0,41 % und +0,81 % je gehandeltem Dollar — dazwischen liegt alles, und ein Schalter kennt nur zwei Antworten auf eine stufenlose Frage. WAS DIE ZAHL BEDEUTET: „Kante je Dollar" ist nicht der Gewinn, sondern der Gewinn NACH Gebühren geteilt durch das gehandelte Volumen. Sie beantwortet die einzige Frage, die zählt: Trägt diese Klasse ihre eigene Reibung? Ein Beispiel aus echten Zahlen: 290 Krypto-Trades mit −0,19 % je Dollar ergaben −1 132 $ — dieselbe Historie ohne Krypto stand bei +40 $ statt −1 093 $. DER REGLER STEUERT NUR EINSTIEGE. Eine offene Position wird immer geschlossen, auch wenn ihre Klasse inzwischen auf 0 steht; sonst würde ein Regler-Klick Bestände einsperren. GEWICHT 0 STOPPT NICHT DIE MESSUNG: Signale und die Schatten-Kante entstehen weiter, eine abgeschaltete Klasse kann sich also zurückverdienen. Ohne das wäre jedes Abschalten endgültig — wer aufhört zu messen, kann nie feststellen, ob die Entscheidung noch stimmt. GRENZEN: Der Regler multipliziert auf denselben Faktor wie das Überzeugungs-Sizing und ist mit ihm gemeinsam bei 1,5 gedeckelt; die Klumpengrenze bleibt die letzte Instanz. Zwei Faktoren können sich nicht zu einem Hebel aufaddieren.',
  },
  classAutoTune: {
    t: 'Klassen automatisch nachregeln',
    d: 'Lässt den täglichen Lauf die Gewichte selbst verstellen — in Schritten von 0,25 auf den Vorschlag zu, nicht in einem Sprung. STANDARD AN seit dem 09.08.: Vorher musste jeder Vorschlag von Hand übernommen werden, und genau daran scheiterte er — die Messung stand da, es passierte nichts. Wer lieber selbst entscheidet, schaltet hier ab; die Empfehlungen bleiben dann sichtbar. AUCH FREMDE ERFAHRUNG ZÄHLT: Hat dieses Konto in einer Klasse noch keine 30 Trades, greift der Beleg aus dem Gesamtbestand — aber nur ab 50 Trades aus mindestens 3 Konten, und er darf höchstens auf Gewicht 1 verstärken. Drosseln und Abschalten dürfen auf fremde Zahlen hin passieren (ein Fehlalarm kostet nur entgangene Chancen), den Einsatz ERHÖHEN nur eigene. Im Journal steht bei jeder Bewegung, woher der Beleg kam. WARUM SCHRITTE: Eine Messung ist eine Momentaufnahme. Springt das Gewicht bei jeder Auswertung auf den vollen Vorschlag, schwingt es zwischen den Wochen hin und her, und jedes Umschalten kostet Trades, die zur alten Einstellung gehörten. DIE EINE AUSNAHME: Wer strukturell verbrennt (mehr als 0,1 % Verlust je Dollar über mindestens 30 Trades), wird sofort auf 0 gesetzt statt in Etappen — ein Fehlalarm kostet dort nur entgangene Chancen, das Zögern kostet echtes Geld, und der Schatten hält den Rückweg offen. EVIDENZ VOR MEINUNG: Unter 30 Trades rührt die Automatik ein Gewicht nicht an, weder nach oben noch nach unten und auch nicht zurück auf den Standardwert. Eine Klasse mit einem einzigen Trade würde sonst eine Kapitalentscheidung auslösen. DER SCHATTEN darf nur ZURÜCKHOLEN, nie abschalten: Ihm fehlt der Stop, der reale Verluste kappt, also ist eine negative Schatten-Kante kein Beleg für einen negativen Trade-Ertrag — eine positive dagegen ein Grund, es mit halbem Gewicht noch einmal zu versuchen. Jede Änderung landet mit Begründung im Journal; ein Gewicht, das sich von selbst bewegt, muss erklärbar bleiben.',
  },
  loadouts: {
    t: 'Loadouts',
    d: 'Vorgefertigte Grundeinstellungen als Startpunkt — vom ruhigen „Boomer-Depot" bis „YOLO-Vollgas". WAS EIN LOADOUT TUT: Es stellt die Trading-Optionen (Engine-Parameter, Signale, Indikatoren, Hebel) auf einen stimmigen Charakter ein. Watchlist, Kapital, Broker-Anbindung und dein Start/Stop-Schalter bleiben IMMER deine. WAS ES NICHT TUT: Es verspricht keine Rendite — welche Werte tatsächlich Geld verdienen, weiß heute niemand; genau das misst die laufende Schatten-Statistik. Die Beschreibungen dürfen zwinkern, die Risiko-Zeile darunter lügt nie: „YOLO" heißt wirklich 3× Hebel und Shorts, mit allem, was dazugehört (Nachschuss-Risiko, theoretisch unbegrenzte Short-Verluste). KEINE FESSEL: Nach der Übernahme stellst du frei weiter ein, und der tägliche Selbstoptimierer lernt normal weiter — ein Loadout ist ein Startpunkt, kein Abo. VORSCHAU ZUERST: „Ansehen" zeigt Feld für Feld, was sich ändern würde; übernommen wird erst per Klick, und alles läuft durch dieselbe Server-Validierung wie jede Handeingabe. EIGENE LOADOUTS: Du kannst deinen aktuellen (gespeicherten) Stand unter einem Namen sichern und später mit einem Klick zurückholen — praktisch, bevor du etwas Wildes ausprobierst.',
  },
  bestPractice: {
    t: 'Bewährte Einstellungen',
    d: 'Zeigt die Einstellungen des Kontos, dessen ENGINE zuletzt die beste Bilanz erwirtschaftet hat — täglich neu ermittelt, anonymisiert gespeichert. WARUM NUR ENGINE-TRADES ZÄHLEN: Ein Konto kann wegen eines einzigen manuellen Glückstreffers vorne liegen; dann würden Einstellungen geadelt, die mit dem Erfolg nichts zu tun hatten. Gezählt wird deshalb ausschließlich, was die Automatik selbst gehandelt hat. GLÜCKS-SCHUTZ: Gekürt wird erst ab 30 Engine-Trades, 14 Tagen Messzeitraum und positiver Kante nach Gebühren — der Tages-Beste unter wenigen Konten ist sonst überwiegend Varianz, nicht Können. WAS ÜBERNOMMEN WIRD: Engine-Parameter, Signal-Einstellungen, Indikatoren und die Klassen-Regler. NICHT übernommen werden Watchlist, Kapital und dein Start/Stop-Schalter. WARUM KEINE AUTOMATIK: Wenn alle Konten auf den Besten springen, stellen alle dieselben Fragen an den Markt — und das kollektive Lernen, das aus UNTERSCHIEDLICHEN Einstellungen seine Information zieht, hört auf. Deshalb bleibt die Übernahme eine bewusste Entscheidung mit Vorschau der Unterschiede.',
  },
  adviseSettings: {
    t: 'Einstellungen prüfen',
    d: 'Sucht Einstellungen, die GEGENEINANDER arbeiten — unabhängig davon, wie der Markt läuft. Beispiele aus einem echten Konto: Hebel 3× bei ausgeschaltetem nachziehenden Stop (der Hebel verdreifacht den Rücklauf jedes Buchgewinns, und der einzige Mechanismus, der ihn sichern würde, ist aus). Oder „max. 30 Positionen", während der Korrelations-Deckel bei 24 bindet — die Zahl steht da und bewirkt nichts. Oder 10 % je Position mal Hebel 3 = 30 % Eigenkapital in einem einzigen Titel, mehr als das Klumpenrisiko-Limit ohne Hebel je zuließe. WICHTIG: Das ist KEIN Optimierer. Er weiß nicht, welche Werte Rendite bringen — das kann niemand aus einer leeren Handelshistorie. Solche Befunde brauchen keine Statistik, nur Arithmetik, und genau deshalb darf man sie automatisieren. Was sich tatsächlich RECHNET, misst der tägliche Selbstoptimierer, der Varianten im Schatten mitlaufen lässt und nur befördert, was eine statistische Schwelle besteht. „Keine Vorschläge" heißt also „nichts widerspricht sich", nicht „optimal". Es wird nichts automatisch geändert: Erst anzeigen, dann ankreuzen, dann übernehmen — und bei jedem Vorschlag steht der Grund, damit du beim nächsten Mal selbst darauf kommst.',
  },
  riskPerTrade: {
    t: 'Risiko je Trade',
    d: 'Stellt die Positionsgröße von „Anteil am Depot" auf „gleicher Risikobeitrag" um. Bisher bekam jede Position dieselben 10 % des Kapitals — egal ob ruhiger Anleihen-ETF (0,3 % Tagesschwankung) oder wilde Krypto-Wette (5 %). Das sieht nach Streuung aus, ist aber keine: Zwei, drei unruhige Titel bestimmen dann das ganze Depot, der Rest ist Dekoration. Mit diesem Wert dreht sich die Frage um — nicht „wie viel Geld stecke ich hinein", sondern „wie viel darf ich verlieren, wenn der Stop greift". Bei 1 % kostet JEDER ausgestoppte Trade rund 1 % des Depots, egal welches Instrument; die Stückzahl ergibt sich aus dem Stop-Abstand. Ein Titel mit engem Stop bekommt entsprechend mehr Stücke. „Max. Investment je Trade" bleibt als harte Obergrenze bestehen — ein sehr enger Stop ergäbe sonst rechnerisch ein Vielfaches des Depots. 0 = aus (klassische Prozent-Tranche). Standard ist bewusst 0: Der Umbau ist eine Verbesserung, aber eine ungeprüfte — erst die Kostenschwelle wirken lassen, dann zuschalten, sonst weiß man hinterher nicht, was gewirkt hat.',
  },
  engineMode: {
    t: 'Handels-Modus',
    d: 'Welche Maschine dein Wallet handelt. „Konfluenz" (Standard) ist die schnelle Schicht: alle 5 Minuten RSI, MACD, Bollinger und Prognose, mit Stop-Loss und Zielen. „Momentum" ist die ruhige: Einmal pro Woche werden die 8 stärksten handelbaren Märkte der letzten 12 Monate gleichgewichtet gekauft — mehr passiert nicht. Der Unterschied in Zahlen: statt Dutzender Trades am Tag typisch 0 bis 3 Orders in der Woche. Genau das ist der Punkt, denn über 297 echte Trades waren die Gebühren das 2,7-Fache des Brutto-Ergebnisses. Momentum hat als eines der wenigen Verfahren auch NACH seiner Veröffentlichung über Jahrzehnte weiter funktioniert. Zwei Dinge musst du wissen: Es gibt bewusst KEINEN Stop-Loss — die Strategie lebt davon, Rücksetzer auszuhalten, und ein enger Stop würde sie genau dort rauswerfen, wo sie verdient. Und sie hat harte Phasen: Bei Trendwenden verliert Momentum kräftig. Schutz ist allein der Marktfilter — steht der S&P 500 unter seinem 200-Tage-Durchschnitt, wird gar nicht gekauft und das Konto geht in Cash. Der 5-Minuten-Scan lässt ein Momentum-Wallet komplett in Ruhe; die beiden Maschinen würden sich sonst gegenseitig die Positionen wegverkaufen.',
  },
  minEdgeMultiple: {
    t: 'Kostenschwelle',
    d: 'Der wichtigste Filter des Systems — und der, den es am längsten nicht gab. Jeder Trade kostet Gebühren plus Spread, hin und zurück: 0,1 % bei US-Aktien, bis 0,5 % bei Krypto. Ohne diesen Filter wird nach Signal gehandelt und hinterher gezahlt — in der gemessenen Praxis frisst die Reibung dann ein Vielfaches des eigentlichen Ergebnisses. Deshalb prüft die Engine vorher: Bewegt sich dieses Instrument in der Mindest-Haltedauer überhaupt weit genug, um die Kosten zu schlagen? Gerechnet mit der ATR und der Wurzel aus der Haltedauer (über vier Kerzen verdoppelt sich die erwartete Bewegung, sie vervierfacht sich nicht). Steht hier 3, muss die erwartete Bewegung dreimal so groß sein wie die Kosten — der Trade muss also auch dann tragen, wenn zwei von drei Versuchen danebengehen. Höher = weniger, aber lohnendere Trades. 0 schaltet den Filter ab (nicht empfohlen).',
  },
  newsVeto: {
    t: 'News-Veto',
    d: 'Sperrt NEUE Einstiege in ein Symbol für einige Stunden, wenn dazu gerade ein hartes Ereignis in den Schlagzeilen steht: Quartalszahlen, Gewinnwarnung, Klage/Ermittlung, Übernahme oder Führungswechsel. Der Grund ist mechanisch: Um solche Termine SPRINGEN Kurse, statt zu laufen — und RSI, MACD und Bollinger, auf denen der Einstieg beruht, sagen über Sprünge nichts. Ein Stop-Loss schützt davor auch nicht, denn bei einer Kurslücke wird zum nächsten Kurs verkauft, nicht zum Stop-Kurs. Das Veto kann Trades nur VERHINDERN, nie auslösen — es senkt also höchstens Gebühren. Ausstiege bleiben immer frei: Eine offene Position wird nie festgehalten, weil Schlagzeilen laufen. Die Quellen sind kostenlose Nachrichten-Feeds (Yahoo Finance, Google News), bewertet von einer Wortliste — keine KI, keine Kosten. Gewöhnliche Berichterstattung („Was Analysten erwarten …") löst das Veto nicht aus; es braucht ein datiertes Ereignis mit deutlicher Wortwahl. Fällt der Feed aus, wird normal gehandelt — das Veto schaltet sich ab, nie die Engine.',
  },
  kiNachrichten: {
    t: 'KI-Nachrichten',
    d: 'Ein Sprachmodell liest frische Kurzmeldungen zu den Symbolen deiner Beobachtungsliste und deines Depots (aus dem Nachrichtenstrom von Alpaca, meist Benzinga; höchstens 45 Minuten alt) und schätzt ein: gut oder schlecht für den Wert, wie stark, schon im Kurs enthalten? Jede klare Einschätzung prüft ein zweiter, unabhängiger Durchgang gegen. Nur gegengeprüfte Einschätzungen wirken. Eine gute Nachricht zählt bei Einstiegen so viel wie die nötigen Anzeichen zusammen — sie kann einen Kauf also allein auslösen, dann aber nur in halber Größe (Probegröße) und ohne geliehenes Geld; Kostenhürde, Markt-Ampel und alle anderen Prüfungen gelten weiter. Sie hebt außerdem eine pauschale Nachrichtensperre auf, wenn es um dasselbe Ereignis geht. Eine schlechte Nachricht sperrt neue Käufe des Werts, zieht bei gehaltenen Positionen die Verlustgrenze enger oder löst — nur wenn die Nachricht nachweislich noch nicht im Kurs steckt — den Verkauf aus. Bei Wetten auf fallende Kurse gilt alles spiegelbildlich. Wie viel die KI-Stimme zählt, wird laufend an echten Kursverläufen gemessen; die Messung darf sie nur abschwächen. Kosten: 2 $ je Konto und Tag in einen gemeinsamen Topf; ist er leer, stimmt eine Wortliste mit halbem Gewicht weiter. Ausstiege und Stops werden nie blockiert oder gelockert. Aus = dieses Konto zahlt nichts ein und bekommt keine KI-Stimme; die Sperre durch die Wortliste bleibt.',
  },
  engineWhy: {
    t: 'Was die Engine gerade tut',
    d: 'Diese Karte zeigt in Alltagssprache, was beim letzten Durchlauf passiert ist (die Engine prüft die Märkte alle 5 Minuten). Warum es sie gibt: Fünf Prüfungen entscheiden mit, ob ein Trade zustande kommt — Markt-Ampel, ein selbstlernender Filter für Trade-Arten, die nachweislich verlieren, News-Veto, Kostenschwelle und Hebel-Ampel. Alle arbeiten unsichtbar, und „es passiert nichts" sieht bei einer greifenden Regel genauso aus wie bei einem Defekt. Deshalb steht hier, WAS geprüft und warum abgelehnt wurde — etwa „6 Leerverkäufe abgelehnt, der Markt steigt". Oben die Lage: Zustand des Gesamtmarkts mit VIX (dem „Angstbarometer" der Börse) und der tatsächlichen Schwankung, ein anstehender wichtiger Wirtschaftstermin, die Monatswende und wie viele Trades der letzte Durchlauf ausgelöst hat. In der Mitte die Ablehnungsgründe — nur die, die wirklich gegriffen haben. Unten: wie viele Konten aktiv handeln, wie viele einen ruhigen Sockel (Langfrist-Teil) führen und bei welchen Werten gerade viele Wetten auf fallende Kurse unter Druck stehen („Squeeze-Setup": viele Wetten auf fallende Kurse, während der Kurs steigt — das kann heftige Sprünge nach oben auslösen). Alle Zahlen stammen direkt aus dem Durchlauf: Was hier steht, hat die Engine wirklich getan.',
  },
  hebelAmpel: {
    t: 'Hebel-Ampel',
    d: 'Wann das Tool mit geliehenem Geld groß einsteigen darf. Bisher hing das allein an der Konfluenz — also daran, wie viele Indikatoren gerade einer Meinung sind. Das misst aber nicht, ob diese Meinung je Geld verdient hat — auch verlierende Trade-Sorten können einige Indikatoren einig haben, und ein Hebel darauf vervielfacht den Verlust statt der Rendite. Deshalb gilt jetzt die Reihenfolge „erst Kante, dann Hebel". Fünf Bedingungen müssen GLEICHZEITIG zutreffen, und zwar bewusst aus fünf verschiedenen Quellen — fünf Bedingungen, die alle aus dem Preis stammen, wären eine Bedingung in fünf Verkleidungen: (1) die Indikatoren sind deutlich einig, nicht knapp; (2) der Gesamtmarkt steht im ruhigen Aufwärtstrend; (3) genau diese Trade-Sorte hat in der EIGENEN Handelshistorie über mindestens 30 Trades nachweislich Geld verdient (statistisch abgesichert, kein Backtest); (4) die Positionierung an der Terminbörse steht nicht dagegen — in einen überfüllten Markt hinein wird nicht gehebelt; (5) die erwartete Bewegung ist mindestens fünfmal so groß wie die Handelskosten, weil der Hebel auch die Gebühren vervielfacht. Trifft nur eine Bedingung nicht zu, wird bar gedeckt gehandelt wie immer. Das passiert selten — genau so ist es gemeint: groß einsteigen nur, wenn die Gelegenheit sicher UND günstig ist. Margin-Call bei 25 % und die Klumpengrenze gelten unverändert weiter.',
  },
  regimeGate: {
    t: 'Markt-Ampel',
    d: 'Sperrt Einstiege, die gegen den gemessenen Marktzustand laufen. Der Zustand kommt aus drei kostenlosen Größen: Lage des S&P 500 zu seinem 200-Tage-Durchschnitt, tatsächliche Schwankung der letzten 20 Tage und VIX-Stand. Daraus folgen drei Regeln: Im AUFWÄRTSTREND keine Leerverkäufe — man wettet nicht gegen den Markt, in dem man steckt. Bei STRESS (VIX ab 30 oder sehr hohe Schwankung) gar keine neuen Einstiege, weil Kurse dann in Sprüngen laufen und ein Stop nicht zum Stop-Kurs ausgeführt wird, sondern zum nächsten. SEITWÄRTS ist alles erlaubt — ohne Trend gibt es keine Trendrichtung, gegen die man verstoßen könnte. Der Anlass war eine Messung in der eigenen Handelshistorie: Leerverkäufe im Aufwärtstrend verloren über alle Indikator-Sorten hinweg — der gemeinsame Nenner war die Richtung, deshalb sperrt die Regel die Richtung. Wie das News-Veto kann sie Trades nur verhindern, nie auslösen: Bestehende Positionen bleiben unberührt, Ausstiege immer frei. Fehlen die Marktdaten, gilt „seitwärts" und es wird nichts gesperrt — ein Datenausfall darf kein stilles Handelsverbot werden. Bei NEUTRALER Ampel (seitwärts) bremst die Engine zusätzlich: Kauf-Pause mindestens doppelt so lang (mindestens 30 Minuten) und halbe Positionsgröße — Seitwärtsmärkte produzieren Fehlsignale. Die Kante je Regime (Anzahl und Trefferquote, unter der Bremse gemessen) steht als Tooltip am Ampel-Chip im Betriebszustand.',
  },
  corePct: {
    t: 'Ruhiger Sockel %',
    d: 'Der Anteil deines Kapitals, der NICHT aktiv gehandelt wird, sondern in einem ruhigen Momentum-Depot liegt: die stärksten Werte des ganzen Katalogs, gleichgewichtet, höchstens einmal im Monat umgeschichtet — und nur, solange der Gesamtmarkt über seinem 200-Tage-Schnitt steht; darunter geht der Sockel in Cash. Der Grund ist eine Messung, keine Meinung: In der eigenen Historie schlug das ruhige Momentum-Depot die aktiv gehandelten Konten deutlich — und zwar nicht, weil deren Signale schlechter rieten, sondern weil die Gebühren das Brutto-Ergebnis auffraßen. Weil Gebühren prozentual anfallen, hilft dagegen keine größere Position, sondern nur: seltener handeln und größere Bewegungen mitnehmen. Genau das ist der Sockel. Was er bindet, fehlt der aktiven Engine als Cash — sie wird also automatisch kleiner und bleibt die Suchmaschine für die seltenen guten Gelegenheiten. Sockel-Positionen sind für den 5-Minuten-Scan unsichtbar: kein Signal-Verkauf, kein Stop, kein Trailing. Sie leben von Ruhe. 0 % schaltet den Sockel ab, mehr als 90 % gibt es nicht — ein Rest muss für Gebühren und manuelle Trades bleiben.',
  },
  maxOpenPositions: {
    t: 'Max. gleichzeitige Positionen',
    d: 'Wie viele Positionen höchstens gleichzeitig offen sein dürfen. Ist das Limit erreicht, ignoriert die Engine jedes weitere Kaufsignal — bis eine Position schließt. Zusammen mit „Investment je Trade %" bestimmt das, wie voll das Depot maximal wird: 10 Positionen à 10 % sind voll investiert, 10 à 5 % lassen die Hälfte in Cash. Mehr Positionen streuen das Risiko, machen aber jede einzelne unbedeutender — und jede offene Position kostet bei jedem Scan Abfragen. Die Obergrenze liegt bei 30.',
  },
  leverage: {
    t: 'Hebel (Margin)',
    d: 'Handeln mit geliehenem Geld: Bei 2× darf das Depot doppelt so viel bewegen, wie es an Eigenkapital hat. Der Hebel verstärkt BEIDE Richtungen gleich stark — aus 10 % Kursgewinn werden 20 % Kontogewinn, aus 10 % Verlust ebenfalls 20 %. Drei Dinge gehören dazu und sind alle eingebaut: (1) Der Hebel greift NUR bei sehr überzeugenden Signalen — zwei Stimmen über deiner Einstiegsschwelle und mindestens 3 insgesamt (sonst würde eine lockerere Einstiegsschwelle den Hebel leichter machen, also genau verkehrt herum); alles darunter handelt weiter bar gedeckt. (2) Fällt das Eigenkapital unter 25 % des Positionswerts, werden Positionen zwangsweise geschlossen (Margin-Call, geprüft im Minutentakt) — genau wie bei einem echten Broker. (3) Auf das geliehene Geld laufen 8 % Jahreszins, täglich gebucht. Ohne (2) und (3) sähe jede Auswertung mit Hebel besser aus, als sie ist. Standard ist 1× (aus). Manuelle Trades bleiben immer bar gedeckt — der Hebel hängt an der Überzeugungsstärke des Algorithmus, und die hat ein Klick von dir nicht.',
  },
  sizingBase: {
    t: 'Sizing-Basis',
    d: 'Woraus die Positionsgröße gerechnet wird. „Verfügbarer Cash" (Standard): Jeder Kauf nimmt seinen Prozentsatz vom aktuell freien Cash — das Wallet arbeitet weiter, auch wenn schon Positionen offen sind, die Tranchen werden mit sinkendem Cash automatisch kleiner. „Startkapital (fix)": Jede Tranche ist gleich groß (Prozent vom Startkapital) — kalkulierbarer, aber sobald der Rest-Cash eine volle Tranche nicht mehr deckt, kauft die Engine gar nichts mehr. Genau das ließ vorher viel Cash ungenutzt liegen.',
  },
  stopLoss: {
    t: 'Stop-Loss',
    d: 'Automatische Verkaufs-Reißleine: Fällt der Kurs um diesen Prozentsatz unter den Einstieg, verkauft die Engine sofort — Verluste werden begrenzt, bevor sie groß werden. Zu eng gesetzt wirft dich normales Marktrauschen aus der Position („ausgestoppt").',
  },
  takeProfit: {
    t: 'Take-Profit',
    d: 'Das Gewinnziel: Steigt der Kurs um diesen Prozentsatz über den Einstieg, wird automatisch verkauft und der Gewinn realisiert. Sichert Buchgewinne, deckelt aber auch die Aufwärtschance.',
  },
  watchlist: {
    t: 'Beobachtet',
    d: 'Beobachtet wird in ZWEI Tiefen. Flach: Jeder der 166 Katalog-Märkte, dessen Börse gerade offen ist, bekommt alle fünf Minuten einen frischen Kurs — nichts läuft mehr unbemerkt weg. Möglich wurde das durch einen Sammel-Abruf, der 20 Symbole pro Anfrage holt: 9 Anfragen für den ganzen Katalog statt 166. Vorher rotierte die Versorgung in 15er-Häppchen durch, ein Symbol konnte also eine Stunde alt sein. Tief: Die Symbole in der Liste hier bekommen zusätzlich 5-Minuten-Kerzen, RSI, MACD, Bollinger, Prognose — und nur sie werden gehandelt. Sie wählt der tägliche Ranglisten-Lauf über den vollen Katalog, plus jede offene Position (die muss drin bleiben, bis sie geschlossen ist, sonst verlöre sie ihren Stop-Loss). Warum nicht alles tief? Ein Kurs ist ein Zahlenwert, eine Tiefenanalyse sind Kerzenreihen und Indikatorrechnungen pro Symbol und Intervall — die flache Stufe kostet fast nichts, die tiefe skaliert direkt mit.',
  },
  // ── Prognose ──
  fclab: {
    t: 'Prognose-Labor',
    d: 'Hier prüft sich die Prognose selbst: Jede gespeicherte Vorhersage wird nach Ablauf ihres Zeitraums mit dem tatsächlich eingetretenen Kurs verglichen. Die Trefferquote je Rückblick-Länge (wie viel Kursvergangenheit die Prognose auswertet) entscheidet, welche Länge künftige Prognosen nutzen — und ob die Prognose beim Handeln überhaupt mitstimmen darf: Ohne nachgewiesene Trefferquote stimmt sie GAR NICHT mit, sie muss sich ihr Gewicht erst verdienen. Die Karte zeigt diese Buchführung: die Trefferquoten für Tages- und Kurzfrist-Prognosen sowie „Vorhersage vs. Realität" für den gewählten Wert.',
  },
  fcCombo: {
    t: 'Treffer je Rückblick-Länge',
    d: 'Jede Prognose wird nebenher mit mehreren Rückblick-Längen berechnet — also mit unterschiedlich viel Kursvergangenheit („Lookback") — und nach Ablauf mit dem echten Kursverlauf verglichen. Die Länge mit der besten Trefferquote (bei Gleichstand: kleinster Ø-Fehler) wird für die aktuelle Prognose genutzt — so verbessert sich das System selbst. Wichtig: Solange keine Trefferquote nachgewiesen ist, stimmt die Prognose beim Handeln GAR NICHT mit; sie muss sich ihr Gewicht erst verdienen.',
  },
  mae: {
    t: 'MAE — durchschnittlicher Fehler',
    d: 'Wie weit Prognose und tatsächlicher Kurs im Schnitt auseinanderlagen, in Prozent des Kurses — egal, ob zu hoch oder zu niedrig geschätzt. Je kleiner, desto genauer die Vorhersage. Der Wert bestimmt auch, wie breit das Unsicherheitsband um die Prognose gezeichnet wird.',
  },
  anEquity: {
    t: 'Kontoverlauf (realisiert)',
    d: 'Die Summe aller ABGESCHLOSSENEN Trades, Schritt für Schritt. Bewusst etwas anderes als die Depotwert-Kurve: Die zeigt einen Wert pro Tag, einschließlich der Buchgewinne offener Positionen. Diese Linie springt bei jedem abgeschlossenen Trade und zeigt nur, was tatsächlich eingenommen wurde — ein Buchgewinn einer noch offenen Position ist eine Meinung, kein Ergebnis. Die gestrichelte Linie ist der Startpunkt: Alles darüber ist verdient, alles darunter verloren.',
  },
  anHisto: {
    t: 'Verteilung der Ergebnisse',
    d: 'Wie viele Trades in welchem Gewinn- oder Verlustbereich gelandet sind. Die wichtigste Frage, die nur dieses Diagramm beantwortet: Sind die Verluste größer als die Gewinne? Eine Strategie, die in 60 % der Fälle gewinnt, ruiniert dich trotzdem, wenn die wenigen Verlierer dreimal so schwer wiegen wie die vielen Gewinner — an der Trefferquote allein sieht man das nie. Die Balken liegen symmetrisch um die Null, damit Gewinn und Verlust nie im selben Balken landen.',
  },
  anStunde: {
    t: 'Ergebnis nach Handelsstunde',
    d: 'Zu welcher Tageszeit die Strategie verdient oder verliert — in New Yorker Börsenzeit (ET), nicht in Weltzeit (UTC); sonst würde die Zeitumstellung die Eröffnungsstunde zweimal im Jahr in ein anderes Fach schieben. Typisches Muster: In der ersten Handelsstunde schwanken die Kurse am stärksten, und für viele Strategien ist sie die teuerste. Häuft sich dein Minus in einem bestimmten Zeitfenster, helfen keine neuen Indikatoren, sondern eine Handelspause zu dieser Zeit.',
  },
  kollektiv: {
    t: 'Aus allen Konten gelernt',
    d: 'Welche Einstellungs-Änderungen sich ÜBER ALLE Konten hinweg bewährt haben. Dieses Wissen macht zwei Dinge — und zwei ausdrücklich nicht. Erstens bestimmt es die Reihenfolge: Es gibt mehr mögliche Varianten als Plätze für deine Probekonten, und die anderswo bewährten kommen zuerst dran — so landest du schneller bei einer guten Einstellung. Zweitens startet ein neues Konto mit diesen Werten statt mit den Werkseinstellungen. Was es NICHT tut: die Anforderungen an den Nachweis in deinem Konto senken. Jede Übernahme in DEINEM Konto braucht weiterhin den vollen statistischen Beleg aus deinen eigenen Trades — denn jedes Konto startet mit anderen Einstellungen, und was dort half, kann hier schaden. Und es fließen nur Zählwerte ein (wie oft geprüft, wie oft übernommen), niemals einzelne Trades oder Beträge anderer Nutzer.',
  },
  kurzfrist: {
    t: 'Kurzfrist-Prognose',
    d: 'Eine Vorhersage für die nächste Stunde auf Basis von 5-Minuten-Kerzen — bei jedem Durchlauf neu berechnet. Sie lernt getrennt von der Tages-Prognose: Jede Stunde wird sie mit den tatsächlich eingetretenen Kursen verglichen.',
  },
  'node:compare': {
    t: 'Regel: Vergleich (compare)',
    d: 'Vergleicht einen Indikatorwert (RSI, MACD-Linie, %B …) mit einer Zahl oder einem anderen Wert — z. B. „RSI < 30". Der Grundbaustein jeder Strategie.',
  },
  'node:crossover': {
    t: 'Regel: Kreuzung (crossover)',
    d: 'Feuert genau in dem Moment, in dem eine Linie eine andere kreuzt (z. B. MACD-Linie über Signal-Linie = „Golden Cross"-Logik). Klassisches Momentum-Einstiegssignal.',
  },
  'node:priceLevel': {
    t: 'Regel: Kurs-Marke (priceLevel)',
    d: 'Zutreffend, wenn der Kurs über/unter einer festen Marke steht — für Unterstützungen, Widerstände oder psychologische Marken (z. B. „unter 100 $ kaufen").',
  },
  'node:changePct': {
    t: 'Regel: Veränderung % (changePct)',
    d: 'Misst die prozentuale Kursänderung über die letzten N Kerzen — z. B. „mehr als 3 % in 5 Tagen gefallen". Gut für Dip-Käufe oder Momentum-Filter.',
  },
  'node:timeWindow': {
    t: 'Regel: Zeitfenster (timeWindow)',
    d: 'Beschränkt das Signal auf eine Tageszeit (ET) — z. B. nicht in der volatilen ersten Handelsstunde kaufen. Trifft nur zu, wenn die Scan-Zeit im Fenster liegt.',
  },
  'node:forecast': {
    t: 'Regel: Prognose',
    d: 'Die Richtungsstimme der Zukunfts-Prognose: zutreffend, wenn die vorhergesagte Änderung bis zum Horizont-Ende über der Schwelle liegt (up) bzw. darunter (down). Im Backtest wird die Prognose kausal je Handelstag nachgerechnet.',
  },
  'node:position': {
    t: 'Regel: Positions-Zustand',
    d: 'Fragt den eigenen Depot-Zustand ab: „state open" mit min/max % unrealisiertem Gewinn baut Exits wie „verkaufe ab +5 %" — die Regel-Variante von Take-Profit/Stop-Loss.',
  },
  // ── Kennzahlen ──
  sharpe: {
    t: 'Sharpe-Ratio (Ertrag je Risiko)',
    d: 'Wie viel Ertrag du pro Einheit Risiko bekommst: der durchschnittliche Tagesertrag geteilt durch seine Schwankung, hochgerechnet aufs Jahr (×√252 — ein Börsenjahr hat etwa 252 Handelstage). Über 1 gilt als gut, über 2 als sehr gut. Ein hoher Ertrag mit wilden Ausschlägen kann deshalb SCHLECHTER abschneiden als ein ruhiger, mäßiger. „30" und „90" stehen für die letzten 30 bzw. 90 gespeicherten Tagesstände. „--" heißt: noch zu wenig Daten oder eine völlig flache Linie — bewusst keine geschönte 0.',
  },
  maxdd: {
    t: 'Max-Einbruch',
    d: 'Der tiefste Absturz von einem zwischenzeitlichen Höchststand, in Prozent — „wie weh tat es im schlimmsten Moment?". Die wichtigste Zahl fürs Durchhalten, denn Verluste holt man schwerer auf, als man sie macht: Nach −30 % braucht es +43 %, nur um wieder auf dem alten Stand zu sein, nach −40 % schon +67 %. Kleiner ist besser, auch wenn der Ertrag dafür etwas niedriger ausfällt.',
  },
  drawdown: {
    t: 'Rückgang vom Höchststand',
    d: 'Für jeden Tag: wie weit dein Konto unter seinem bis dahin höchsten Stand lag, in Prozent. 0 heißt: neuer Höchststand; jeder Ausschlag nach unten ist ein laufender Rückgang. Diese Grafik teilt sich die Zeitachse mit der Depotwert-Kurve darüber — ein Tal in der Kurve und sein Rückgang stehen genau untereinander. So siehst du auf einen Blick, ob Verluste kurze Dellen oder lange Durststrecken waren und wie lange es dauerte, bis der alte Höchststand wieder erreicht war. Die Kennzahl „Max-Einbruch" in der Tabelle rechnet der Server aus denselben Daten.',
  },
  // ── Trade-Ticket ──
  fees: {
    t: 'Gebühren und Preisabweichung',
    d: '0,1 % Ordergebühr plus 5 Basispunkte (0,05 %) Slippage — der Unterschied zwischen angezeigtem und tatsächlich bezahltem Kurs. Wird hier nicht nur angezeigt, sondern vom Paper-Broker (dem Übungs-Broker mit Spielgeld) WIRKLICH abgezogen — zu denselben Bedingungen wie im Backtest (dem Test auf alten Kursen).',
  },
  // ── Portfolio-Kennzahlen (M12) ──
  gesamtPnl: {
    t: 'Gesamt P&L (Gewinn/Verlust) — was die Zahl misst',
    d: 'P&L heißt Gewinn und Verlust. Gesamt P&L = Equity (live) − Kapitalbasis, also aktueller Kontowert minus Ausgangsbasis. Die Basis wird bei einer Depot-Übernahme oder einem Reset NEU gesetzt — die Zahl zählt dann erst ab diesem Tag. Sie besteht aus „Realisiert" (seitdem geschlossene Trades) und „Offen" (Buchgewinn oder -verlust der noch offenen Positionen; er wird erst beim Schließen zum echten Ergebnis). Die Handels-Analyse beantwortet eine ANDERE Frage: Was haben die geschlossenen Trades im gewählten Zeitraum gebracht — auch die vor dem Neubeginn. Deshalb können beide Zahlen gleichzeitig stimmen und doch gegensätzlich aussehen: alte Abschlüsse im Minus, offene Positionen gerade im Plus. Die verlässlichste Einzelzahl bleibt „Equity (live)" — der Kontostand, wie ihn auch der Broker zeigt.',
  },
  equityCurve: {
    t: 'Depotwert',
    d: 'Der Verlauf deines GESAMTEN Depotwerts: Bargeld plus alle offenen Positionen zum jeweiligen Tageskurs. Einmal täglich nach Börsenschluss in den USA wird ein Punkt festgehalten — anders als die Live-Anzeige kann die Kurve deshalb nicht durch zufällige Zwischenstände geschönt werden. Sie ist die ehrlichste Grafik über eine Strategie: Nicht einzelne Gewinner zählen, sondern ob die Linie über Wochen steigt.',
  },
  hwm: {
    t: 'Bestwert (Hochwasser-Marke)',
    d: 'Der höchste Depotwert, den dein Konto je erreicht hat. Er ist der Bezugspunkt für den Rückgang vom Höchststand: Alles darunter ist noch nicht wieder aufgeholt. Der Wert steigt nur, wenn ein neuer Rekord erreicht wird.',
  },
  profitFactor: {
    t: 'Profit-Faktor',
    d: 'Alle Gewinne zusammen geteilt durch alle Verluste zusammen, über die abgeschlossenen Trades. Über 1 heißt: Unterm Strich verdienst du Geld; 1,5 gilt als solide, unter 1 verliert die Strategie. Praktisch an dieser Zahl: Sie funktioniert unabhängig davon, wie oft du triffst — wenige große Gewinner können viele kleine Verluste tragen. „--" erscheint, solange es noch keinen einzigen Verlust-Trade gibt (dann wäre der Wert unendlich, und das sagt nichts).',
  },
  expectancy: {
    t: 'Durchschnitt je Trade',
    d: 'Was ein abgeschlossener Trade im Schnitt gebracht hat (Gesamtergebnis geteilt durch die Zahl der Trades). Die Zahl fasst die Strategie in einem Satz zusammen: „Jeder Trade bringt im Mittel X $." Ist sie negativ, verliert häufigeres Handeln nur schneller Geld — mehr Trades lohnen sich nur, wenn dieser Durchschnitt im Plus liegt.',
  },
  exits: {
    t: 'Warum geschlossen',
    d: 'Wodurch die Positionen tatsächlich beendet wurden: durch eine feste Marke (Stop-Loss = Verlustgrenze, Take-Profit = Gewinnziel, Trailing-Stop = mitwandernde Verlustgrenze) oder durch ein SIGNAL — also weil die Indikatoren umgeschwenkt sind. Die Verteilung sagt mehr als jede Einzelzahl: Steht fast alles unter „Signal", werden Verlustgrenze und Gewinnziel praktisch nie erreicht. Dann entscheidet nicht deine Risiko-Einstellung über das Ergebnis, sondern das Umkippen einer einzelnen Indikator-Stimme — ein Zeichen dafür, dass die Positionen zu früh wieder geschlossen werden.',
  },
  quellen: {
    t: 'Ergebnis je Einstiegsweg',
    d: 'Welcher Weg hat die Position eröffnet — und verdient er Geld? Jede geschlossene Position zählt zu ihrem Einstieg: Konfluenz (mehrere Indikatoren einig), Regelbaum (Wenn-dann-Regeln), Momentum, Sockel (ruhiger Langfrist-Teil), KI-Probe oder Hand. „Nachgebucht" und „Unbekannt" sind keine Wege, sondern Lücken: vom Broker-Abgleich nachgetragene Positionen oder ältere Bestände ohne Herkunft. „Netto/$" ist das Ergebnis je gehandeltem Dollar in Prozent, nach Gebühren — trägt der Weg seine Kosten? Danach färbt sich die Zeile. Je Anlageklasse oben die Summe (schlechteste Klasse zuerst), darunter die Wege nach diesem Wert sortiert. Steht „--", fehlt älteren Trades der Gebührensatz: Der Wert fehlt dann, das Ergebnis daneben stimmt trotzdem. Die Tabelle zeigt nur dein eigenes Konto; die öffentliche Übersicht nennt Wert und Gebühren je Weg erst, wenn genug Konten ihn gehandelt haben.',
  },
  fillReibung: {
    t: 'Preisabweichung bei Ausführung',
    d: 'Der gemessene Unterschied zwischen dem Kurs, bei dem die Engine entschieden hat, und dem Kurs, zu dem der Broker wirklich gekauft oder verkauft hat — in Basispunkten (1 bp = 0,01 %), getrennt nach Einstieg und Ausstieg. Davon hängt ab, ob Aktienkäufe besser als Limit-Order laufen sollten (Order mit festem Preis statt „zum nächsten Kurs"): Unter 5 bp lohnt der Umbau nicht, ab 10 bp ist er fällig. Die Farbe beim Einstieg für US-Aktien zeigt genau diese Regel.',
  },
  kapitalEinsatz: {
    t: 'Kapitaleinsatz',
    d: 'Wie viel deines Depots tatsächlich arbeitet — und in welchem Teil. „Investiert" ist der Wert aller Positionen im Verhältnis zum gesamten Kontowert, aufgeteilt in den ruhigen Momentum-Sockel (Langfrist-Teil) und den aktiven Teil, den die Engine handelt; der Rest ist Bargeld. Ziel ist NICHT null Bargeld: Zeigt der Marktfilter einen fallenden Markt, wechselt der Sockel absichtlich in Bargeld — das ist Schutz, kein Leerlauf. Bleibt dagegen in einem steigenden Markt dauerhaft viel Bargeld liegen, arbeitet das Geld nicht; deshalb kauft der wöchentliche Lauf gehaltene Positionen bis zu ihrem Zielanteil nach.',
  },
  kosten: {
    t: 'Handelskosten',
    d: 'Jeder vollständige Trade kostet zweimal: Beim Kauf UND beim Verkauf fallen eine Gebühr (Kommission) und Slippage an — Slippage ist der kleine Unterschied zwischen angezeigtem und tatsächlich bezahltem Kurs. Entscheidend ist „Gewinn ÷ Kosten": die durchschnittliche Gewinnbewegung vor Gebühren, geteilt durch diese Kosten. Unter 2 verdient vor allem der Broker, denn dann geht über die Hälfte jeder Gewinnbewegung für Kosten drauf. Kurze Zeitrahmen erzeugen kleine Kursbewegungen — wer öfter handelt, braucht deshalb zwingend auch genug Bewegung je Trade, sonst verliert er nur schneller. „Ø Gewinn brutto" und „Ø Verlust brutto" zeigen die reinen Kursbewegungen ohne Gebühren — so wird sichtbar, ob die Strategie an sich funktioniert.',
  },
  momentum: {
    t: 'Momentum-Ranking',
    d: 'Statt einer festen Beobachtungsliste wird der ganze Katalog nach einer einzigen Zahl sortiert: dem Kursgewinn der letzten zwölf Monate, wobei der jüngste Monat NICHT mitzählt. Der Grund: Über einen Monat drehen Kurse eher wieder um; der eigentliche Schwung (Momentum) steckt in den Monaten davor — wer den letzten Monat mitzählt, vermischt zwei gegenläufige Effekte. Gekauft werden die acht stärksten Werte zu gleichen Teilen — und nur, wenn der Gesamtmarkt (Leitindex) über seinem Durchschnitt der letzten 200 Tage steht. Liegt er darunter, bleibt das Depot komplett leer: Solche Strategien brechen fast nur in Erholungsphasen NACH Börsenabstürzen ein, und dieser Filter ist die billigste bekannte Versicherung dagegen. Umgeschichtet wird wöchentlich, nicht täglich — jede Umschichtung kostet Gebühren, und genau daran ist die alte Strategie gescheitert. Der Ansatz ist die am besten belegte Auffälligkeit der Finanzforschung (Jegadeesh/Titman 1993; Asness/Moskowitz/Pedersen 2013 über acht Anlageklassen). Die Rangliste und ihr Vergleichsdepot in dieser Karte laufen ohne echtes Geld; als ruhiger Sockel (Anteil je Konto einstellbar) handelt dieselbe Regel aber mit echtem Kapital.',
  },
  autotuner: {
    t: 'Auto-Tuner',
    d: 'Das System testet deine Einstellung ständig gegen leicht veränderte Varianten — jede Variante ändert genau EINEN Wert (z. B. die Mindest-Haltedauer) und handelt in einem eigenen Probekonto auf denselben Kursen, ohne echtes Geld. Nach genug abgeschlossenen Trades wird verglichen: Nur wenn eine Variante statistisch nachweislich besser abschneidet (ein so deutlicher Unterschied entstünde durch reinen Zufall in weniger als 5 von 100 Fällen) und spürbar vorn liegt, wird sie übernommen. Höchstens eine Änderung pro Tag, damit hinterher klar ist, was geholfen hat. Warum Probekonten statt eines Tests auf alten Kursen: Wer viele Einstellungen an der Vergangenheit ausprobiert, findet zuverlässig die, die zufällige Ausschläge von damals am besten erklärt — und die versagt danach. Die Probekonten handeln dagegen auf Kursen, die zum Zeitpunkt der Entscheidung noch niemand kannte. Positionsgröße, Stop-Loss und Take-Profit rührt der Tuner NIE an — die Risikosteuerung bleibt bei dir.',
  },
  tradejournal: {
    t: 'Trade-Journal',
    d: 'Jeder gebuchte Trade — von der Engine oder von Hand — bekommt automatisch einen Journal-Eintrag mit einer eingefrorenen Momentaufnahme des Signals: welche Indikatoren wie gestimmt haben, wie viele sich einig waren (Konfluenz), wie die Markt-Ampel stand und ob die Prognose mitgestimmt hat. Eingefroren, weil dieselben Indikatoren fünf Minuten später schon anders stehen — aus der Trade-Liste allein lässt sich das WARUM nicht mehr nachvollziehen. Deine Aufgabe ist die Bewertung: Note A (regelkonform und sauber) bis D (Fehler erkannt) plus Notiz. Die Fakten selbst kannst du nicht ändern — ein Journal, dessen Zahlen sich nachträglich schönen lassen, wäre zum Lernen wertlos. Der Nutzen entsteht beim Wiederlesen: Verlierer mit Note A sind Pech, Verlierer mit Note D sind ein Muster.',
  },
  struktursuche: {
    t: 'Struktursuche',
    d: 'Der Auto-Tuner dreht an den REGLERN deiner Strategie (z. B. Haltedauer) — die Struktursuche ändert den BAUPLAN, also die Wenn-dann-Regeln selbst (den „Regelbaum"): einen Baustein pro Tag (einen Vergleich umkehren, einen Zweig streichen, eine Bedingung ergänzen). Jeder Kandidat wird zweistufig geprüft: Er muss die aktuell gültigen Regeln im Suchzeitraum schlagen UND danach in einem Testzeitraum Geld verdienen, der bei der Suche nicht verwendet werden durfte. Dazu kommt eine Hürde gegen Zufallstreffer: Wer viele Varianten probiert, findet zufällig scheinbar gute — die Hürde rechnet ein, wie viele Versuche schon liefen, und steigt mit jedem weiteren. Deshalb ist „abgelehnt" hier der Normalfall und kein Fehler. Ein Sieger handelt nur in einem Probekonto mit frischem Spielgeld; ob er je echtes Geld verwaltet, entscheidest du im Studio über „Befördern". Abgeschaltet wird die Suche zusammen mit dem Auto-Tuner — beides gehört zusammen: Das System verbessert sich selbst, aber nur mit Beweisen.',
  },
  depotVerlauf: {
    t: 'Depot-Verlauf, zerlegt',
    d: 'Die Depotwert-Kurve zeigt, DASS dein Depot gestiegen oder gefallen ist — aber nie, WODURCH. Zwei Konten mit gleicher Kurve können ganz verschieden entstanden sein: eins aus zwanzig kleinen Gewinnen, das andere aus einem Glückstreffer und neunzehn Verlusten. Genau davon hängt aber ab, was man am System ändern sollte. Diese Grafik zerlegt die Kurve: Die waagerechte gestrichelte Linie ist dein Depot am ersten Tag des gewählten Zeitraums. Jede farbige Fläche ist ein Wert (oder, umgeschaltet, ein einzelner Trade) mit dem Gewinn oder Verlust, den er seit diesem Tag angesammelt hat. Die Flächen bilden eine Treppe: Gewinner bauen den Berg auf, Verlierer tragen ihn wieder ab, und zuletzt gleicht der Buchwert der noch offenen Positionen auf den tatsächlichen Stand ab — der Teil, der sich täglich mit dem Kurs bewegt und noch nicht feststeht. Jede Fläche beginnt dort, wo die vorige endet; deshalb endet die Treppe an jedem Tag genau auf der Depot-Linie. Liefen Linie und Treppe auseinander, wäre das mit bloßem Auge zu sehen — und ein Rechenfehler, kein Darstellungsdetail. Trades, die vor dem Zeitraum geschlossen wurden, stecken schon in der Ausgangslinie und erscheinen nicht noch einmal als Fläche; die Fußzeile sagt, wie viele das sind.',
  },
  haltedauer: {
    t: 'Wie lange halten?',
    d: 'Die teuerste offene Frage des Systems: Wie lange sollte man eine Position halten? Durch bloßes Zuschauen lässt sie sich nicht beantworten — fünf Tage Haltedauer liefern einen Messpunkt pro Woche und Wert; ein verlässlicher Vergleich bräuchte damit Jahre. Diese Karte holt die Antwort deshalb aus der GESPEICHERTEN Kursgeschichte: Für jeden vergangenen Handelstag wird das Signal neu berechnet — nur mit Kursen bis zu diesem Tag, ohne Blick in die Zukunft — und dann geprüft, was ein Ausstieg nach 1, 2, 3, 5 oder 10 Handelstagen gebracht hätte. Abgezogen werden die Kosten, die für die jeweilige Anlageklasse angesetzt sind. Ein Ergebnis zählt nur, wenn der Bewertungstag wirklich vorbei ist und keine Datenlücke dazwischen liegt. Zeilen mit zu wenigen Fällen bleiben blass und zählen nicht — eine Empfehlung aus drei Fällen wäre gefährlicher als gar keine. Die getrennten Spalten Kauf und Verkauf sind der ehrlichste Teil: Verdient nur die Kaufseite, misst man bloß den steigenden Markt, nicht die Treffsicherheit des Signals; verdienen beide Seiten, hat das Signal einen echten Vorteil. Die Karte ändert von sich aus NICHTS an deiner Strategie — sie legt die Zahlen hin, die Entscheidung bleibt bei dir.',
  },
  erkenntnisse: {
    t: 'Was das System gelernt hat',
    d: 'Die meisten Zahlen im Tool zeigen nur den Moment. Diese Karte ist das Gedächtnis: Jeden Abend beantwortet das System eine feste Liste von Fragen an seine eigenen Zahlen — zum Beispiel: Fressen die Gebühren den Gewinn? Welche Anlageklasse verdient Geld, welche verliert? Treffen die Signale die Kursrichtung? Jede Antwort bekommt ein Etikett: „gut“, „Problem“, „Hinweis“ oder „zu wenig Daten“. Bei zu wenigen Fällen behauptet das System bewusst nichts, weil ein Urteil aus fünf Fällen Zufall wäre. Zwei Begriffe kommen oft vor: Ein Trade ist ein echter Kauf mit späterem Verkauf. Eine Messung prüft ein Kauf- oder Verkaufssignal des Systems — auch eines, das nicht gehandelt wurde —, ob der Kurs danach in die angezeigte Richtung lief. Über jedem Satz steht, seit wann die Antwort so lautet, darunter die Zahlen, auf denen er beruht. Kippt eine Antwort, steht dabei, bis wann es anders aussah — genau das sind die interessanten Momente. Alles hier rechnet das System selbst aus, ohne KI und ohne Kosten.',
  },
  aibericht: {
    t: 'Tages-Einschätzung (KI)',
    d: 'Einmal am Tag liest eine KI die Antworten darüber und die Handelszahlen und fasst in ein paar Sätzen zusammen: Läuft es gerade gut oder schlecht, woran liegt das hauptsächlich, und was wäre ein sinnvoller nächster Schritt? Sie schreibt ausdrücklich für Nicht-Trader. Wichtig: Der Bericht ist nur ein Text. Er kauft und verkauft nichts und ändert keine Einstellung. Die KI sieht nur die eigenen Zahlen des Systems — keine Nachrichten und nichts aus dem Internet —, damit keine fremden Texte ihr falsche Anweisungen unterjubeln können. Die KI kann sich irren: Maßgeblich sind die Zahlen darüber. Ein Aufruf pro Tag mit festem Kostendeckel; ohne hinterlegten Zugangsschlüssel für die KI steht hier ein Hinweis, alles andere läuft weiter.',
  },
  kaufkraft: {
    t: 'Kaufkraft danach',
    d: 'Dein verbleibendes Cash nach dieser Order inklusive aller Kosten. Rot heißt: Die Order übersteigt dein Guthaben und würde vom Broker abgelehnt.',
  },
  rsi: {
    t: 'RSI (Relative-Stärke-Index)',
    d: 'Ein Messwert von 0 bis 100, der zeigt, wie stark ein Kurs zuletzt (über 14 Kerzen) gestiegen oder gefallen ist. Unter 30 gilt er als „überverkauft" (zuletzt stark gefallen — eine Erholung ist wahrscheinlicher), über 70 als „überkauft" (stark gestiegen — ein Rücksetzer ist wahrscheinlicher). Kein Orakel für den richtigen Zeitpunkt — stark erst im Zusammenspiel mit anderen Signalen.',
  },
  macd: {
    t: 'MACD (Moving Average Convergence/Divergence)',
    d: 'Vergleicht zwei Durchschnitte des Kurses, bei denen jüngere Kurse stärker zählen — einen schnellen (12 Kerzen; eine Kerze ist ein Kursabschnitt, z. B. 5 Minuten oder 1 Tag) und einen langsamen (26 Kerzen) —, plus eine Signallinie: den Durchschnitt des Abstands zwischen beiden über 9 Kerzen. Balken (Histogramm) über null = der Schwung geht nach oben („bullisch"), unter null = nach unten („bärisch"). Kreuzen sich die Linien, gilt das als Hinweis auf einen Trendwechsel.',
  },
  signal: {
    t: 'Gesamtsignal',
    d: 'Das Gesamturteil des letzten Durchlaufs aus allen Stimmen (RSI, MACD, Bollinger, Prognose): BUY (kaufen), SELL (verkaufen) oder HOLD (abwarten). Genau danach handelt die Auto-Engine, wenn sie eingeschaltet ist.',
  },
};

/**
 * Englische Fassung — darf lücken (feldweiser Fallback, s. o.), aber KEINE
 * Schlüssel außerhalb von `INFO_DE` erfinden (Karteileichen-Test).
 *
 * Die Fachbegriffe bleiben englisch, wo sie es im Deutschen schon sind
 * (Stop-Loss → stop loss, Take-Profit → take profit): Wer die Oberfläche auf
 * Englisch stellt, erwartet die Begriffe, die auch beim Broker stehen.
 */
export const INFO_EN: Record<string, Partial<Tip>> = {
  rsiBuy: {
    t: 'RSI buy threshold',
    d: 'The Relative Strength Index (RSI, 14 periods) measures from 0–100 how overbought or oversold a market is. If the RSI falls BELOW this threshold (classically 30), the market counts as oversold — the indicator casts a buy vote into the confluence. A lower threshold = rarer but more conservative buy signals.',
  },
  rsiSell: {
    t: 'RSI sell threshold',
    d: 'If the RSI rises ABOVE this threshold (classically 70), the market counts as overbought — the indicator votes to sell. A higher threshold = you let profits run longer but risk missing the turning point.',
  },
  konfluenz: {
    t: 'Minimum confluence',
    d: 'Confluence = agreement of several independent votes (RSI, MACD, Bollinger, forecast). Only when at least THIS many votes point in the same direction does the engine trade. Higher = fewer but more reliable trades; lower = more active but more error-prone.',
  },
  minConfluence: {
    t: 'Confluence for the entry',
    d: 'How many indicator votes a BUY needs. At 2, for example, RSI and MACD must say “buy” at the same time; the forecast counts as a weighted extra vote (capped, unless you let it go solo). Lower = more trades but more false signals — 1 means “every single vote buys immediately”.',
  },
  exitConfluence: {
    t: 'Confluence for the exit',
    d: 'How many indicator votes a SELL needs — separate from the entry and deliberately lower. The reason is asymmetric: a missed entry only costs an opportunity, a missed exit costs money. On a tie of votes, the sell therefore wins. Previously the same threshold applied to both — and because RSI and Bollinger say “oversold, so buy” in falling markets, they blocked the exit exactly when it would have been needed.',
  },
  signalTimeframe: {
    t: 'Signal timeframe',
    d: 'Which candles the trading signals are computed on. “5-minute” (default): RSI, MACD, Bollinger and the short-term forecast run on 5-minute candles — signals turn at the pace of the 5-minute scan and the engine trades MUCH more often (day-trading style). “Daily candles”: the calm view — signals only change every few days, with less noise and lower fees. Honestly: every trade costs 0.1 % plus slippage — high frequency eats returns, and paper trading is the right place to experience that without risk.',
  },
  cooldownMin: {
    t: 'Buy pause after a sell',
    d: 'How many minutes a symbol is not bought again after a sale (including stop loss / take profit). Prevents the back-and-forth (whipsaw): a stop loss fires in falling markets — precisely then RSI/Bollinger often shout “oversold, buy!”, and without a pause the symbol would be back in the portfolio on the next scan, minus fees. Smaller = more trades; below 5 minutes (the scan interval) the pause would have no effect, which is where the risk envelope clamps it.',
  },
  minEdgeMultiple: {
    t: 'Cost threshold',
    d: 'The system’s most important filter — and the one it lacked the longest. Every trade costs fees plus spread, there and back: 0.1 % on US equities, up to 0.5 % on crypto. Without this filter you trade on the signal and pay afterwards — in measured practice the friction then eats a multiple of the actual result. So the engine checks beforehand: does this instrument even move far enough within the minimum holding period to beat the costs? Computed from the ATR and the square root of the holding period (over four candles the expected move doubles, it does not quadruple). At 3, the expected move must be three times the costs — the trade must carry even when two out of three attempts fail. Higher = fewer but more worthwhile trades. 0 switches the filter off (not recommended).',
  },
  dailyLossLimit: {
    t: 'Daily loss brake',
    d: 'The limit at which the day is over — measured against yesterday’s equity, including unrealised losses. WHY, GIVEN THERE IS A STOP LOSS: the stop loss protects a POSITION. It does not help against the case that really empties accounts: many small losses in a row on one day, each of them stopped by the rules. With 39 watched symbols, a 5-minute cadence and roughly a 24 % hit rate, a losing streak is not an exception but the norm — it just costs more on some days. A daily limit answers the question no single stop can: when do you stop? WHY UNREALISED LOSSES COUNT: if only realised losses counted, the brake would never trigger as long as nobody sells — and that very behaviour (letting losers run) is what it is meant to brake. WHAT IT DOES: it blocks ENTRIES, in both paths — automatic and manual click. A brake you can bypass with one trade is not a brake. Existing exits (stop, target, trailing, signal) keep running; a sale always stays possible, otherwise it would block the very way out it triggered for. HOW IT RELEASES: by itself on the next trading day, or earlier with a deliberate click. It does NOT release because the price briefly recovers — otherwise it would have prevented nothing on exactly the day it is needed. The maximum is 25 %: above that it is no longer an emergency brake but decoration, and the cap also catches the typo (250 instead of 2.5 would have silently switched the brake off). 0 = off.',
  },
  flattenOnBreach: {
    t: 'Flatten on brake',
    d: 'On triggering the daily loss brake, additionally closes ALL open positions. The default is OFF, and that is the more important setting: a forced sale sounds decisive and is usually wrong. It realises unrealised losses at the worst moment of the day and turns an interim correction into a final loss — on a day when the market is already running against you. The existing exits keep running anyway; they are the right authority for the question of when a SINGLE position gives up, because they know its stop, target and trailing. This option is meant for the case where someone explicitly wants a hard cut — before a trip, say, or while the strategy is being rebuilt.',
  },
  regimeGate: {
    t: 'Market light',
    d: 'Blocks entries that run against the measured market state. The state comes from three free inputs: the S&P 500’s position relative to its 200-day average, the actual volatility of the last 20 days, and the VIX level. Three rules follow: in an UPTREND no short sales — you do not bet against the market you are in. Under STRESS (VIX at 30 or above, or very high volatility) no new entries at all, because prices then move in jumps and a stop is not filled at the stop price but at the next one. SIDEWAYS everything is allowed — without a trend there is no trend direction to violate. The trigger was a measurement in our own trading history: short sales in an uptrend lost across every kind of indicator — the common denominator was the direction, so the rule blocks the direction. Like the news veto it can only prevent trades, never trigger them: existing positions stay untouched, exits always free. If the market data is missing, “sideways” applies and nothing is blocked — a data outage must not become a silent trading ban. On a NEUTRAL light (sideways) the engine also brakes: buy pause at least twice as long (at least 30 minutes) and half position size — sideways markets produce false signals. The edge per regime (count and hit rate, measured under the brake) is shown as a tooltip on the regime chip in the engine state card.',
  },
  newsVeto: {
    t: 'News veto',
    d: 'Blocks NEW entries into a symbol for a few hours when a hard event is currently in the headlines for it: quarterly figures, a profit warning, litigation/investigation, a takeover or a change of leadership. The reason is mechanical: around such dates prices JUMP instead of moving — and RSI, MACD and Bollinger, on which the entry rests, say nothing about jumps. A stop loss does not protect against that either, because on a gap you sell at the next price, not at the stop price. The veto can only PREVENT trades, never trigger them — so at most it lowers fees. Exits always stay free: an open position is never held back because headlines are running. The sources are free news feeds (Yahoo Finance, Google News), scored by a word list — no AI, no cost. Ordinary coverage (“what analysts expect …”) does not trigger the veto; it takes a dated event with clear wording. If the feed fails, trading continues normally — the veto switches itself off, never the engine.',
  },
  kiNachrichten: {
    t: 'AI news',
    d: 'A language model reads fresh short news items on the symbols in your watchlist and portfolio (from Alpaca’s news stream, mostly Benzinga; at most 45 minutes old) and judges: good or bad for the symbol, how strong, already in the price? Every clear call is cross-checked in a second, independent pass. Only cross-checked calls act. Good news counts on entries as much as all required signals together — so it can trigger a buy on its own, but then only at half size (probe size) and without borrowed money; the cost hurdle, the market traffic light and all other checks still apply. It also lifts a blanket news block when it concerns the same event. Bad news blocks new buys of the symbol, tightens the loss limit on held positions or — only when the news is demonstrably not yet in the price — triggers the sale. For bets on falling prices everything applies mirrored. How much the AI vote counts is measured continuously against real price moves; the measurement may only weaken it. Cost: $2 per account and day into a shared pool; once empty, a word list keeps voting at half weight. Exits and stops are never blocked or loosened. Off = this account pays nothing in and gets no AI vote; the word-list block remains.',
  },
  allowShort: {
    t: 'Shorting (short sales)',
    d: 'Allows the engine to bet on FALLING prices: a sell signal without a position opens a short (the portfolio “borrows” the shares and sells them), a buy signal covers it again. Profit = entry minus repurchase price. The full counter-value is reserved from cash as collateral and booked back with the gain/loss when covering. Important: when shorting, losses are theoretically unlimited (the price can rise arbitrarily) — which is why this is deliberately opt-in; stop loss (above the entry), trailing stop and the 25 % emergency brake apply mirrored.',
  },
  riskPerTrade: {
    t: 'Risk per trade',
    d: 'Switches position sizing from “share of the portfolio” to “equal risk contribution”. Previously every position got the same 10 % of capital — no matter whether it was a calm bond ETF (0.3 % daily swing) or a wild crypto bet (5 %). That looks like diversification but is not: two or three restless names then drive the whole portfolio and the rest is decoration. This value turns the question around — not “how much money do I put in”, but “how much may I lose when the stop is hit”. At 1 %, EVERY stopped-out trade costs roughly 1 % of the portfolio, whatever the instrument; the quantity follows from the stop distance. A name with a tight stop gets correspondingly more shares. “Max. investment per trade” remains as a hard ceiling — a very tight stop would otherwise compute to a multiple of the portfolio. 0 = off (classic percentage slice). The default is deliberately 0: the rebuild is an improvement, but an unproven one — let the cost threshold take effect first, then switch this on, otherwise you will not know afterwards what did the work.',
  },
  maxOpenPositions: {
    t: 'Max. concurrent positions',
    d: 'How many positions may be open at the same time at most. Once the limit is reached, the engine ignores every further buy signal — until a position closes. Together with “investment per trade %” this determines how full the portfolio gets at most: 10 positions at 10 % is fully invested, 10 at 5 % leaves half in cash. More positions spread the risk but make each one less meaningful — and every open position costs queries on every scan. The ceiling is 30.',
  },
  corePct: {
    t: 'Quiet core %',
    d: 'The share of your capital that is NOT actively traded but sits in a quiet momentum portfolio: the strongest names of the whole catalogue, equally weighted, rebalanced at most once a month — and only as long as the overall market is above its 200-day average; below that the core goes to cash. The reason is a measurement, not an opinion: in our own history the quiet momentum portfolio clearly beat the actively traded accounts — not because their signals advised worse, but because fees ate up the gross result. Since fees are charged as a percentage, no larger position helps against that, only: trade less often and capture bigger moves. That is exactly what the core does. Whatever it ties up is missing from the active engine as cash — so it automatically becomes smaller and remains the search engine for the rare good opportunities. Core positions are invisible to the 5-minute scan: no signal sell, no stop, no trailing. They live off calm. 0 % switches the core off, more than 90 % does not exist — a remainder must stay available for fees and manual trades.',
  },
  leverage: {
    t: 'Leverage (margin)',
    d: 'Trading with borrowed money: at 2× the portfolio may move twice what it holds in equity. Leverage amplifies BOTH directions equally — a 10 % price gain becomes a 20 % account gain, a 10 % loss likewise 20 %. Three things belong to it and all are built in: (1) Leverage applies ONLY to very convincing signals — two votes above your entry threshold and at least 3 in total (otherwise a looser entry threshold would make leverage easier, i.e. exactly backwards); anything below keeps trading cash-covered. (2) If equity falls below 25 % of the position value, positions are force-closed (margin call, checked every minute) — just like at a real broker. (3) The borrowed money accrues 8 % annual interest, booked daily. Without (2) and (3) every evaluation with leverage would look better than it is. The default is 1× (off). Manual trades always stay cash-covered — leverage hangs on the algorithm’s conviction, and a click of yours does not carry that.',
  },
  exits: {
    t: 'Why closed',
    d: 'What actually ended the positions: a fixed mark (stop loss = loss limit, take profit = profit target, trailing stop = loss limit that moves up with the price) or a SIGNAL — that is, because the indicators changed their minds. The breakdown says more than any single number: if almost everything sits under “signal”, the loss limit and profit target are practically never reached. Then it is not your risk setting that decides the result, but the flip of a single indicator vote — a sign that the positions are closed again too early.',
  },
  stopLoss: {
    t: 'Stop loss',
    d: 'Automatic emergency exit: if the price falls by this percentage below the entry, the engine sells immediately — losses are capped before they grow. Set too tight, normal market noise throws you out of the position (“stopped out”).',
  },
  takeProfit: {
    t: 'Take profit',
    d: 'The profit target: if the price rises by this percentage above the entry, it is sold automatically and the gain realised. Secures paper profits but also caps the upside.',
  },
  trailingStop: {
    t: 'Trailing stop',
    d: 'A stop that moves along: when the price rises it follows; when it falls it stays put. It sells when the price drops by this percentage below the HIGHEST price since entry. It deliberately only kicks in once the position has been in profit — as long as it never was, the fixed stop is in charge. Without it a position only closes at the rigid target or at the stop, so in trending phases almost never. 0 = off.',
  },
  maxHold: {
    t: 'Max. holding period',
    d: 'Forced exit after this many calendar days, whatever the price is doing. The point: a position drifting sideways for months ties up capital that could work elsewhere. 0 = off (hold indefinitely).',
  },
  atrStop: {
    t: 'ATR stop (volatility-adaptive)',
    d: 'Instead of a fixed percentage the stop is set as a multiple of the ATR — the instrument’s average daily swing. A 2 % stop is pure noise on Bitcoin (±4 % a day) and throws you out immediately, while on an index (±0.6 %) it is a real signal. With ATR the distance adapts automatically to the instrument AND the market phase. Typical: 1.5–3. 0 = off, then the percentage applies.',
  },
  atrTake: {
    t: 'ATR target',
    d: 'The same principle for taking profits: the target sits this multiple of the average daily swing above the entry. Usually sensible larger than the ATR stop (about double), so that gains can outweigh losses. 0 = off, then the percentage applies.',
  },
  scan: {
    t: 'Scan interval',
    d: 'How often (in minutes) the engine checks all watchlist symbols for new signals. Five minutes is the finest step — the free market data does not reliably deliver anything shorter.',
  },
  periode: {
    t: 'Data period',
    d: 'How much price history the indicator computation sees (e.g. one year of daily candles). It affects moving averages and the context of the signals, not the trading frequency.',
  },
  maxPos: {
    t: 'Maximum position size',
    d: 'The largest share of the starting capital a SINGLE position may tie up. The classic risk-management tool against concentration risk: 10 % means a total loss on one symbol costs at most a tenth of the portfolio.',
  },
  forecastSolo: {
    t: 'Let the forecast decide alone',
    d: 'Normally this is OFF: on entry the forecast counts at most so much that a real indicator vote must still join it. Otherwise it clears the threshold of 2 single-handedly with a weight of 2 — and “confluence of three indicators” would be a label, not a fact. On EXIT it always counts fully anyway. Switch this on if you deliberately want to give the forecast the lead.',
  },
  resetWallet: {
    t: 'Reset account',
    d: 'Deletes the trading history, open positions and all metrics, and sets the balance back to your starting capital. WHAT IT IS FOR: after a larger strategy rebuild, the old trades measure a system that no longer exists. Leaving them would not be harmless: the metrics run over the last 500 trades, and because the new engine deliberately trades far less often, the old numbers would keep dragging the average for months — you could never tell whether an improvement came from the filters or merely from dilution. WHAT STAYS: all price data, candles and indicators, the forecast hit rates (they measure predictions, not trades — and they are the training history of the self-optimiser), your strategies and your drawn forecast arrows. WHAT GOES: trades, positions, equity curve, metrics, tuner fleet, shadow portfolios. A cut mark is recorded so it stays traceable from when measurement started. Cannot be undone.',
  },
  brokerStatus: {
    t: 'Live-money connection',
    d: 'LIVE MATURITY is the most important line on this card. It implements the rule that the switch is only thrown once the system demonstrably makes money — and not as a sticky note but as a lock in the execution path. Even with both approvals in place, trading stays in our own book as long as one criterion is missing. The reason for that hardness: the moment somebody wants to flip the switch against the data is exactly the moment they least want to look at the data. FIVE CRITERIA: (1) sample ≥ 40 trades — calibrated to the daily regime (13 Aug., owner decision: “live in about two weeks if everything works well”); a daily trade carries more statistical weight than a 5-minute trade, and the earlier 200 came from the 5-minute era. (2) Profit factor ≥ 1.20, not 1.00 — paper trading systematically understates reality (partial fills, real slippage in thin books, prices missed between signal and order); switching at exactly 1.0 means switching live to below it. (3) Fee share ≤ 50 % of the gross result — above that the system carries on paper, but any deterioration in execution tips it immediately. (4) Net result above zero. (5) Measurement run ≥ 14 uninterrupted days — a profit over three days is weather, not climate; the run counts from the last account reset, because throwing away a bad stretch does not let you keep its maturity. Criteria 2–4 are the condition behind “if everything works well”: two bad weeks open the gate no more than before. THE EDGE PER TRADE below is the number everything hangs on: what a trade brings in on average against what it costs. A coverage below 1 means every single trade loses money in expectation — no better market phase and no luck fixes that, only fewer and better trades. It checks the connection to the broker (Alpaca) WITHOUT sending an order — testing the connection with your first trade means testing it with money. WHY ALPACA: because it is the only provider running a paper account on the same interface as the live account; only the address differs. That lets the whole chain — keys, order format, reconciliation, error cases — be rehearsed on a real account without risking a cent. THREE SWITCHES, ALL THREE REQUIRED: (1) keys stored — only in the server environment, never in the database, never in the browser. (2) Strategy set to live money — the switch in your settings. (3) Environment approval ALPACA_ALLOW_LIVE — a second switch in a different place that no user interface can reach. If one is missing, everything keeps running in our own book. That is deliberate: a stray click must not be able to move real money, and neither must an env var set by accident. RECONCILIATION is the most important ongoing control in live operation, and it checks both directions: a position that exists only at the broker is a risk the engine knows nothing about — it will never close it. A position that exists only in our own book makes the engine plan around cover that is not there. Long and short are told apart even when the quantity matches. AGAINST DOUBLE ORDERS: every order carries an identifier from the scan that triggered it. If a cloud function restarts after an error, the broker recognises the identifier and rejects the repeat — instead of opening a second position nobody wanted.',
  },
  taxReport: {
    t: 'Tax export (Germany)',
    d: 'Prepares the trading history the way German tax law wants to see it — separated into pots, because gains and losses may NOT be freely offset against each other here. Throwing everything into one sum systematically understates the tax owed; that is the most common mistake in home-made evaluations. THE FOUR POTS: (1) Equities — losses from share sales may only offset gains from share sales (§ 20 (6) sentence 4 EStG); an equity loss does not rescue an ETF gain. (2) Other — ETFs, funds, bonds. (3) Futures and derivatives — this includes EVERY short sale, crypto included. (4) Private — cryptocurrencies count as a private disposal transaction (§ 23 EStG) under an entirely different regime: your personal tax rate instead of the flat withholding tax, but completely tax-free after ONE YEAR of holding. That deadline is computed to the day, not as 365 days — in leap years those differ by one day, and one day decides the entire gain here. FIFO: with several purchases of the same instrument, the oldest holding counts as sold first — the law prescribes it, and the entry price decides the gain. The calculation uses the full history including trades an account reset moved into the archive: a sale in January stays taxable even if you reset in March. EXEMPTION LIMIT, not an allowance: if the crypto gain stays below the limit it is entirely tax-free — one euro above and the WHOLE amount becomes taxable. WHAT THIS IS NOT: tax advice. No tax liability is computed, deliberately — that depends on church tax, filing status, exemption orders at other banks and loss carry-forwards this system does not know about. The CSV file is meant for your tax adviser.',
  },
  classWeights: {
    t: 'Capital per asset class',
    d: 'A factor on the position size, separately for every asset class: 0 = no longer trades, 1 = normal, 1.5 = larger slices. WHY A DIAL AND NOT A SWITCH: the measured class edges lie between −0.41 % and +0.81 % per dollar traded — everything sits in between, and a switch knows only two answers to a continuous question. WHAT THE NUMBER MEANS: “edge per dollar” is not the profit but the profit AFTER fees divided by the volume traded. It answers the only question that matters: does this class carry its own friction? An example from real numbers: 290 crypto trades at −0.19 % per dollar produced −$1,132 — the same history without crypto stood at +$40 instead of −$1,093. THE DIAL CONTROLS ENTRIES ONLY. An open position is always closed, even if its class now sits at 0; otherwise one click on a dial would imprison holdings. WEIGHT 0 DOES NOT STOP THE MEASUREMENT: signals and the shadow edge keep forming, so a switched-off class can earn its way back. Without that, every shutdown would be final — whoever stops measuring can never find out whether the decision still holds. LIMITS: the dial multiplies onto the same factor as conviction sizing and is capped together with it at 1.5; the concentration limit remains the last authority. Two factors cannot add up into leverage.',
  },
  classAutoTune: {
    t: 'Auto-adjust classes',
    d: 'Lets the daily run change the weights itself — in steps of 0.25 towards the proposal, not in one jump. ON BY DEFAULT since 9 Aug.: before that every proposal had to be adopted by hand, and that is exactly where it failed — the measurement sat there and nothing happened. Anyone who prefers to decide themselves switches it off here; the recommendations stay visible. OTHER PEOPLE’S EXPERIENCE COUNTS TOO: if this account has not yet made 30 trades in a class, the evidence from the overall pool applies — but only from 50 trades across at least 3 accounts, and it may raise the weight to 1 at most. Throttling and switching off may happen on other people’s numbers (a false alarm only costs missed chances); RAISING the stake only on your own. The journal records the source of the evidence for every move. WHY STEPS: a measurement is a snapshot. If the weight jumped to the full proposal at every evaluation, it would swing back and forth between weeks, and every switch costs trades that belonged to the old setting. THE ONE EXCEPTION: anything structurally burning money (more than 0.1 % loss per dollar over at least 30 trades) is set to 0 immediately instead of in stages — a false alarm only costs missed chances there, hesitation costs real money, and the shadow keeps the way back open. EVIDENCE BEFORE OPINION: below 30 trades the automation does not touch a weight, neither up nor down, and not back to the default either. A class with a single trade would otherwise trigger a capital decision. THE SHADOW may only BRING BACK, never switch off: it lacks the stop that caps real losses, so a negative shadow edge is no evidence of a negative trade return — a positive one, by contrast, is a reason to try again at half weight. Every change lands in the journal with a reason; a weight that moves on its own has to stay explainable.',
  },
  loadouts: {
    t: 'Loadouts',
    d: 'Ready-made base settings as a starting point — from the calm “boomer portfolio” to “YOLO full throttle”. WHAT A LOADOUT DOES: it sets the trading options (engine parameters, signals, indicators, leverage) to one coherent character. Watchlist, capital, broker connection and your start/stop switch ALWAYS stay yours. WHAT IT DOES NOT DO: it promises no return — nobody knows today which values actually make money; that is exactly what the running shadow statistics measure. The descriptions may wink, the risk line beneath them never lies: “YOLO” really does mean 3× leverage and shorts, with everything that entails (margin-call risk, theoretically unlimited short losses). NO SHACKLE: after adopting one you keep adjusting freely, and the daily self-optimiser keeps learning as normal — a loadout is a starting point, not a subscription. PREVIEW FIRST: “View” shows field by field what would change; adoption only happens on a click, and everything runs through the same server validation as any manual entry. YOUR OWN LOADOUTS: you can save your current (stored) state under a name and bring it back with one click later — handy before you try something wild.',
  },
  bestPractice: {
    t: 'Proven settings',
    d: 'Shows the settings of the account whose ENGINE most recently produced the best record — recomputed daily, stored anonymously. WHY ONLY ENGINE TRADES COUNT: an account can lead because of a single lucky manual hit; settings that had nothing to do with the success would then be crowned. So only what the automation itself traded is counted. LUCK PROTECTION: a winner is only crowned from 30 engine trades, 14 days of measurement and a positive edge after fees — otherwise the daily best among a handful of accounts is mostly variance, not skill. WHAT IS ADOPTED: engine parameters, signal settings, indicators and the class dials. NOT adopted are the watchlist, capital and your start/stop switch. WHY THERE IS NO AUTOMATION: if every account jumped to the best one, they would all put the same question to the market — and the collective learning, which draws its information from DIFFERENT settings, would stop. So adoption stays a deliberate decision with a preview of the differences.',
  },
  adviseSettings: {
    t: 'Check settings',
    d: 'Looks for settings that work AGAINST EACH OTHER — regardless of how the market is running. Examples from a real account: 3× leverage with the trailing stop switched off (the leverage triples the give-back of every paper gain, and the one mechanism that would secure it is off). Or “max. 30 positions” while the correlation cap binds at 24 — the number sits there and does nothing. Or 10 % per position times 3× leverage = 30 % of equity in a single name, more than the concentration limit would ever allow without leverage. IMPORTANT: this is NOT an optimiser. It does not know which values produce returns — nobody can, from an empty trading history. Findings like these need no statistics, only arithmetic, and that is precisely why they may be automated. What actually PAYS is measured by the daily self-optimiser, which runs variants in the shadow and only promotes what passes a statistical threshold. So “no suggestions” means “nothing contradicts itself”, not “optimal”. Nothing is changed automatically: first show, then tick, then adopt — and every suggestion states its reason, so that next time you spot it yourself.',
  },
  engineMode: {
    t: 'Trading mode',
    d: 'Which machine trades your wallet. “Confluence” (default) is the fast layer: RSI, MACD, Bollinger and the forecast every 5 minutes, with stop loss and targets. “Momentum” is the calm one: once a week the 8 strongest tradable markets of the last 12 months are bought equally weighted — nothing more happens. The difference in numbers: instead of dozens of trades a day, typically 0 to 3 orders a week. That is exactly the point, because across 297 real trades the fees came to 2.7 times the gross result. Momentum is one of the few methods that kept working for decades even AFTER it was published. Two things you need to know: there is deliberately NO stop loss — the strategy lives on enduring pullbacks, and a tight stop would throw it out exactly where it earns. And it has hard phases: at trend reversals momentum loses heavily. The only protection is the market filter — if the S&P 500 sits below its 200-day average, nothing is bought and the account goes to cash. The 5-minute scan leaves a momentum wallet entirely alone; otherwise the two machines would sell each other’s positions out from under them.',
  },
  engineWhy: {
    t: 'What the engine is doing',
    d: 'This card shows in plain words what happened in the last run (the engine checks the markets every 5 minutes). Why it exists: five checks have a say in whether a trade happens — the market traffic light, a self-learning filter for kinds of trade that demonstrably lose, the news veto, the cost threshold and the leverage traffic light. All of them work out of sight, and “nothing is happening” looks exactly the same when a rule is doing its job as when something is broken. So this card states WHAT was checked and why it was rejected — for instance “6 short sales rejected, the market is rising”. At the top the situation: the state of the overall market with the VIX (the stock market’s “fear gauge”) and the actual price swings, an upcoming important economic event, the turn of the month, and how many trades the last run triggered. In the middle the rejection reasons — only the ones that actually applied. At the bottom: how many accounts are actively trading, how many run a calm core (long-term part), and in which symbols many bets on falling prices are currently under pressure (“squeeze setup”: many bets on falling prices while the price rises — this can trigger sharp jumps upwards). All numbers come straight from the run: what stands here is what the engine really did.',
  },
  hebelAmpel: {
    t: 'Leverage traffic light',
    d: 'When the tool may go in big with borrowed money. This used to hang on confluence alone — that is, on how many indicators currently agree. But that does not measure whether that agreement has ever made money — losing kinds of trade can have some indicators agreeing too, and leverage on top multiplies the loss instead of the return. So the order is now “edge first, leverage second”. Five conditions must hold SIMULTANEOUSLY, and deliberately from five different sources — five conditions all derived from price would be one condition in five disguises: (1) the indicators clearly agree, not narrowly; (2) the overall market is in a calm uptrend; (3) this exact kind of trade has demonstrably made money in your OWN trading history over at least 30 trades (statistically backed, not a backtest); (4) futures-market positioning is not against it — no leverage into a crowded market; (5) the expected move is at least five times the trading costs, because leverage multiplies the fees too. If just one condition fails, trading is cash-covered as always. That happens rarely — which is exactly the intent: go in big only when the opportunity is both safe AND cheap. The margin call at 25 % and the concentration limit continue to apply unchanged.',
  },
  sizingBase: {
    t: 'Sizing base',
    d: 'What the position size is computed from. “Available cash” (default): every purchase takes its percentage of the currently free cash — the wallet keeps working even with positions already open, and the slices shrink automatically as cash falls. “Starting capital (fixed)”: every slice is the same size (a percentage of the starting capital) — more predictable, but as soon as the remaining cash no longer covers a full slice, the engine buys nothing at all. That is precisely what used to leave a lot of cash idle.',
  },
  watchlist: {
    t: 'Watched',
    d: 'Watching happens at TWO depths. Shallow: every one of the 166 catalogue markets whose exchange is currently open gets a fresh price every five minutes — nothing runs away unnoticed any more. That became possible through a batch request fetching 20 symbols per call: 9 requests for the whole catalogue instead of 166. Before, coverage rotated through in chunks of 15, so a symbol could be an hour old. Deep: the symbols in this list additionally get 5-minute candles, RSI, MACD, Bollinger and the forecast — and only they are traded. They are chosen by the daily ranking run across the full catalogue, plus every open position (which has to stay in until it is closed, otherwise it would lose its stop loss). Why not everything deep? A price is one number; a deep analysis is candle series and indicator computations per symbol and interval — the shallow layer costs almost nothing, the deep one scales directly with the count.',
  },
  fclab: {
    t: 'Forecast lab',
    d: 'Here the forecast checks itself: every stored prediction is compared with the price that actually came about once its period is over. The hit rate per look-back length (how much price history the forecast uses) decides which length future forecasts use — and whether the forecast may vote at all when trading: without a proven hit rate it does NOT vote, it has to earn its weight first. The card shows this bookkeeping: the hit rates for daily and short-term forecasts plus “forecast vs. reality” for the selected symbol.',
  },
  fcCombo: {
    t: 'Hit rate per look-back length',
    d: 'Every forecast is also computed in the background with several look-back lengths — that is, with different amounts of price history (“lookback”) — and compared with the real price move once its period is over. The length with the best hit rate (on a tie: smallest average error) is used for the current forecast — that is how the system improves itself. Important: as long as no hit rate is proven, the forecast does NOT vote at all when trading; it has to earn its weight first.',
  },
  mae: {
    t: 'MAE — average error',
    d: 'How far forecast and actual price were apart on average, as a percentage of the price — no matter whether the estimate was too high or too low. The smaller, the more precise the prediction. The value also sets how wide the uncertainty band around the forecast is drawn.',
  },
  anEquity: {
    t: 'Account curve (realised)',
    d: 'The sum of all CLOSED trades, step by step. Deliberately different from the total-value curve: that one shows one value per day, including the paper gains of open positions. This line jumps with every closed trade and shows only what was actually taken in — a paper gain on a position still open is an opinion, not a result. The dashed line is the starting point: everything above it is earned, everything below it lost.',
  },
  anHisto: {
    t: 'Distribution of results',
    d: 'How many trades landed in which gain or loss range. The most important question only this chart answers: are the losses bigger than the gains? A strategy that wins 60 % of the time still ruins you if the few losers weigh three times as much as the many winners — you never see that in the hit rate alone. The bars sit symmetrically around zero so that a gain and a loss never land in the same bar.',
  },
  anStunde: {
    t: 'Result by trading hour',
    d: 'At what time of day the strategy earns or loses — in New York exchange time (ET), not world time (UTC); otherwise daylight saving would push the opening hour into a different bucket twice a year. A typical pattern: prices swing most in the first trading hour, and for many strategies it is the most expensive. If your losses pile up in one time window, new indicators will not help — a trading break at that time will.',
  },
  kollektiv: {
    t: 'Learned from all accounts',
    d: 'Which setting changes have proven themselves ACROSS ALL accounts. This knowledge does two things — and explicitly not two others. First, it sets the order: there are more possible variants than slots for your test accounts, and the ones proven elsewhere go first — so you reach a good setting sooner. Second, a new account starts with these values instead of the factory settings. What it does NOT do: lower the proof required in your account. Every adoption in YOUR account still needs the full statistical evidence from your own trades — because every account starts from different settings, and what helped there can hurt here. And only counts flow in (how often tested, how often adopted), never individual trades or amounts of other users.',
  },
  kurzfrist: {
    t: 'Short-term forecast',
    d: 'A prediction for the next hour based on 5-minute candles — recomputed on every run. It learns separately from the daily forecast: every hour it is compared with the prices that actually came about.',
  },
  sharpe: {
    t: 'Sharpe ratio',
    d: 'How much return you get per unit of risk: the average daily return divided by how much it swings, scaled up to a year (×√252 — a trading year has about 252 trading days). Above 1 counts as good, above 2 as very good. So a high return with wild swings can score WORSE than a calm, moderate one. “30” and “90” stand for the last 30 or 90 saved daily values. “--” means: not enough data yet, or a completely flat line — deliberately not a flattering 0.',
  },
  maxdd: {
    t: 'Max decline',
    d: 'The deepest fall from an earlier high, in percent — “how much did it hurt at the worst moment?”. The most important number for staying the course, because losses are harder to make back than to make: after −30 % you need +43 % just to get back to where you were, after −40 % already +67 %. Smaller is better, even if the return is a little lower for it.',
  },
  drawdown: {
    t: 'Decline from peak',
    d: 'For each day: how far your account was below its highest level up to then, in percent. 0 means a new high; every dip downwards is an ongoing decline. This chart shares its time axis with the total-value curve above — a trough in the curve and its decline sit exactly one above the other. That shows at a glance whether losses were short dents or long dry spells, and how long it took to get back to the old high. The “Max decline” figure in the table is computed by the server from the same data.',
  },
  fees: {
    t: 'Fees and price gap',
    d: '0.1% order fee plus 5 basis points (0.05%) of slippage — the difference between the quoted price and the price actually paid. This is not just displayed: the paper broker (the practice broker with play money) REALLY deducts it — on the same terms as the backtest (the test on past prices).',
  },
  gesamtPnl: {
    t: 'Total P&L (profit/loss) — what this number measures',
    d: 'P&L means profit and loss. Total P&L = current account value (“Equity (live)”) minus the starting base. The base is SET AGAIN on a portfolio import or a reset — the number then only counts from that day. It is made of “realised” (trades closed since then) and “open” (the paper gain or loss of positions still open; it only becomes a real result once closed). The trade analysis answers a DIFFERENT question: what did the closed trades bring in the chosen period — including those before the restart. So both numbers can be right at the same time and still look contradictory: old closings in the red, open positions currently in the green. The most reliable single number stays “Equity (live)” — the balance exactly as the broker shows it.',
  },
  equityCurve: {
    t: 'Total value',
    d: 'The course of your ENTIRE portfolio value: cash plus all open positions at that day’s price. One point is recorded once a day after the US market closes — unlike the live display, the curve therefore cannot be flattered by a lucky in-between reading. It is the most honest chart there is about a strategy: individual winners do not count, only whether the line rises over weeks.',
  },
  hwm: {
    t: 'Peak value',
    d: 'The highest portfolio value your account has ever reached. It is the reference point for the decline from peak: everything below it has not been made back yet. It only rises when a new record is set.',
  },
  profitFactor: {
    t: 'Profit factor',
    d: 'All gains added up divided by all losses added up, across the closed trades. Above 1 means you make money overall; 1.5 counts as solid, below 1 the strategy loses. The handy thing about this number: it works no matter how often you are right — a few big winners can carry many small losses. “--” appears as long as there is not a single losing trade (the value would then be infinite, which says nothing).',
  },
  expectancy: {
    t: 'Average per trade',
    d: 'What a closed trade brought on average (total result divided by the number of trades). The number sums the strategy up in one sentence: “every trade brings $X on average.” If it is negative, trading more often only loses money faster — more trades only pay off when this average is positive.',
  },
  quellen: {
    t: 'Result by entry path',
    d: 'Which path opened the position — and does that path make money? Every closed position counts towards its entry: confluence (several indicators agree), rule tree (if-then rules from the studio), momentum (the recently strongest symbols), core (the calm long-term part), AI probe or manual (by you). “Synced” and “Unknown” are not paths but gaps: positions the broker reconciliation added afterwards, or older holdings without a record of where they came from. “Net/$” is the result per dollar traded, in percent, after fees — it shows whether a path covers its own costs, and it colours the row. Each asset class starts with its total, worst first; below it the paths, sorted by this value. A “--” means older trades lack the fee information: the value cannot be computed, but the result next to it is still correct. The table shows only your own account; the public overview names this value and the fees per path only once enough accounts have traded it.',
  },
  fillReibung: {
    t: 'Price gap on execution',
    d: 'The measured difference between the price at which the engine decided and the price at which the broker actually bought or sold — in basis points (1 bp = 0.01%), split into entry and exit. This decides whether stock buys should be placed as limit orders (an order with a fixed price instead of “at the next price”): below 5 bp the switch is not worth it, from 10 bp it is due. The colour on the US-stock entry shows exactly this rule.',
  },
  kapitalEinsatz: {
    t: 'Capital at work',
    d: 'How much of your portfolio is actually working — and in which part. “Invested” is the value of all positions relative to the whole account value, split into the calm momentum core (long-term part) and the active part the engine trades; the rest is cash. The goal is NOT zero cash: when the market filter shows a falling market, the core deliberately moves to cash — that is protection, not idleness. If, however, a lot of cash sits idle for a long time in a rising market, the money is not working; the weekly run therefore tops held positions back up to their target share.',
  },
  kosten: {
    t: 'Trading costs',
    d: 'Every complete trade costs twice: on the buy AND on the sell there is a fee (commission) and slippage — slippage is the small difference between the quoted price and the price actually paid. What matters is “gain ÷ costs”: the average winning move before fees, divided by those costs. Below 2 it is mostly the broker who earns, because more than half of every winning move then goes into costs. Short timeframes produce small price moves — so trading more often strictly needs enough movement per trade, otherwise it only loses faster. “Ø gross gain” and “Ø gross loss” show the pure price moves without fees — so you can see whether the strategy itself works.',
  },
  momentum: {
    t: 'Momentum ranking',
    d: 'Instead of a fixed watchlist, the whole catalogue is sorted by a single number: the price gain over the last twelve months, with the most recent month NOT counted. The reason: over one month prices tend to turn back; the real drive (momentum) sits in the months before — counting the last month mixes two opposing effects. The eight strongest are bought in equal parts — and only while the overall market (benchmark index) is above its average of the last 200 days. Below it, the portfolio stays completely empty: such strategies break down almost only during recoveries AFTER market crashes, and this filter is the cheapest known insurance against that. Rebalancing is weekly, not daily — every rebalance costs fees, and that is exactly what the old strategy failed on. The approach is the best-documented anomaly in finance research (Jegadeesh/Titman 1993; Asness/Moskowitz/Pedersen 2013 across eight asset classes). The ranking and its comparison portfolio on this card run without real money; as the calm core (share adjustable per account), the same rule does trade real capital.',
  },
  autotuner: {
    t: 'Auto-tuner',
    d: 'The system keeps testing your setting against slightly changed variants — each variant changes exactly ONE value (e.g. the minimum holding period) and trades in its own test account on the same prices, without real money. After enough closed trades they are compared: only if a variant does demonstrably better in statistical terms (a difference this clear would arise from pure chance in fewer than 5 out of 100 cases) and is noticeably ahead is it adopted. At most one change per day, so that afterwards it is clear what helped. Why test accounts and not a test on past prices: whoever tries many settings on the past reliably finds the one that best explains that period’s random swings — and it fails afterwards. The test accounts, by contrast, trade on prices nobody knew at the moment of the decision. Position size, stop loss and take profit are NEVER touched by the tuner — risk control stays with you.',
  },
  tradejournal: {
    t: 'Trade journal',
    d: 'Every booked trade — by the engine or by hand — automatically gets a journal entry with a frozen snapshot of the signal: which indicators voted how, how many agreed (confluence), what the market traffic light showed and whether the forecast voted too. Frozen because the same indicators look different five minutes later — the trade list alone can no longer tell you WHY. Your job is the assessment: grade A (by the rules and clean) to D (mistake spotted) plus a note. You cannot change the facts themselves — a journal whose numbers can be prettied up afterwards would be useless for learning. The value comes when you read it again: losers graded A are bad luck, losers graded D are a pattern.',
  },
  struktursuche: {
    t: 'Structure search',
    d: 'The auto-tuner turns the DIALS of your strategy (e.g. holding period) — the structure search changes the BLUEPRINT, i.e. the if-then rules themselves (the “rule tree”): one building block a day (reverse a comparison, drop a branch, add a condition). Every candidate is tested in two stages: it must beat the currently active rules in the search period AND then make money in a test period that was not allowed to be used in the search. On top comes a hurdle against lucky hits: whoever tries many variants finds seemingly good ones by chance — the hurdle accounts for how many attempts have already run, and it rises with each further one. That is why “rejected” is the normal case here and not a fault. A winner trades only in a test account with fresh play money; whether it ever manages real money is your decision in the studio via “Promote”. The search is switched off together with the auto-tuner — the two belong together: the system improves itself, but only with proof.',
  },
  depotVerlauf: {
    t: 'Portfolio history, decomposed',
    d: 'The total-value curve shows THAT your portfolio rose or fell — but never WHY. Two accounts with the same curve can have got there in completely different ways: one from twenty small gains, the other from one lucky hit and nineteen losses. Yet that is exactly what decides what should change in the system. This chart takes the curve apart: the horizontal dashed line is your portfolio on the first day of the chosen period. Every coloured area is a symbol (or, when switched, a single trade) with the gain or loss it has built up since that day. The areas form a staircase: winners build the mountain up, losers carry it back down, and finally the book value of the positions still open adjusts it to the actual level — the part that moves daily with the price and is not settled yet. Every area starts where the previous one ends, which is why the staircase lands exactly on the portfolio line every day. If line and staircase drifted apart, you would see it with the naked eye — and it would be a calculation error, not a display detail. Trades closed before the period are already inside the starting line and do not appear again as an area; the footer says how many those are.',
  },
  haltedauer: {
    t: 'How long to hold?',
    d: 'The most expensive open question in the system: how long should a position be held? Watching cannot answer it — a five-day holding period yields one data point per week and symbol, so a reliable comparison would take years. This card therefore takes the answer from the STORED price history: for every past trading day the signal is recomputed — only from prices up to that day, without a look into the future — and then it checks what an exit after 1, 2, 3, 5 or 10 trading days would have brought. Costs are deducted at the rates assumed for each asset class. A result only counts if the evaluation day is really over and there is no data gap in between. Rows with too few cases stay pale and do not count — a recommendation from three cases would be more dangerous than none. The separate buy and sell columns are the most honest part: if only the buy side earns, you are merely measuring the rising market, not how well the signal hits; if both sides earn, the signal has a real advantage. The card changes NOTHING about your strategy by itself — it lays out the numbers, the decision stays yours.',
  },
  erkenntnisse: {
    t: 'What the system has learned',
    d: 'Most numbers in the tool only show the moment. This card is the memory: every evening the system answers a fixed list of questions about its own numbers — for example: do fees eat up the profit? Which asset class makes money, which loses? Do the signals get the price direction right? Each answer gets a label: “good”, “problem”, “note” or “not enough data”. With too few cases the system deliberately claims nothing, because a verdict from five cases would be chance. Two terms come up often: a trade is a real purchase with a later sale. A measurement checks a buy or sell signal of the system — even one that was not traded — for whether the price then moved in the indicated direction. Above each sentence is since when the answer has been the same, below it the numbers it rests on. When an answer flips, it says until when things looked different — those are the interesting moments. The system computes all of this itself, without AI and at no cost.',
  },
  aibericht: {
    t: 'Daily assessment (AI)',
    d: 'Once a day an AI reads the answers above and the trading figures and sums them up in a few sentences: is it going well or badly right now, what is the main reason, and what would be a sensible next step? It writes explicitly for non-traders. Important: the report is just text. It buys and sells nothing and changes no setting. The AI only sees the system’s own numbers — no news and nothing from the internet — so no outside text can sneak false instructions into it. The AI can be wrong: the numbers above are what counts. One call per day with a fixed cost cap; without a stored access key for the AI a note appears here, and everything else keeps running.',
  },
  kaufkraft: {
    t: 'Buying power afterwards',
    d: 'Your remaining cash after this order including all costs. Red means: the order exceeds your balance and would be rejected by the broker.',
  },
  rsi: {
    t: 'RSI (Relative Strength Index)',
    d: 'A value from 0 to 100 showing how strongly a price has recently (over 14 candles) risen or fallen. Below 30 it counts as “oversold” (fell sharply — a recovery is more likely), above 70 as “overbought” (rose sharply — a pullback is more likely). Not an oracle for the right moment — strong only together with other signals.',
  },
  macd: {
    t: 'MACD (Moving Average Convergence/Divergence)',
    d: 'Compares two averages of the price in which recent prices count more — a fast one (12 candles; a candle is one price section, e.g. 5 minutes or 1 day) and a slow one (26 candles) — plus a signal line: the 9-candle average of the gap between the two. Bars (histogram) above zero = momentum points up (“bullish”), below zero = down (“bearish”). When the lines cross, that counts as a hint of a trend change.',
  },
  signal: {
    t: 'Overall signal',
    d: 'The overall verdict of the last run across all votes (RSI, MACD, Bollinger, forecast): BUY, SELL or HOLD (wait). This is exactly what the auto engine acts on when it is switched on.',
  },
  'node:compare': {
    t: 'Rule: comparison (compare)',
    d: 'Compares an indicator value (RSI, MACD line, %B …) with a number or another value — e.g. “RSI < 30”. The basic building block of every strategy.',
  },
  'node:crossover': {
    t: 'Rule: crossover',
    d: 'Fires in the exact moment one line crosses another (e.g. the MACD line above the signal line = “golden cross” logic). The classic momentum entry signal.',
  },
  'node:priceLevel': {
    t: 'Rule: price level',
    d: 'True when the price stands above/below a fixed mark — for supports, resistances or psychological levels (e.g. “buy below $100”).',
  },
  'node:changePct': {
    t: 'Rule: change % (changePct)',
    d: 'Measures the percentage price change over the last N candles — e.g. “fallen more than 3 % in 5 days”. Good for dip buys or momentum filters.',
  },
  'node:timeWindow': {
    t: 'Rule: time window',
    d: 'Restricts the signal to a time of day (ET) — e.g. do not buy during the volatile first trading hour. It only applies when the scan time falls inside the window.',
  },
  'node:forecast': {
    t: 'Rule: forecast',
    d: 'The directional vote of the forward forecast: true when the predicted change to the end of the horizon lies above the threshold (up) or below it (down). In the backtest the forecast is recomputed causally for each trading day.',
  },
  'node:position': {
    t: 'Rule: position state',
    d: 'Queries your own portfolio state: “state open” with a min/max % unrealised gain builds exits such as “sell from +5 %” — the rule-based variant of take profit / stop loss.',
  },
};

/**
 * Ein Wörterbuch aus DE + EN bauen — FELDWEISE, damit eine halb übersetzte
 * Karte weder leer noch falsch ist (s. Kopf von `INFO_EN`).
 *
 * Pur gehalten, damit der Test die Fallback-Semantik mit eigenen Records
 * prüfen kann, ohne localStorage zu stubben.
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
