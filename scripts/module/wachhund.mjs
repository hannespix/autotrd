/**
 * Nächtlicher Wächter: Urteil über den Zustand der Plattform — als reine
 * Funktion, damit sie prüfbar ist.
 *
 * Was hier NICHT passiert: irgendetwas ändern. Der Wächter schaut und
 * berichtet. Wer nachts unbeaufsichtigt am Handelspfad schraubt, produziert
 * über Wochen überzeugende Begründungen dafür, ein Gate zu lockern — genau
 * die Selektionsverzerrung, gegen die die Gates gebaut sind.
 */

/** Ab wann ein Champion als alt gilt. Der Optimierer läuft Mo–Fr; über ein
 *  Wochenende sind drei Tage normal. */
export const CHAMPION_WARN_TAGE = 4;
export const CHAMPION_FEHLER_TAGE = 7;

/**
 * @param {{
 *   jetztMs: number,
 *   health: {lastRunAt?: string} | null,
 *   champion: {updatedAt?: number, symbols?: Record<string, unknown>, noTrade?: Record<string, unknown>} | null,
 *   engineConfig: {universe?: {symbols?: string[], benchmark?: string}, timeframe?: number} | null,
 *   repoSymbols: string[],
 *   repoPool: string[],
 *   repoBenchmark?: string,
 *   repoMaxSymbols: number,
 *   repoTimeframe: number,
 *   nutzer: {uid: string, engineAn: boolean, live: boolean}[],
 *   herzschlagUrteil: {ok: boolean, text?: string},
 * }} e
 */
export function beurteile(e) {
  /** @type {{stufe: 'fehler'|'warnung'|'ok', text: string}[]} */
  const befunde = [];
  const sage = (stufe, text) => befunde.push({ stufe, text });

  // ── Takt
  if (e.herzschlagUrteil.ok) sage('ok', 'Takt schlägt.');
  else sage('fehler', `Takt: ${e.herzschlagUrteil.text ?? 'kein Heartbeat'}`);

  // ── Champion
  if (!e.champion || typeof e.champion.updatedAt !== 'number') {
    sage('fehler', 'Kein meta/champion — ohne Champion handelt niemand.');
  } else {
    const tage = (e.jetztMs - e.champion.updatedAt) / 86_400_000;
    const gehandelt = Object.keys(e.champion.symbols ?? {}).length;
    const nicht = Object.keys(e.champion.noTrade ?? {}).length;
    if (tage > CHAMPION_FEHLER_TAGE) sage('fehler', `Champion ist ${tage.toFixed(1)} Tage alt — der Optimierer läuft nicht.`);
    else if (tage > CHAMPION_WARN_TAGE) sage('warnung', `Champion ist ${tage.toFixed(1)} Tage alt.`);
    else sage('ok', `Champion ${tage.toFixed(1)} Tage alt: ${gehandelt} Symbol(e) handeln, ${nicht} auf noTrade.`);
    if (gehandelt === 0) sage('warnung', 'Kein Symbol besteht die Gates — es wird nichts gehandelt. Das ist ein zulässiges Ergebnis, kein Fehler.');
  }

  // ── Universum: Das Universum wechselt nächtlich (Auswahl nach Liquidität),
  // deshalb ist Gleichheit mit der Config KEIN Kriterium mehr. Geprüft wird,
  // dass die Engine nur Symbole handelt, die im Repo als Kandidaten stehen —
  // der Pool ändert sich weiterhin nur per Commit. Alles andere wäre eine
  // Hintertür, über die eine kaputte oder untergeschobene Auswahl die
  // Plattform auf beliebige Werte umstellt.
  const pool = new Set(e.repoPool && e.repoPool.length > 0 ? e.repoPool : e.repoSymbols);
  const gehandeltSyms = [...(e.engineConfig?.universe?.symbols ?? [])].sort();
  const fremd = gehandeltSyms.filter((s) => !pool.has(s));
  if (gehandeltSyms.length === 0) {
    sage('fehler', 'meta/engineConfig hat kein Universum.');
  } else if (fremd.length > 0) {
    sage('fehler', `Die Engine handelt Symbole außerhalb des Kandidatenpools: ${fremd.join(', ')}. Der Pool ändert sich nur per Commit.`);
  } else if (gehandeltSyms.length > (e.repoMaxSymbols ?? 30)) {
    sage('fehler', `Die Engine handelt ${gehandeltSyms.length} Symbole, erlaubt sind ${e.repoMaxSymbols ?? 30}.`);
  } else if (e.repoBenchmark && !gehandeltSyms.includes(e.repoBenchmark)) {
    sage('fehler', `Benchmark ${e.repoBenchmark} fehlt im gehandelten Universum — ohne ihn greift kein Marktfilter.`);
  } else if (e.engineConfig?.timeframe !== e.repoTimeframe) {
    sage('fehler', `Zeitrahmen weicht ab: Engine ${String(e.engineConfig?.timeframe)}, Repo ${e.repoTimeframe}.`);
  } else {
    sage('ok', `Universum im Rahmen: ${gehandeltSyms.length} von ${pool.size} Kandidaten, ${e.repoTimeframe} min.`);
  }

  // ── Deckung: Hat der Champion zu jedem gehandelten Symbol ein Urteil?
  // Sonst hat die Auswahl ein Symbol nachgeschoben, das der Optimierer nie
  // gesehen hat — es würde nicht gehandelt, aber die Reihenfolge im
  // nächtlichen Lauf wäre kaputt.
  if (e.champion && gehandeltSyms.length > 0) {
    const beurteilt = new Set([...Object.keys(e.champion.symbols ?? {}), ...Object.keys(e.champion.noTrade ?? {})]);
    const ohne = gehandeltSyms.filter((s) => !beurteilt.has(s));
    // Fehler, nicht Warnung: Das ist die einzige verbliebene Brücke zwischen
    // „gemessen" und „gehandelt", seit das Universum nächtlich wechselt. Klafft
    // sie, lief der nächtliche Lauf halb durch — und niemand sieht es sonst.
    if (ohne.length > 0) sage('fehler', `Gehandeltes Symbol ohne Champion-Urteil — Optimierer und Universum passen nicht zusammen: ${ohne.join(', ')}.`);
  }

  // ── Nutzer
  const an = e.nutzer.filter((n) => n.engineAn);
  const live = an.filter((n) => n.live);
  sage('ok', `${an.length} von ${e.nutzer.length} Konten mit eingeschalteter Engine.`);
  if (live.length > 0) sage('warnung', `${live.length} Konto/Konten im ECHTGELD-Modus: ${live.map((n) => n.uid).join(', ')}`);

  const fehler = befunde.filter((b) => b.stufe === 'fehler');
  return { befunde, ok: fehler.length === 0, fehler: fehler.length, warnungen: befunde.filter((b) => b.stufe === 'warnung').length };
}

/** Markdown für die Job-Zusammenfassung. */
export function alsMarkdown(urteil) {
  const zeichen = { fehler: '🔴', warnung: '🟡', ok: '🟢' };
  const zeilen = ['## Wächter', ''];
  zeilen.push(urteil.ok ? '**Nichts Kaputtes gefunden.**' : `**${urteil.fehler} Befund(e), die Aufmerksamkeit brauchen.**`);
  zeilen.push('');
  for (const b of urteil.befunde) zeilen.push(`- ${zeichen[b.stufe]} ${b.text}`);
  return zeilen.join('\n');
}
