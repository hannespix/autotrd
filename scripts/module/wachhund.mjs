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
 *   champion: {updatedAt?: number, symbols?: Record<string, unknown>, noTrade?: Record<string, unknown>, basis?: unknown} | null,
 *   engineConfig: {universe?: {symbols?: string[], benchmark?: string, candidates?: string[]}, timeframe?: number, strategy?: {basis?: boolean}} | null,
 *   repoSymbols: string[],
 *   repoPool: string[],
 *   repoBenchmark?: string,
 *   repoMaxSymbols: number,
 *   repoTimeframe: number,
 *   repoBasisUniverse?: string[],
 *   repoBasisSchalter?: boolean,
 *   minKorb?: number,
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

  // ── Basis-Stufe (Prüfbefund M11): Der Korb des Blocks `basis` ist das
  // gehandelte Universum der Basis — er umgeht `engineConfig.universe.symbols`.
  // Deshalb hier gegen den Pool des Repos (der sich nur per Commit ändert) und
  // gegen den vorregistrierten Korb; und der Bericht sagt, ob die Basis
  // bestanden hat, welche Symbole sie handelt und mit welcher Position.
  beurteileBasis(e, pool, sage);

  // ── Nutzer
  const an = e.nutzer.filter((n) => n.engineAn);
  const live = an.filter((n) => n.live);
  sage('ok', `${an.length} von ${e.nutzer.length} Konten mit eingeschalteter Engine.`);
  if (live.length > 0) sage('warnung', `${live.length} Konto/Konten im ECHTGELD-Modus: ${live.map((n) => n.uid).join(', ')}`);

  const fehler = befunde.filter((b) => b.stufe === 'fehler');
  return { befunde, ok: fehler.length === 0, fehler: fehler.length, warnungen: befunde.filter((b) => b.stufe === 'warnung').length };
}

/** Untergrenze des Basis-Korbs, unter der die Rang-Strategie stillhält (src/strategy/crossSectionalMomentum.ts, MIN_KORB). */
export const BASIS_MIN_KORB = 8;

/**
 * Basis-Block der Champion-Datei beurteilen. Kein Block ⇒ nur eine Zeile, wenn
 * das Repo einen Korb vorregistriert hat (dann fehlt die Messung).
 * @param {Parameters<typeof beurteile>[0]} e
 * @param {Set<string>} pool
 * @param {(stufe: 'fehler'|'warnung'|'ok', text: string) => void} sage
 */
function beurteileBasis(e, pool, sage) {
  const b = e.champion && typeof e.champion.basis === 'object' && e.champion.basis !== null ? /** @type {Record<string, unknown>} */ (e.champion.basis) : null;
  const repoKorb = e.repoBasisUniverse ?? [];
  if (!b) {
    if (repoKorb.length > 0) sage('warnung', `Basis-Stufe: Repo nennt einen Basis-Korb (${repoKorb.length} Symbole), meta/champion hat keinen Block basis — die Messung fehlt noch.`);
    return;
  }
  const symbole = Array.isArray(b.symbols) ? b.symbols.filter((s) => typeof s === 'string') : [];
  const pass = b.pass === true;
  const pct = typeof b.positionPct === 'number' ? `${b.positionPct} %` : 'ohne positionPct';
  const label = typeof b.label === 'string' ? b.label : String(b.strategy ?? '?');
  const globalAus = e.engineConfig?.strategy?.basis === false || e.repoBasisSchalter === false;
  const fremd = symbole.filter((s) => !pool.has(s));
  if (b.version !== 1) sage('fehler', `Basis-Stufe: Block basis mit Version ${String(b.version)} — unlesbar, die Basis handelt nicht.`);
  if (fremd.length > 0) sage('fehler', `Basis-Stufe: Korb-Symbole außerhalb des Kandidatenpools: ${fremd.join(', ')}. Der Pool ändert sich nur per Commit; der Takt verwirft sie.`);
  if (repoKorb.length > 0) {
    const nichtVorregistriert = symbole.filter((s) => !repoKorb.includes(s));
    const fehlend = repoKorb.filter((s) => !symbole.includes(s));
    if (nichtVorregistriert.length > 0) sage('fehler', `Basis-Stufe: Korb-Symbole, die nicht in optimizer.basisUniverse stehen: ${nichtVorregistriert.join(', ')}.`);
    if (fehlend.length > 0) sage('warnung', `Basis-Stufe: vorregistrierte Korb-Symbole ohne Messung im Block (keine Bars?): ${fehlend.join(', ')}.`);
  }
  const min = e.minKorb ?? BASIS_MIN_KORB;
  if (symbole.length < min) sage('warnung', `Basis-Stufe: Korb hat ${symbole.length} Symbole, unter ${min} rangiert nichts — die Basis hält still.`);
  const schalter = globalAus ? ' — plattformweit AUS (keine neuen Einstiege)' : '';
  sage('ok', `Basis-Stufe „${label}": ${pass ? 'bestanden' : 'NICHT bestanden (keine neuen Einstiege)'}, ${symbole.length} Symbole (${symbole.join(', ')}), Position ${pct}${schalter}.`);
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
