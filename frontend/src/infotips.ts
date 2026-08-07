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

export const INFO: Record<string, { t: string; d: string }> = {
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
    d: 'DIE LIVE-REIFE ist die wichtigste Zeile dieser Karte. Sie setzt die Regel um, dass erst umgeschaltet wird, wenn das System nachweislich Gewinn schreibt — und zwar nicht als Merkzettel, sondern als Sperre im Ausführungspfad. Selbst wenn beide Freigaben stehen, bleibt der Handel im eigenen Buch, solange ein Kriterium fehlt. Der Grund für diese Härte: Der Moment, in dem jemand den Schalter gegen die Datenlage umlegen will, ist genau der Moment, in dem er die Datenlage am wenigsten sehen will. FÜNF KRITERIEN: (1) Stichprobe ≥ 200 Trades — bei rund 20 % Trefferquote schwankt der Anteil über 50 Trades noch um mehr als die Hälfte seines Werts; ein Profitfaktor darunter ist Rauschen. (2) Profitfaktor ≥ 1,20, nicht 1,00 — Papierhandel unterschätzt die Wirklichkeit systematisch (Teilausführungen, echte Slippage in dünnen Büchern, verpasste Kurse zwischen Signal und Order); wer bei exakt 1,0 umschaltet, schaltet live auf darunter. (3) Gebührenanteil ≤ 50 % des Bruttoergebnisses — darüber trägt das System zwar rechnerisch, aber jede Verschlechterung der Ausführung kippt es sofort. (4) Nettoergebnis über null. (5) Messstrecke ≥ 30 Tage — Gewinn über drei Tage ist Wetter, nicht Klima; die Strecke zählt ab dem letzten Konto-Reset, denn wer eine schlechte Strecke wegwirft, behält nicht ihre Reife. DIE KANTE JE TRADE darunter ist die Zahl, an der alles hängt: Was ein Trade im Mittel einbringt, gegen das, was er kostet. Deckung unter 1 heißt, dass jeder einzelne Trade im Erwartungswert Geld verliert — dann hilft keine bessere Marktphase und kein Glück, sondern nur weniger und bessere Trades. Prüft die Verbindung zum Broker (Alpaca), OHNE eine Order zu senden — wer die Anbindung erst beim ersten Trade testet, testet sie mit Geld. WARUM ALPACA: weil es als einziger Anbieter ein Papierkonto mit derselben Schnittstelle betreibt wie das Echtgeldkonto; nur die Adresse unterscheidet sich. Damit lässt sich die ganze Kette — Schlüssel, Orderformat, Abgleich, Fehlerfälle — an einem echten Konto durchspielen, ohne einen Cent zu riskieren. DREI SCHALTER, ALLE DREI NÖTIG: (1) Schlüssel hinterlegt — nur in der Serverumgebung, nie in der Datenbank, nie im Browser. (2) Strategie auf Echtgeld — der Schalter in deinen Einstellungen. (3) Umgebungs-Freigabe ALPACA_ALLOW_LIVE — ein zweiter Schalter an einem anderen Ort, an den keine Oberfläche herankommt. Fehlt einer, läuft alles weiter im eigenen Buch. Das ist Absicht: Ein verirrter Klick soll kein echtes Geld bewegen können, und ein versehentlich gesetztes Env auch nicht. DER ABGLEICH ist die wichtigste laufende Kontrolle im Echtgeldbetrieb, und er prüft in beide Richtungen: Eine Position, die nur beim Broker liegt, ist ein Risiko, von dem die Engine nichts weiß — sie wird es nie schließen. Eine Position, die nur im eigenen Buch steht, lässt die Engine mit einer Deckung rechnen, die es nicht gibt. Long und Short werden dabei unterschieden, auch wenn die Stückzahl gleich ist. GEGEN DOPPELORDERS: Jede Order trägt eine Kennung aus dem auslösenden Scan. Läuft eine Cloud Function nach einem Fehler erneut an, erkennt der Broker die Kennung wieder und lehnt die Wiederholung ab — statt eine zweite Position aufzumachen, die niemand wollte.',
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
    d: 'Lässt den täglichen Lauf die Gewichte selbst verstellen — in Schritten von 0,25 auf den Vorschlag zu, nicht in einem Sprung. WARUM SCHRITTE: Eine Messung ist eine Momentaufnahme. Springt das Gewicht bei jeder Auswertung auf den vollen Vorschlag, schwingt es zwischen den Wochen hin und her, und jedes Umschalten kostet Trades, die zur alten Einstellung gehörten. DIE EINE AUSNAHME: Wer strukturell verbrennt (mehr als 0,1 % Verlust je Dollar über mindestens 30 Trades), wird sofort auf 0 gesetzt statt in Etappen — ein Fehlalarm kostet dort nur entgangene Chancen, das Zögern kostet echtes Geld, und der Schatten hält den Rückweg offen. EVIDENZ VOR MEINUNG: Unter 30 Trades rührt die Automatik ein Gewicht nicht an, weder nach oben noch nach unten und auch nicht zurück auf den Standardwert. Eine Klasse mit einem einzigen Trade würde sonst eine Kapitalentscheidung auslösen. DER SCHATTEN darf nur ZURÜCKHOLEN, nie abschalten: Ihm fehlt der Stop, der reale Verluste kappt, also ist eine negative Schatten-Kante kein Beleg für einen negativen Trade-Ertrag — eine positive dagegen ein Grund, es mit halbem Gewicht noch einmal zu versuchen. Jede Änderung landet mit Begründung im Journal; ein Gewicht, das sich von selbst bewegt, muss erklärbar bleiben.',
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
  // ── Trade-Ticket ──
  fees: {
    t: 'Gebühren (Kommission + Slippage)',
    d: '0,1 % Ordergebühr plus 5 Basispunkte Slippage (Abweichung zwischen angezeigtem und tatsächlichem Ausführungskurs). Wird hier nicht nur angezeigt, sondern vom Paper-Broker WIRKLICH berechnet — dieselben Konditionen wie im Backtest.',
  },
  // ── Portfolio-Kennzahlen (M12) ──
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
  return `<button type="button" class="ibtn" data-info="${key}" aria-label="Erklärung: ${info.t}" title="Was bedeutet das?">ⓘ</button>`;
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
