/**
 * „Warum hat die Engine dieses Symbol heute nicht gehandelt?"
 *
 * Der reine Teil: Journal-Einträge sortieren, gruppieren und lesbar machen.
 * Kein Firestore, kein Netz — damit er testbar ist (scripts/warum.mjs ist die
 * Schale drumherum).
 *
 * ── Warum es das gibt ─────────────────────────────────────────────────────
 *
 * Am 16.09.2026 sagte das Symbolprofil für BAC einen Einstieg voraus, die
 * Engine stellte keinen, und in Cloud Logging stand nichts dazu. Grund: Die
 * Blockier-Gründe aus `decide()` gehen NICHT ins Log, sondern als
 * `decision`-Ereignisse ins Firestore-Journal je Nutzer
 * (functions/src/engine/journal.ts, `users/{uid}/journal`). Eine Log-Suche
 * findet dort nichts — und „kein Treffer" las sich wie „nichts passiert",
 * war aber „an der falschen Stelle gesucht".
 *
 * Damit war die wichtigste Frage eines Handelssystems unbeantwortbar: Tut es,
 * was es sagt? Das Symbolprofil sagt, was die Strategie WILL; dieses Werkzeug
 * sagt, was die Engine DARAUS GEMACHT hat.
 */

/** Ereignisarten, die erklären, warum (nicht) gehandelt wurde. */
export const ERKLAEREND = ['decision', 'intent', 'order', 'fill', 'trade', 'note', 'halt', 'resume'];

/**
 * Ein Journal-Ereignis auf das Wesentliche eindampfen.
 * @param {Record<string, unknown>} ev
 */
export function zeile(ev) {
  const t = typeof ev.ts === 'number' ? new Date(ev.ts).toISOString().slice(11, 19) : '--:--:--';
  const sym = typeof ev.symbol === 'string' ? ev.symbol : '—';
  const kind = typeof ev.kind === 'string' ? ev.kind : '?';
  // `decision` trägt den Blockier-Typ in `note` und den Klartext in `text`
  // (engine.ts: das Feld heißt `note`, weil `kind` schon der Ereignistyp ist).
  const art = kind === 'decision' && typeof ev.note === 'string' ? `${kind}/${ev.note}` : kind;
  const text = typeof ev.text === 'string' ? ev.text : typeof ev.note === 'string' && kind !== 'decision' ? ev.note : '';
  return { t, symbol: sym, art, text };
}

/**
 * Die Gründe zählen — die eigentliche Antwort steht meist in der häufigsten
 * Zeile, nicht in der jüngsten.
 * @param {ReadonlyArray<Record<string, unknown>>} events
 */
export function gruende(events) {
  /** @type {Map<string, {art: string, text: string, anzahl: number, symbole: Set<string>, zuletzt: number}>} */
  const m = new Map();
  for (const ev of events) {
    const z = zeile(ev);
    const key = `${z.art}|${z.text}`;
    const g = m.get(key) ?? { art: z.art, text: z.text, anzahl: 0, symbole: new Set(), zuletzt: 0 };
    g.anzahl++;
    if (z.symbol !== '—') g.symbole.add(z.symbol);
    if (typeof ev.ts === 'number' && ev.ts > g.zuletzt) g.zuletzt = ev.ts;
    m.set(key, g);
  }
  return [...m.values()].sort((a, b) => b.anzahl - a.anzahl);
}

/**
 * Der Bericht. `symbol` ist optional — ohne ihn die ganze Engine.
 * @param {{uid: string, events: ReadonlyArray<Record<string, unknown>>}[]} nutzer
 * @param {{symbol?: string | undefined, stunden: number}} o
 */
export function alsMarkdown(nutzer, o) {
  const was = o.symbol ? `Symbol ${o.symbol}` : 'alle Symbole';
  const out = [`## Warum — ${was}, letzte ${o.stunden} h`, ''];
  if (nutzer.length === 0) {
    out.push('Kein Nutzer mit Journal gefunden.');
    return out.join('\n');
  }
  for (const n of nutzer) {
    out.push(`### Nutzer ${n.uid}`, '');
    if (n.events.length === 0) {
      // Die wichtigste Zeile des ganzen Werkzeugs: Kein Eintrag heißt NICHT
      // „alles in Ordnung", sondern „die Engine hat dieses Symbol in diesem
      // Zeitraum gar nicht beurteilt" — ein anderer Befund als „beurteilt und
      // abgelehnt", und meist der interessantere.
      out.push('**Kein Eintrag.** Die Engine hat dazu in diesem Zeitraum nichts entschieden — das ist etwas anderes als „entschieden und abgelehnt".', '');
      continue;
    }
    out.push('| Grund | Anzahl | Symbole | zuletzt |', '|---|---|---|---|');
    for (const g of gruende(n.events)) {
      const syms = [...g.symbole].sort();
      const kurz = syms.length > 6 ? `${syms.slice(0, 6).join(', ')} … (${syms.length})` : syms.join(', ') || '—';
      const zul = g.zuletzt ? new Date(g.zuletzt).toISOString().slice(11, 19) : '—';
      out.push(`| ${g.art}${g.text ? `: ${g.text}` : ''} | ${g.anzahl} | ${kurz} | ${zul} |`);
    }
    out.push('', '<details><summary>Einzelne Ereignisse (jüngste zuletzt)</summary>', '');
    out.push('```');
    for (const ev of n.events) {
      const z = zeile(ev);
      out.push(`${z.t}  ${z.symbol.padEnd(6)} ${z.art}${z.text ? `  ${z.text}` : ''}`);
    }
    out.push('```', '</details>', '');
  }
  return out.join('\n');
}
