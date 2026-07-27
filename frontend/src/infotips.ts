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
 * (das Studio re-rendert komplette Karten).
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
    t: 'Watchlist',
    d: 'Die Symbole, die die Auto-Engine mit voller Tiefe handelt und scannt (max. 20 — der Deckel schützt die Scan-Laufzeit, nicht die Daten: Kurse bekommt der ganze Katalog). Nur Katalog-Symbole in Yahoo-Schreibweise, z. B. ^NDX statt NDX.',
  },
  // ── Prognose ──
  useForecast: {
    t: 'Prognose als Stimme',
    d: 'Ob die hauseigene Zukunfts-Prognose als zusätzliche gewichtete Stimme in die Konfluenz einfließt. Das Herzstück: Die Prognose lernt aus jeder realisierten Vorhersage — und ihr Stimmgewicht folgt ihrer ECHTEN Trefferquote (Kante über den Münzwurf).',
  },
  forecastWeight: {
    t: 'Prognose-Gewicht',
    d: 'Wie viele Stimmen die Prognose maximal in die Konfluenz einbringt (RSI/MACD/Bollinger zählen je 1). Das System skaliert dieses Gewicht automatisch mit der realisierten Trefferquote: 50 % Treffer (Münzwurf) ⇒ Stimme 0, 75 % ⇒ halbes Gewicht, 100 % ⇒ volles Gewicht.',
  },
  forecastThreshold: {
    t: 'Prognose-Schwelle',
    d: 'Erst wenn die prognostizierte Kursänderung bis zum Horizont-Ende (±) über dieser Prozent-Schwelle liegt, stimmt die Prognose mit. Filtert Mini-Signale nahe der Nulllinie heraus.',
  },
  fcBand: {
    t: 'Prognose-Band (Konfidenz)',
    d: 'Der gestrichelte Korridor um die Prognose-Linie. Er wird aus der REALISIERTEN Fehlerverteilung vergangener Prognosen kalibriert (MAE·√(π/2)): War das System in der Realität ungenauer als die Theorie, wird das Band ehrlich breiter. ±1σ heißt: ~68 % der Fälle sollten innerhalb liegen.',
  },
  fcCombo: {
    t: 'Kombi-Statistik (Self-Tuning)',
    d: 'Das System rechnet jede Prognose parallel mit mehreren Parameter-Kombis (Sentiment-Gewicht w × Lookback-Fenster) als „Schatten" mit und bewertet sie nach Ablauf gegen die Realität. Die Kombi mit der besten realisierten Trefferquote (Tiebreak: kleinste MAE) steuert die Live-Prognose — das ist die Selbstverbesserung.',
  },
  mae: {
    t: 'MAE — Mittlerer absoluter Fehler',
    d: 'Durchschnittlicher Abstand zwischen Prognose und eingetretenem Kurs, in Prozent des Kurses. Je kleiner, desto präziser die Vorhersage. Die MAE kalibriert auch die Breite des Konfidenz-Bands.',
  },
  kurzfrist: {
    t: 'Kurzfrist-Prognose (Intraday)',
    d: 'Projektion der nächsten Stunde auf 5-Minuten-Kerzen — bei jedem Scan neu berechnet. Sie lernt in einem eigenen Regelkreis (stündliche Bewertung gegen realisierte Bars) getrennt von der Tages-Prognose.',
  },
  // ── Regel-Editor (Studio) ──
  link: {
    t: 'Verknüpfung der Regeln',
    d: '„all" = ALLE Regeln müssen zutreffen (UND). „any" = EINE reicht (ODER). „weighted" = jede Regel bringt ihr Gewicht ein, gehandelt wird ab Erreichen des Thresholds — die flexibelste Form, weil starke Signale schwache überstimmen können.',
  },
  threshold: {
    t: 'Threshold (Schwellwert)',
    d: 'Die Mindestsumme an Gewichten, die zutreffende Regeln zusammen erreichen müssen, damit das Signal auslöst. Threshold 2 mit drei Regeln à Gewicht 1 heißt: mindestens zwei müssen gleichzeitig zutreffen.',
  },
  weight: {
    t: 'Gewicht einer Regel',
    d: 'Wie viel diese Regel zur Threshold-Summe beiträgt, wenn sie zutrifft. Wichtigen Signalen (z. B. Prognose) gibt man mehr Gewicht als Feinjustierern.',
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
  'node:sentiment': {
    t: 'Regel: Sentiment',
    d: 'Nutzt die Stimmung aus News-Schlagzeilen (−1 bis +1, lexikonbasiert). „Sentiment > 0.2" heißt: nur kaufen, wenn die Nachrichtenlage klar positiv ist.',
  },
  'node:newsEvent': {
    t: 'Regel: News-Ereignis',
    d: 'Trifft zu, wenn heute ein getaggtes Ereignis vorliegt (Earnings, Analysten-Rating, M&A …). Für Strategien, die auf Nachrichten reagieren — oder sie bewusst meiden.',
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
  winrate: {
    t: 'Winrate (Trefferquote)',
    d: 'Anteil der Trades mit Gewinn. Allein wenig aussagekräftig: 90 % Winrate mit einem Riesen-Verlusttrade kann schlechter sein als 40 % mit großen Gewinnern. Immer zusammen mit Rendite und Drawdown lesen.',
  },
  buyhold: {
    t: 'Buy & Hold-Vergleich',
    d: 'Was einfaches Kaufen-und-Liegenlassen im selben Zeitraum gebracht hätte — die ehrliche Messlatte: Eine Strategie muss Buy & Hold nach Kosten schlagen, sonst lohnt der Aufwand nicht.',
  },
  equity: {
    t: 'Equity',
    d: 'Der Gesamtwert des Kontos: Cash plus aktueller Marktwert aller offenen Positionen (mark-to-market). Die Equity-Kurve zeigt die Entwicklung über die Zeit.',
  },
  divergenz: {
    t: 'Divergenz (A/B-Duell)',
    d: 'Der Rendite-Abstand zwischen deinem echten Paper-Wallet (A) und der Schatten-Strategie (B) in Prozentpunkten — beide mit identischen Gebühren. Liegt B dauerhaft vorn, ist „Befördern" einen Blick wert.',
  },
  modus: {
    t: 'Modus: paper vs. shadow',
    d: '„paper" handelt dein echtes Paper-Wallet. „shadow" beobachtet nur: ein virtuelles 25.000-$-Konto führt Buch, was die Strategie GETAN HÄTTE — risikofrei testen, mit echten Marktdaten und echten Gebühren.',
  },
  backtest: {
    t: 'Backtest',
    d: 'Simulation der Strategie über 1 Jahr historischer Tageskerzen inkl. Kosten (0,1 % Kommission + 5 bp Slippage). Streng kausal: Der Kontext an Tag i sieht ausschließlich Daten bis Tag i — kein Blick in die Zukunft. Vergangenheit garantiert keine Zukunft, aber sie entlarvt kaputte Ideen.',
  },
  sweep: {
    t: 'Parameter-Sweep',
    d: 'Backtestet automatisch ein Raster aus zwei Parametern (X × Y, bis 60 Kombis) und zeigt die Rendite als Heatmap. Vorsicht Overfitting: Der beste Punkt der Vergangenheit ist nicht automatisch der beste der Zukunft — robuste REGIONEN schlagen einzelne Spitzenwerte.',
  },
  preview: {
    t: 'Live-Vorschau',
    d: 'Zeigt sofort, wo deine Regeln im letzten Jahr gekauft (▲) und verkauft (▼) hätten — rein clientseitig, ohne Kosten, ohne Prognose. Zum schnellen Gefühl-Bekommen; die harte Wahrheit liefert der Backtest.',
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
