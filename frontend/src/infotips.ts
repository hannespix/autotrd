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
  engineWhy: {
    t: 'Was die Engine gerade tut',
    d: 'Der Betriebszustand des letzten Scans in Klartext. Der Grund für diese Karte: Es entscheiden fünf Mechaniken mit, ob ein Trade zustande kommt — Markt-Ampel, selbstlernender Trade-Filter, News-Veto, Kostenschwelle und Hebel-Ampel. Alle arbeiten im Verborgenen, und „es passiert nichts" sieht bei einer scharf gestellten Regel exakt genauso aus wie bei einem kaputten System. Hier steht stattdessen, WAS geprüft und warum abgelehnt wurde — etwa „6 Leerverkäufe abgelehnt, der Markt steigt". Oben die Lage: Marktzustand mit VIX und tatsächlicher Schwankung, ein anstehender Wirtschaftstermin, die Monatswende und wie viele Trades der letzte Scan ausgelöst hat. In der Mitte die Ablehnungsgründe — nur die, die wirklich gegriffen haben; eine Liste aus lauter Nullen liest niemand zweimal. Unten, wie viele Konten aktiv handeln, wie viele einen ruhigen Sockel führen und welche Symbole gerade in einem Short-Squeeze-Setup stehen (negative Finanzierungsrate bei steigendem Kurs — die Konstellation der heftigsten Aufwärtsbewegungen). Alle Zahlen kommen aus dem Scan selbst, nicht aus einer zweiten Rechnung: Was hier steht, hat die Engine wirklich getan.',
  },
  hebelAmpel: {
    t: 'Hebel-Ampel',
    d: 'Wann das Tool mit geliehenem Geld groß einsteigen darf. Bisher hing das allein an der Konfluenz — also daran, wie viele Indikatoren gerade einer Meinung sind. Das misst aber nicht, ob diese Meinung je Geld verdient hat — auch verlierende Trade-Sorten können einige Indikatoren einig haben, und ein Hebel darauf vervielfacht den Verlust statt der Rendite. Deshalb gilt jetzt die Reihenfolge „erst Kante, dann Hebel". Fünf Bedingungen müssen GLEICHZEITIG zutreffen, und zwar bewusst aus fünf verschiedenen Quellen — fünf Bedingungen, die alle aus dem Preis stammen, wären eine Bedingung in fünf Verkleidungen: (1) die Indikatoren sind deutlich einig, nicht knapp; (2) der Gesamtmarkt steht im ruhigen Aufwärtstrend; (3) genau diese Trade-Sorte hat in der EIGENEN Handelshistorie über mindestens 30 Trades nachweislich Geld verdient (statistisch abgesichert, kein Backtest); (4) die Positionierung an der Terminbörse steht nicht dagegen — in einen überfüllten Markt hinein wird nicht gehebelt; (5) die erwartete Bewegung ist mindestens fünfmal so groß wie die Handelskosten, weil der Hebel auch die Gebühren vervielfacht. Trifft nur eine Bedingung nicht zu, wird bar gedeckt gehandelt wie immer. Das passiert selten — genau so ist es gemeint: groß einsteigen nur, wenn die Gelegenheit sicher UND günstig ist. Margin-Call bei 25 % und die Klumpengrenze gelten unverändert weiter.',
  },
  regimeGate: {
    t: 'Markt-Ampel',
    d: 'Sperrt Einstiege, die gegen den gemessenen Marktzustand laufen. Der Zustand kommt aus drei kostenlosen Größen: Lage des S&P 500 zu seinem 200-Tage-Durchschnitt, tatsächliche Schwankung der letzten 20 Tage und VIX-Stand. Daraus folgen drei Regeln: Im AUFWÄRTSTREND keine Leerverkäufe — man wettet nicht gegen den Markt, in dem man steckt. Bei STRESS (VIX ab 30 oder sehr hohe Schwankung) gar keine neuen Einstiege, weil Kurse dann in Sprüngen laufen und ein Stop nicht zum Stop-Kurs ausgeführt wird, sondern zum nächsten. SEITWÄRTS ist alles erlaubt — ohne Trend gibt es keine Trendrichtung, gegen die man verstoßen könnte. Der Anlass war eine Messung in der eigenen Handelshistorie: Leerverkäufe im Aufwärtstrend verloren über alle Indikator-Sorten hinweg — der gemeinsame Nenner war die Richtung, deshalb sperrt die Regel die Richtung. Wie das News-Veto kann sie Trades nur verhindern, nie auslösen: Bestehende Positionen bleiben unberührt, Ausstiege immer frei. Fehlen die Marktdaten, gilt „seitwärts" und es wird nichts gesperrt — ein Datenausfall darf kein stilles Handelsverbot werden.',
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
    d: 'Selbstverbesserung der Prognose: Jede gespeicherte Vorhersage wird nach Ablauf ihres Horizonts gegen die eingetretene Realität bewertet. Die Trefferquote je Lookback-Fenster steuert, welches Fenster künftige Prognosen nutzen — und ob die Prognose beim Handeln überhaupt mitstimmen darf: Ohne nachgewiesene Trefferquote stimmt sie GAR NICHT mit, sie muss sich ihr Gewicht erst verdienen. Die Karte zeigt diese Buchführung — die Kombi-Statistik für Tages- und Kurzfrist-Prognosen sowie „Vorhersage vs. Realität" für das gewählte Symbol.',
  },
  fcCombo: {
    t: 'Kombi-Statistik (Self-Tuning)',
    d: 'Das System rechnet jede Prognose parallel mit mehreren Lookback-Fenstern als „Schatten" mit und bewertet sie nach Ablauf gegen die Realität. Das Fenster mit der besten realisierten Trefferquote (Tiebreak: kleinste MAE) steuert die Live-Prognose — das ist die Selbstverbesserung. Wichtig: Solange keine Trefferquote nachgewiesen ist, stimmt die Prognose beim Handeln GAR NICHT mit; sie muss sich ihr Gewicht erst verdienen.',
  },
  mae: {
    t: 'MAE — Mittlerer absoluter Fehler',
    d: 'Durchschnittlicher Abstand zwischen Prognose und eingetretenem Kurs, in Prozent des Kurses. Je kleiner, desto präziser die Vorhersage. Die MAE kalibriert auch die Breite des Konfidenz-Bands.',
  },
  anEquity: {
    t: 'Kontoverlauf (realisiert)',
    d: 'Die Summe aller ABGESCHLOSSENEN Trades, Schritt für Schritt. Bewusst etwas anderes als die Performance-Kurve: Die zeigt einen Wert pro Tag inklusive der Buchgewinne offener Positionen. Diese Linie springt pro Trade und zeigt nur, was tatsächlich realisiert wurde — ein Buchgewinn einer noch offenen Position ist eine Meinung, kein Ergebnis. Die gestrichelte Linie ist der Startpunkt: alles darüber ist verdient, alles darunter verloren.',
  },
  anHisto: {
    t: 'Verteilung der Ergebnisse',
    d: 'Wie viele Trades in welcher Ergebnisspanne gelandet sind. Die wichtigste Frage, die nur dieses Diagramm beantwortet: Sind die Verluste größer als die Gewinne? Eine Strategie mit 60 % Trefferquote ist ruinös, wenn die wenigen Verlierer dreimal so schwer wiegen wie die vielen Gewinner — in der Trefferquote allein sieht man das nie. Die Fächer liegen symmetrisch um die Null, damit Gewinn und Verlust nie im selben Balken landen.',
  },
  anStunde: {
    t: 'Ergebnis nach Handelsstunde',
    d: 'Wann am Tag verdient oder verliert die Strategie — in New Yorker Börsenzeit, nicht in UTC (sonst würde die Sommerzeit die Eröffnungsstunde zweimal im Jahr in ein anderes Fach schieben). Typisches Muster: Die erste Handelsstunde ist die volatilste und für viele Strategien die teuerste. Steht dein Minus konzentriert in einem Zeitfenster, braucht es keine neuen Indikatoren, sondern eine Handelspause.',
  },
  kollektiv: {
    t: 'Aus allen Konten gelernt',
    d: 'Welche Einstellungs-Änderungen sich ÜBER ALLE Konten hinweg bewährt haben. Zwei Dinge macht dieses Wissen — und zwei ausdrücklich nicht. Es bestimmt erstens die Reihenfolge: Es gibt mehr Kandidaten als Plätze in deiner Schatten-Flotte, und die anderswo bewährten kommen zuerst dran, damit du schneller bei der guten Einstellung landest. Zweitens startet ein neues Konto damit, statt bei den Fabrikwerten anzufangen. Was es NICHT tut: deine Beweisschwelle senken. Jede Übernahme in DEINEM Konto braucht weiterhin die volle statistische Evidenz aus deinen eigenen Trades — denn jedes Konto startet von einer anderen Einstellung, und was dort half, kann hier schaden. Und es fließen nur Zählwerte ein (wie oft geprüft, wie oft übernommen), niemals einzelne Trades oder Beträge anderer Nutzer.',
  },
  kurzfrist: {
    t: 'Kurzfrist-Prognose (Intraday)',
    d: 'Projektion der nächsten Stunde auf 5-Minuten-Kerzen — bei jedem Scan neu berechnet. Sie lernt in einem eigenen Regelkreis (stündliche Bewertung gegen realisierte Bars) getrennt von der Tages-Prognose.',
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
    t: 'Sharpe-Ratio',
    d: 'Rendite pro Einheit Risiko: durchschnittliche Tagesrendite geteilt durch deren Schwankung, aufs Jahr skaliert (√252). Über 1 gilt als gut, über 2 als sehr gut. Eine hohe Rendite mit wilden Schwankungen kann eine SCHLECHTERE Sharpe haben als eine ruhige moderate. Im Portfolio steht „30" bzw. „90" für die letzten 30 bzw. 90 Tages-Snapshots. „--" heißt: noch zu wenig Kurve oder eine völlig flache Serie — bewusst kein geschöntes 0.',
  },
  maxdd: {
    t: 'Max Drawdown',
    d: 'Der tiefste Einbruch vom zwischenzeitlichen Höchststand, in Prozent — „wie weh tat es maximal?". Wichtigste Kennzahl fürs Durchhalten: −30 % braucht +43 % nur zum Ausgleich, −40 % schon +67 %. Kleiner ist besser, auch wenn die Rendite dafür etwas niedriger ausfällt.',
  },
  drawdown: {
    t: 'Drawdown-Verlauf',
    d: 'Für jeden Tag: der Abstand zum bis dahin höchsten Kontostand, in Prozent. 0 bedeutet neues Hoch, jeder Ausschlag nach unten ist ein laufender Einbruch. Das Panel teilt sich die Zeitachse mit der Equity-Kurve darüber — ein Tal in der Kurve und sein Drawdown stehen exakt untereinander. So sieht man auf einen Blick, ob Verluste kurze Dellen waren oder lange Durststrecken, und wie lange die Erholung zurück ans Hochwasser dauerte. Die Kennzahl „Max DD" in der Tabelle rechnet der Server aus derselben Serie.',
  },
  // ── Trade-Ticket ──
  fees: {
    t: 'Gebühren (Kommission + Slippage)',
    d: '0,1 % Ordergebühr plus 5 Basispunkte Slippage (Abweichung zwischen angezeigtem und tatsächlichem Ausführungskurs). Wird hier nicht nur angezeigt, sondern vom Paper-Broker WIRKLICH berechnet — dieselben Konditionen wie im Backtest.',
  },
  // ── Portfolio-Kennzahlen (M12) ──
  gesamtPnl: {
    t: 'Gesamt P&L — was diese Zahl misst (und was nicht)',
    d: 'Gesamt P&L = Equity (live) − Kapitalbasis. Die Basis wird bei einer Depot-Übernahme oder einem Reset NEU geankert — die Zahl zählt dann erst ab diesem Schnitt und ist die Summe aus „Realisiert" (geschlossen seit dem Schnitt) und „Offen" (unrealisierter Stand der offenen Positionen; wird erst beim Schließen zu echtem Ergebnis). Die Handels-Analyse beantwortet eine ANDERE Frage: Was haben die geschlossenen Trades im gewählten Zeitfenster gebracht — auch die vor dem Schnitt. Deshalb können beide gleichzeitig stimmen und gegenläufig aussehen: alte Abschlüsse im Minus, offene Positionen gerade im Plus. Der ehrlichste Einzelwert bleibt Equity (live) — der broker-identische Kontostand.',
  },
  equityCurve: {
    t: 'Equity-Kurve',
    d: 'Der Verlauf deines GESAMTEN Depotwerts (Cash + alle offenen Positionen zum jeweiligen Tageskurs). Einmal täglich nach US-Börsenschluss wird ein Punkt festgeschrieben — anders als die Live-Anzeige kann die Kurve deshalb nicht durch Zwischenstände „schön" wirken. Sie ist die ehrlichste Einzelgrafik, die es über eine Strategie gibt: Nicht einzelne Gewinner zählen, sondern ob die Linie über Wochen steigt.',
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
  exits: {
    t: 'Warum geschlossen',
    d: 'Wodurch die Positionen tatsächlich beendet wurden: durch eine Risiko-Marke (Stop-Loss, Take-Profit, Trailing-Stop) oder durch ein SIGNAL — also weil die Indikatoren gedreht haben. Die Verteilung ist aufschlussreicher als jede Einzelzahl: Steht fast alles unter „Signal", werden Stop und Take praktisch nie erreicht. Dann entscheidet nicht deine Risikosteuerung über das Ergebnis, sondern das Kippen einer einzelnen Indikator-Stimme — ein Zeichen dafür, dass die Positionen zu früh wieder rausfliegen.',
  },
  fillReibung: {
    t: 'Ausführungs-Reibung',
    d: 'Der gemessene Abstand zwischen dem Kurs, bei dem die Engine entschieden hat, und dem Kurs, zu dem der Broker wirklich ausgeführt hat — in Basispunkten (1 bp = 0,01 %), getrennt nach Einstieg und Ausstieg. Daran hängt die Frage, ob Aktien-Einstiege als Limit-Order (Maker) laufen sollten: unter 5 bp lohnt der Umbau nicht, ab 10 bp ist er fällig. Die Farbe am US-Aktien-Einstieg zeigt genau diese Regel.',
  },
  kapitalEinsatz: {
    t: 'Kapitaleinsatz',
    d: 'Wie viel des Depots tatsächlich arbeitet — und in welchem Teil. „Investiert" ist der Marktwert aller Positionen im Verhältnis zur Equity, aufgeteilt in den ruhigen Momentum-Sockel und den aktiven Engine-Teil; der Rest ist Bargeld. Ziel ist NICHT null Bargeld: Steht der Marktfilter auf Abwärtsmarkt, geht der Sockel bewusst in Cash — das ist Schutz, kein Leerlauf. Dauerhaft hohes Bargeld im Aufwärtsmarkt dagegen heißt, das Geld arbeitet nicht; seit dem Sockel-Nachschub (20.08.) kauft der Wochentakt gehaltene Positionen wieder ans Zielgewicht heran.',
  },
  kosten: {
    t: 'Reibung (Handelskosten)',
    d: 'Jeder Roundtrip kostet Kommission plus Slippage — beim Kauf UND beim Verkauf. Entscheidend ist „Luft über Kosten": die durchschnittliche Gewinnbewegung vor Gebühren, geteilt durch diese Kosten. Unter 2 verdient überwiegend der Broker, denn dann geht über die Hälfte jeder Gewinnbewegung für die Reibung drauf. Kurze Zeitrahmen erzeugen kleine Bewegungen — deshalb braucht mehr Handelsfrequenz zwingend auch genug Bewegung je Trade, sonst beschleunigt sie nur den Verlust. „Ø Gewinn brutto" und „Ø Verlust brutto" zeigen die reinen Kursbewegungen ohne Gebühren, damit sichtbar wird, ob die Strategie selbst funktioniert.',
  },
  momentum: {
    t: 'Momentum-Ranking',
    d: 'Statt einer festen Watchlist wird der komplette Katalog nach einer einzigen Zahl sortiert: der Rendite der letzten zwölf Monate, wobei der jüngste Monat NICHT mitzählt. Der Grund für die Auslassung: Auf Monatssicht kehren Kurse eher um, das eigentliche Momentum sitzt in den Monaten davor — wer den letzten Monat mitzählt, mischt zwei gegenläufige Effekte. Gekauft werden die stärksten acht Werte, gleichgewichtet, und nur wenn der Leitindex über seiner 200-Tage-Linie steht. Steht er darunter, bleibt das Depot komplett flach: Momentum-Strategien brechen fast ausschließlich in Erholungsphasen NACH Markteinbrüchen ein, und dieser Filter ist die billigste bekannte Versicherung dagegen. Umgeschichtet wird wöchentlich, nicht täglich — jede Umschichtung kostet Gebühren, und genau daran ist die alte Strategie gescheitert. Der Ansatz ist die am besten belegte Anomalie der Finanzliteratur (Jegadeesh/Titman 1993; Asness/Moskowitz/Pedersen 2013 über acht Assetklassen). Er läuft hier zunächst als Schattendepot — umgestellt wird erst, wenn er die laufende Strategie statistisch nachweisbar schlägt.',
  },
  autotuner: {
    t: 'Auto-Tuner',
    d: 'Das System probiert deine Einstellung laufend gegen Varianten davon aus — jede Variante ändert genau EINEN Wert (z. B. die Mindest-Haltedauer) und führt ein eigenes Schattenkonto auf denselben Kursen, ohne echtes Geld. Nach genug abgeschlossenen Trades wird verglichen: Nur wenn eine Variante statistisch nachweislich besser abschneidet (Welch-t-Test, p < 0,05, plus spürbarer Vorsprung), wird sie übernommen — höchstens eine Änderung pro Tag, damit hinterher klar ist, was geholfen hat. Warum Schattenkonten und kein Backtest über die Vergangenheit: Ein Parametergitter findet zuverlässig die Kombination, die vergangenes Rauschen am besten erklärt, und versagt danach. Die Flotte handelt dagegen auf Kursen, die zum Zeitpunkt der Entscheidung noch niemand kannte. Positionsgröße, Stop-Loss und Take-Profit rührt der Tuner NIE an — Risikosteuerung bleibt bei dir.',
  },
  tradejournal: {
    t: 'Trade-Journal',
    d: 'Jeder gebuchte Trade — Engine wie manuell — bekommt automatisch einen Journal-Eintrag mit der eingefrorenen Momentaufnahme des Signals: welche Indikatoren wie gestimmt haben, wie hoch die Konfluenz war, was das Regime sagte, ob die Prognose mitgestimmt hat. Eingefroren deshalb, weil dieselben Indikatoren fünf Minuten später anders stehen — aus der Trade-Historie allein ist das WARUM nicht mehr rekonstruierbar. Deine Aufgabe ist die Bewertung: Note A (regelkonform und sauber) bis D (Fehler erkannt) plus Notiz. Die Fakten selbst kannst du nicht ändern — ein Journal, dessen Zahlen sich nachträglich schönen lassen, wäre als Lernwerkzeug wertlos. Der Wert entsteht beim Wieder-Lesen: Verlierer mit Note A sind Pech, Verlierer mit Note D sind Muster.',
  },
  struktursuche: {
    t: 'Struktursuche',
    d: 'Der Auto-Tuner dreht an den REGLERN deiner Strategie (z. B. Haltedauer) — die Struktursuche baut am BAUPLAN: Sie verändert die Regel-Struktur selbst, einen Baustein pro Tag (einen Vergleich kippen, einen Zweig streichen, eine Bedingung ergänzen). Jeder Kandidat wird Walk-Forward geprüft: Er muss den Amtierenden im Suchfenster schlagen UND danach in einem Testfenster verdienen, das bei der Suche nicht mitspielen durfte. Dazu kommt die Deflated-Sharpe-Hürde (Bailey/López de Prado): Wer viele Varianten probiert, findet zufällig „gute" — die Latte rechnet ein, wie viele Versuche schon liefen, und sie wächst mit jedem weiteren. Deshalb ist „abgelehnt" hier der Normalfall und kein Defekt. Ein Sieger handelt ausschließlich ein Schattenkonto mit frischem virtuellem Kapital; ob er je echtes Geld führt, entscheidest du im Studio über „Befördern". Abgeschaltet wird die Suche zusammen mit dem Auto-Tuner — es ist EIN Konzept: Das System verbessert sich selbst, aber nur mit Beweisen.',
  },
  depotVerlauf: {
    t: 'Depot-Verlauf, zerlegt',
    d: 'Eine Equity-Kurve zeigt, DASS das Depot gestiegen oder gefallen ist — nie, WOMIT. Zwei Konten mit derselben Kurve können völlig verschieden entstanden sein: eines aus zwanzig kleinen Gewinnen, das andere aus einem Glückstreffer und neunzehn Verlusten. Genau daran hängt aber jede Entscheidung darüber, was am System zu ändern ist. Diese Grafik zerlegt die Kurve: Die waagerechte gestrichelte Linie ist dein Depot am ersten Tag des Fensters; jede farbige Fläche ist ein Symbol (oder, umgeschaltet, ein einzelner Trade) mit seinem seit diesem Tag aufgelaufenen Ergebnis. Die Flächen bilden eine Treppe: Gewinner bauen den Berg auf, Verlierer tragen ihn wieder ab, und zuletzt korrigiert der Buchwert der noch offenen Positionen auf den tatsächlichen Stand — der Teil, der sich täglich mit dem Kurs bewegt und noch nichts entschieden hat. Jede Fläche setzt dort an, wo die vorige aufhört, deshalb endet die Treppe an jedem Tag exakt auf der Depot-Linie. Ein Auseinanderlaufen von Linie und Treppe wäre also mit bloßem Auge zu sehen und ein Rechenfehler, kein Darstellungsdetail. (Der erste Entwurf stapelte Gewinne nach oben und Verluste nach unten — hübsch, aber die Depot-Linie lag dann irgendwo dazwischen und die Aussage war am Bild nicht prüfbar.) Trades, die vor dem Fenster geschlossen wurden, stecken bereits in der Bezugslinie und tauchen nicht noch einmal als Fläche auf; die Fußzeile sagt, wie viele das sind.',
  },
  haltedauer: {
    t: 'Wie lange halten?',
    d: 'Die teuerste offene Frage des Systems — und sie lässt sich nicht durch Zuschauen beantworten: Eine Haltedauer von fünf Tagen liefert einen Datenpunkt pro Woche und Symbol, ein belastbarer Vergleich bräuchte damit Jahre. Diese Karte holt die Antwort deshalb aus der GESPEICHERTEN Historie: Für jeden Handelstag der Vergangenheit wird das Signal noch einmal berechnet — nur aus Kursen bis zu diesem Tag, nie mit einem Blick nach vorn — und dann geprüft, was ein Ausstieg nach 1, 2, 3, 5 oder 10 Handelstagen gebracht hätte. Die Kosten sind klassenecht abgezogen, ein Ergebnis wird nur gewertet, wenn der Bewertungstag wirklich in der Vergangenheit liegt und keine Datenlücke dazwischen steht. Zeilen mit zu wenig Beobachtungen bleiben blass und zählen nicht — eine Empfehlung aus drei Fällen wäre gefährlicher als gar keine. Die getrennten Spalten Kauf und Verkauf sind der ehrlichste Teil: Verdient nur die Kaufseite, misst man den steigenden Markt und nicht die Fähigkeit des Signals; verdienen beide Seiten, ist es eine echte Kante. Die Karte ändert von sich aus NICHTS an deiner Strategie — sie legt die Zahlen hin, die Entscheidung bleibt bei dir.',
  },
  erkenntnisse: {
    t: 'Was das System gelernt hat',
    d: 'Alle anderen Zahlen im Dashboard sind Momentaufnahmen: Der Heartbeat wird alle fünf Minuten überschrieben, die Tageskennzahlen jeden Abend. Damit sieht man immer nur den JETZT-Stand — nie, was sich über Wochen als wahr herausgestellt hat. Diese Karte ist das Gedächtnis dafür: Ein fester, kleiner Satz Thesen wird jeden Abend gegen die gemessenen Daten geprüft und bekommt einen von drei Zuständen — gilt, widerlegt oder wartet auf Daten. Unterhalb eines Mindest-n wird bewusst NICHTS behauptet; eine Chronik, die bei fünf Trades urteilt, lehrt Rauschen. Jede These trägt ihre Belegzahlen und den Tag, seit dem sie in diesem Zustand ist, und bei einem Wechsel bleibt der alte Wortlaut sichtbar — genau dieser Moment, in dem eine Annahme kippt, ist die eigentliche Erkenntnis. Alles hier ist deterministisch aus vorhandenen Messwerten abgeleitet, ohne KI und ohne Kosten.',
  },
  aibericht: {
    t: 'Tages-Einschätzung (KI)',
    d: 'Einmal am Abend liest ein Sprachmodell die Erkenntnis-Chronik darüber und die aggregierten Handelszahlen und schreibt daraus eine kurze Einschätzung: Welche Befunde hängen zusammen, was ist die wahrscheinlichste gemeinsame Ursache, was wäre der nächste Schritt? Genau das ist der Teil, den Code nicht kann — Zahlen verdichten und Thesen prüfen erledigen die Karten darüber deterministisch und kostenlos. Wichtig: Der Bericht ist ein Text NEBEN der Maschine, keine Stimme IN ihr. Er löst keine Order aus, ändert keine Einstellung und befördert keine Strategie; jede solche Entscheidung braucht weiterhin statistische Evidenz. Das Modell sieht ausschließlich eigene Messwerte des Systems — keine Schlagzeilen, keine Fremdtexte, nichts aus dem Netz —, damit sich über die Eingabe keine fremden Anweisungen einschleusen lassen. Ein Aufruf pro Tag, mit Monatsdeckel und hartem Token-Limit; ohne hinterlegten API-Schlüssel bleibt die Zeile leer und alles andere läuft weiter.',
  },
  kaufkraft: {
    t: 'Kaufkraft danach',
    d: 'Dein verbleibendes Cash nach dieser Order inklusive aller Kosten. Rot heißt: Die Order übersteigt dein Guthaben und würde vom Broker abgelehnt.',
  },
  rsi: {
    t: 'RSI (Relative-Stärke-Index)',
    d: 'Momentum-Oszillator 0–100 über 14 Perioden: unter 30 überverkauft (Erholung wahrscheinlicher), über 70 überkauft (Rücksetzer wahrscheinlicher). Kein Timing-Orakel — stark im Zusammenspiel mit anderen Signalen.',
  },
  macd: {
    t: 'MACD (Moving Average Convergence/Divergence)',
    d: 'Differenz zweier exponentieller Durchschnitte (12/26) plus Signallinie (9). Histogramm über null = Aufwärts-Momentum („bullisch"), unter null = Abwärts-Momentum („bärisch"). Kreuzungen gelten als Trendwechsel-Hinweise.',
  },
  signal: {
    t: 'Konfluenz-Signal',
    d: 'Das Gesamturteil des letzten Scans aus allen Stimmen (RSI, MACD, Bollinger, Prognose): BUY, SELL oder HOLD. Genau danach handelt die Auto-Engine, wenn sie eingeschaltet ist.',
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
    d: 'Blocks entries that run against the measured market state. The state comes from three free inputs: the S&P 500’s position relative to its 200-day average, the actual volatility of the last 20 days, and the VIX level. Three rules follow: in an UPTREND no short sales — you do not bet against the market you are in. Under STRESS (VIX at 30 or above, or very high volatility) no new entries at all, because prices then move in jumps and a stop is not filled at the stop price but at the next one. SIDEWAYS everything is allowed — without a trend there is no trend direction to violate. The trigger was a measurement in our own trading history: short sales in an uptrend lost across every kind of indicator — the common denominator was the direction, so the rule blocks the direction. Like the news veto it can only prevent trades, never trigger them: existing positions stay untouched, exits always free. If the market data is missing, “sideways” applies and nothing is blocked — a data outage must not become a silent trading ban.',
  },
  newsVeto: {
    t: 'News veto',
    d: 'Blocks NEW entries into a symbol for a few hours when a hard event is currently in the headlines for it: quarterly figures, a profit warning, litigation/investigation, a takeover or a change of leadership. The reason is mechanical: around such dates prices JUMP instead of moving — and RSI, MACD and Bollinger, on which the entry rests, say nothing about jumps. A stop loss does not protect against that either, because on a gap you sell at the next price, not at the stop price. The veto can only PREVENT trades, never trigger them — so at most it lowers fees. Exits always stay free: an open position is never held back because headlines are running. The sources are free news feeds (Yahoo Finance, Google News), scored by a word list — no AI, no cost. Ordinary coverage (“what analysts expect …”) does not trigger the veto; it takes a dated event with clear wording. If the feed fails, trading continues normally — the veto switches itself off, never the engine.',
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
    d: 'What actually ended the positions: a risk marker (stop loss, take profit, trailing stop) or a SIGNAL — i.e. because the indicators turned. The distribution says more than any single number: if almost everything sits under “signal”, stop and take are practically never reached. Then it is not your risk control that decides the outcome but the flip of a single indicator vote — a sign that positions are thrown out again too early.',
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
    d: 'The operating state of the last scan in plain words. The reason for this card: five mechanisms have a say in whether a trade happens — market traffic light, self-learning trade filter, news veto, cost threshold and leverage traffic light. All of them work out of sight, and “nothing is happening” looks exactly the same under a sharply set rule as under a broken system. Instead, this states WHAT was checked and why it was rejected — for instance “6 short sales rejected, the market is rising”. At the top the situation: market state with VIX and realised volatility, an upcoming economic event, the turn of the month, and how many trades the last scan triggered. In the middle the rejection reasons — only the ones that actually bit; a list of nothing but zeroes is not read twice. At the bottom, how many accounts are actively trading, how many run a quiet core holding, and which symbols currently sit in a short-squeeze setup (negative funding rate with a rising price — the constellation behind the sharpest upward moves). All numbers come from the scan itself, not from a second calculation: what stands here is what the engine really did.',
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
    d: 'Self-improvement of the forecast: every stored prediction is graded against what actually happened once its horizon has passed. The hit rate per lookback window decides which window future forecasts use — and whether the forecast may vote at all when trading: without a proven hit rate it does NOT vote, it has to earn its weight first. The card shows this bookkeeping — the combo statistics for daily and intraday forecasts plus “forecast vs. reality” for the selected symbol.',
  },
  fcCombo: {
    t: 'Combination statistics (self-tuning)',
    d: 'The system computes every forecast in parallel with several lookback windows as a “shadow” and grades them against reality once they mature. The window with the best realised hit rate (tiebreak: smallest MAE) drives the live forecast — that is the self-improvement. Important: as long as no hit rate is proven, the forecast does NOT vote at all when trading; it has to earn its weight first.',
  },
  mae: {
    t: 'MAE — mean absolute error',
    d: 'The average distance between forecast and realised price, as a percentage of the price. The smaller, the more precise the prediction. The MAE also calibrates the width of the confidence band.',
  },
  anEquity: {
    t: 'Account curve (realised)',
    d: 'The sum of all CLOSED trades, step by step. Deliberately something other than the performance curve: that one shows a value per day including the paper gains of open positions. This line jumps per trade and shows only what was actually realised — a paper gain on a still-open position is an opinion, not a result. The dashed line is the starting point: everything above it is earned, everything below it lost.',
  },
  anHisto: {
    t: 'Distribution of results',
    d: 'How many trades landed in which result band. The most important question only this chart answers: are the losses bigger than the gains? A strategy with a 60 % hit rate is ruinous if the few losers weigh three times as much as the many winners — you never see that in the hit rate alone. The buckets sit symmetrically around zero so that a gain and a loss never land in the same bar.',
  },
  anStunde: {
    t: 'Result by trading hour',
    d: 'When during the day the strategy earns or loses — in New York exchange time, not UTC (otherwise daylight saving would push the opening hour into a different bucket twice a year). A typical pattern: the first trading hour is the most volatile and, for many strategies, the most expensive. If your losses are concentrated in one time window, you do not need new indicators, you need a trading break.',
  },
  kollektiv: {
    t: 'Learned from all accounts',
    d: 'Which setting changes have proven themselves ACROSS ALL accounts. This knowledge does two things — and explicitly not two others. First it sets the order: there are more candidates than slots in your shadow fleet, and the ones proven elsewhere go first, so you arrive at the good setting sooner. Second, a new account starts from it instead of from the factory values. What it does NOT do: lower your burden of proof. Every adoption in YOUR account still needs the full statistical evidence from your own trades — because every account starts from a different setting, and what helped there can hurt here. And only counters flow in (how often tested, how often adopted), never individual trades or amounts from other users.',
  },
  kurzfrist: {
    t: 'Short-term forecast (intraday)',
    d: 'A projection of the next hour on 5-minute candles — recomputed on every scan. It learns in its own control loop (hourly grading against realised bars), separately from the daily forecast.',
  },
  sharpe: {
    t: 'Sharpe ratio',
    d: 'Return per unit of risk: the average daily return divided by its volatility, scaled to a year (√252). Above 1 counts as good, above 2 as very good. A high return with wild swings can have a WORSE Sharpe than a calm moderate one. In the portfolio, “30” and “90” stand for the last 30 or 90 daily snapshots. “--” means: not enough curve yet, or a completely flat series — deliberately not a flattering 0.',
  },
  maxdd: {
    t: 'Max drawdown',
    d: 'The deepest fall from an interim high, in percent — “how much did it hurt at worst?”. The most important number for staying the course: −30 % needs +43 % just to break even, −40 % already needs +67 %. Smaller is better, even at the cost of a slightly lower return.',
  },
  drawdown: {
    t: 'Drawdown history',
    d: 'For each day: the distance to the highest account balance up to that point, in percent. 0 means a new high; every downward excursion is an ongoing decline. This panel shares its time axis with the equity curve above — a trough in the curve and its drawdown sit exactly one below the other. That shows at a glance whether losses were short dips or long dry spells, and how long the recovery back to the high-water mark took. The “Max DD” figure in the table is computed by the server from the same series.',
  },
  fees: {
    t: 'Fees (commission + slippage)',
    d: '0.1 % order commission plus 5 basis points of slippage (the difference between the quoted and the actual fill price). This is not merely displayed here — the paper broker REALLY charges it, on the same terms as the backtest.',
  },
  gesamtPnl: {
    t: 'Total P&L — what this number measures (and what it does not)',
    d: 'Total P&L = equity (live) − capital base. The base is RE-ANCHORED on a portfolio adoption or a reset — the number then counts only from that cut, and it is the sum of “realised” (closed since the cut) and “open” (the unrealised standing of open positions; only a real result once closed). The trade analysis answers a DIFFERENT question: what did the closed trades produce inside the chosen time window — including the ones before the cut. So both can be right at the same time and look contradictory: old closings in the red, open positions currently in the green. The most honest single value stays equity (live) — the balance identical to the broker’s.',
  },
  equityCurve: {
    t: 'Equity curve',
    d: 'The course of your ENTIRE portfolio value (cash plus all open positions at that day’s price). One point is written down once a day after the US close — unlike the live display, the curve therefore cannot be made to look “nice” by an interim reading. It is the most honest single chart there is about a strategy: individual winners do not count, only whether the line rises over weeks.',
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
  fillReibung: {
    t: 'Execution friction',
    d: 'The measured gap between the price the engine decided at and the price the broker actually filled — in basis points (1 bp = 0.01%), split into entry and exit. This answers whether stock entries should run as limit (maker) orders: below 5 bp the switch is not worth it, above 10 bp it is due. The color on the US-stock entry shows exactly this rule.',
  },
  kapitalEinsatz: {
    t: 'Capital at work',
    d: 'How much of the account is actually working — and in which part. “Invested” is the market value of all positions relative to equity, split into the calm momentum core and the active engine part; the rest is cash. The goal is NOT zero cash: with the market filter in downtrend mode the core deliberately sits in cash — that is protection, not idleness. Persistently high cash in an uptrend, however, means the money is not working; since the core top-up (Aug 20) the weekly cycle buys held positions back toward their target weight.',
  },
  kosten: {
    t: 'Friction (trading costs)',
    d: 'Every round trip costs commission plus slippage — on the buy AND on the sell. What matters is the “headroom over costs”: the average winning move before fees, divided by those costs. Below 2 it is mostly the broker earning, because more than half of every winning move then goes into friction. Short timeframes produce small moves — which is why more trading frequency strictly requires enough movement per trade, otherwise it merely accelerates the loss. “Avg. gross gain” and “avg. gross loss” show the pure price moves without fees, so it becomes visible whether the strategy itself works.',
  },
  momentum: {
    t: 'Momentum ranking',
    d: 'Instead of a fixed watchlist, the entire catalogue is sorted by a single number: the return of the last twelve months, with the most recent month NOT counted. The reason for the omission: over a one-month horizon prices tend to revert, the actual momentum sits in the months before it — counting the last month mixes two opposing effects. The strongest eight are bought, equally weighted, and only while the benchmark index sits above its 200-day line. Below it the portfolio stays entirely flat: momentum strategies break down almost exclusively during recoveries AFTER market crashes, and this filter is the cheapest known insurance against that. Rebalancing is weekly, not daily — every rebalance costs fees, and that is exactly what the old strategy foundered on. The approach is the best-documented anomaly in the finance literature (Jegadeesh/Titman 1993; Asness/Moskowitz/Pedersen 2013 across eight asset classes). Here it runs as a shadow portfolio first — the switch only happens once it beats the running strategy with statistical proof.',
  },
  autotuner: {
    t: 'Auto-tuner',
    d: 'The system continuously tries your setting against variants of it — each variant changes exactly ONE value (e.g. the minimum holding period) and runs its own shadow account on the same prices, without real money. After enough closed trades they are compared: only if a variant performs demonstrably better in statistical terms (Welch t-test, p < 0.05, plus a noticeable margin) is it adopted — at most one change per day, so that afterwards it is clear what helped. Why shadow accounts and not a backtest over the past: a parameter grid reliably finds the combination that best explains past noise, and fails afterwards. The fleet, by contrast, trades on prices nobody knew at the moment of the decision. Position size, stop loss and take profit are NEVER touched by the tuner — risk control stays with you.',
  },
  tradejournal: {
    t: 'Trade journal',
    d: 'Every booked trade — engine or manual — automatically gets a journal entry with the frozen snapshot of the signal: which indicators voted how, how high the confluence was, what the regime said, whether the forecast joined in. Frozen because the same indicators stand differently five minutes later — from the trade history alone the WHY can no longer be reconstructed. Your job is the assessment: grade A (by the rules and clean) through D (mistake identified), plus a note. You cannot change the facts themselves — a journal whose numbers can be prettied up afterwards would be worthless as a learning tool. The value appears on re-reading: losers graded A are bad luck, losers graded D are a pattern.',
  },
  struktursuche: {
    t: 'Structure search',
    d: 'The auto-tuner turns the DIALS of your strategy (e.g. holding period) — the structure search works on the BLUEPRINT: it changes the rule structure itself, one building block a day (flip a comparison, drop a branch, add a condition). Every candidate is walk-forward tested: it must beat the incumbent in the search window AND earn afterwards in a test window that was not allowed to take part in the search. On top comes the deflated Sharpe hurdle (Bailey/López de Prado): whoever tries many variants finds “good” ones by chance — the bar accounts for how many attempts have already run, and it rises with each further one. That is why “rejected” is the normal case here and not a defect. A winner trades exclusively on a shadow account with fresh virtual capital; whether it ever runs real money is your decision in the studio via “Promote”. The search is switched off together with the auto-tuner — it is ONE concept: the system improves itself, but only with proof.',
  },
  depotVerlauf: {
    t: 'Portfolio history, decomposed',
    d: 'An equity curve shows THAT the portfolio rose or fell — never WITH WHAT. Two accounts with the same curve can have got there in completely different ways: one from twenty small gains, the other from one lucky hit and nineteen losses. Yet every decision about what to change in the system hangs on exactly that. This chart decomposes the curve: the horizontal dashed line is your portfolio on the first day of the window; every coloured area is a symbol (or, toggled, a single trade) with its result accumulated since that day. The areas form a staircase: winners build the mountain up, losers carry it back down, and finally the book value of the still-open positions corrects to the actual level — the part that moves daily with the price and has decided nothing yet. Every area starts where the previous one ends, which is why the staircase lands exactly on the portfolio line every day. A divergence between line and staircase would therefore be visible to the naked eye and a computational error, not a display detail. (The first draft stacked gains upwards and losses downwards — pretty, but the portfolio line then sat somewhere in between and the statement could not be checked against the picture.) Trades closed before the window are already inside the reference line and do not appear again as an area; the footer says how many those are.',
  },
  haltedauer: {
    t: 'How long to hold?',
    d: 'The most expensive open question in the system — and it cannot be answered by watching: a holding period of five days yields one data point per week and symbol, so a meaningful comparison would take years. This card therefore takes the answer from the STORED history: for every trading day in the past the signal is recomputed — only from prices up to that day, never with a glance forward — and then it checks what an exit after 1, 2, 3, 5 or 10 trading days would have brought. Costs are deducted true to the asset class, and a result is only counted if the evaluation day really lies in the past with no data gap in between. Rows with too few observations stay pale and do not count — a recommendation from three cases would be more dangerous than none. The separate buy and sell columns are the most honest part: if only the buy side earns, you are measuring the rising market and not the ability of the signal; if both sides earn, it is a real edge. The card changes NOTHING about your strategy by itself — it lays out the numbers, the decision stays yours.',
  },
  erkenntnisse: {
    t: 'What the system has learned',
    d: 'Every other number on the dashboard is a snapshot: the heartbeat is overwritten every five minutes, the daily metrics every evening. That only ever shows the state NOW — never what has turned out to be true over weeks. This card is the memory for that: a fixed, small set of hypotheses is checked against the measured data every evening and receives one of three states — holds, refuted, or waiting for data. Below a minimum n, NOTHING is claimed on purpose; a chronicle that judges at five trades teaches noise. Every hypothesis carries its supporting figures and the day since which it has been in that state, and on a change the old wording stays visible — that very moment, when an assumption tips over, is the actual insight. Everything here is derived deterministically from existing measurements, without AI and without cost.',
  },
  aibericht: {
    t: 'Daily assessment (AI)',
    d: 'Once in the evening a language model reads the insight chronicle above and the aggregated trading figures, and writes a short assessment from them: which findings are connected, what is the most likely common cause, what would be the next step? That is exactly the part code cannot do — condensing numbers and testing hypotheses is handled deterministically and free of charge by the cards above. Important: the report is a text NEXT TO the machine, not a voice INSIDE it. It triggers no order, changes no setting and promotes no strategy; every such decision still requires statistical evidence. The model sees exclusively the system’s own measurements — no headlines, no external texts, nothing from the web — so that no foreign instructions can be smuggled in through the input. One call per day, with a monthly cap and a hard token limit; without a stored API key the line stays empty and everything else keeps running.',
  },
  kaufkraft: {
    t: 'Buying power afterwards',
    d: 'Your remaining cash after this order including all costs. Red means: the order exceeds your balance and would be rejected by the broker.',
  },
  rsi: {
    t: 'RSI (Relative Strength Index)',
    d: 'A momentum oscillator from 0–100 over 14 periods: below 30 oversold (a recovery is more likely), above 70 overbought (a pullback is more likely). Not a timing oracle — strong in combination with other signals.',
  },
  macd: {
    t: 'MACD (Moving Average Convergence/Divergence)',
    d: 'The difference between two exponential averages (12/26) plus a signal line (9). A histogram above zero = upward momentum (“bullish”), below zero = downward momentum (“bearish”). Crossovers count as hints of a trend change.',
  },
  signal: {
    t: 'Confluence signal',
    d: 'The overall verdict of the last scan across all votes (RSI, MACD, Bollinger, forecast): BUY, SELL or HOLD. This is exactly what the auto engine acts on when it is switched on.',
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
