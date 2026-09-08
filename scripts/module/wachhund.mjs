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
 *   engineConfig: {universe?: {symbols?: string[]}, timeframe?: number} | null,
 *   repoSymbols: string[],
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

  // ── Config-Drift: handelt die Engine, was der Optimierer gemessen hat?
  const gemessen = [...e.repoSymbols].sort();
  const gehandeltSyms = [...(e.engineConfig?.universe?.symbols ?? [])].sort();
  if (gehandeltSyms.length === 0) {
    sage('fehler', 'meta/engineConfig hat kein Universum.');
  } else if (JSON.stringify(gemessen) !== JSON.stringify(gehandeltSyms)) {
    const nurEngine = gehandeltSyms.filter((s) => !gemessen.includes(s));
    const nurRepo = gemessen.filter((s) => !gehandeltSyms.includes(s));
    sage(
      'fehler',
      'Universum weicht ab — die Engine handelt etwas anderes, als der Optimierer gemessen hat. ' +
        `Nur in der Engine: ${nurEngine.join(', ') || '—'}; nur im Repo: ${nurRepo.join(', ') || '—'}.`,
    );
  } else if (e.engineConfig?.timeframe !== e.repoTimeframe) {
    sage('fehler', `Zeitrahmen weicht ab: Engine ${String(e.engineConfig?.timeframe)}, Repo ${e.repoTimeframe}.`);
  } else {
    sage('ok', `Universum deckungsgleich (${gemessen.length} Symbole, ${e.repoTimeframe} min).`);
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
