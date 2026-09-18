/**
 * Das Champion-Dokument für Firestore — und zurück.
 *
 * ── Warum es das gibt (18.09.2026) ────────────────────────────────────────
 *
 * Lauf #18 brachte die ERSTE Beförderung seit dem Neubau
 * (`cross_sectional_momentum`, alle zehn Gates). Die Veröffentlichung starb
 * mit `INDEX_ENTRIES_COUNT_LIMIT_EXCEEDED` auf `meta/champion`: Firestore
 * indiziert jedes Feld und jedes Array-Element eines Dokuments automatisch,
 * höchstens 40 000 Einträge je Dokument. Ein Champion-Eintrag trägt die
 * ganze OOS-Kette (`oos.dailyReturns` und `oos.dayKeys`, je ~1 100
 * Elemente); 30 Einträge sind rund 66 000 Elemente. Solange nie etwas
 * befördert wurde, war `symbols` leer und niemand hat es gemerkt: Der
 * Beförderungspfad zur Plattform war nie befahrbar.
 *
 * Zwei Dinge, beide rein (kein Firestore, kein Netz — testbar):
 *
 *   1. `fuerFirestore(champion)` — die Datei ohne die beiden Ketten. Die
 *      Engine liest aus einem Eintrag nur strategy/params/timeframe
 *      (functions/src/engine/strategyFor.ts), das Frontend nur Skalare aus
 *      `oos` (frontend/src/data.ts, `ChampionEntryDoc`), und der Optimierer
 *      rechnet den Amtsinhaber NEU (run.ts, Re-Score auf sauberem OOS) statt
 *      eine gespeicherte Kette zu lesen. Nichts braucht die Ketten in
 *      Firestore; die vollständige Datei bleibt im Lauf-Artefakt.
 *   2. `pruefeDokument(doc)` — zählt die indizierbaren Werte und LEHNT AB,
 *      bevor Firestore es tut. Ein zweiter Block, der Ketten mitbringt,
 *      soll hier auffallen, nicht nachts um eins im Log.
 *
 * `ausFirestoreDoc(data)` ist der Rückweg für `scripts/fetch-champion.mjs`:
 * `meta/champion` zurück in die Form von `var/champion.json`, damit der
 * nächtliche Lauf seinen Amtsinhaber kennt (siehe dort).
 */

/** Felder je Champion-Eintrag, die NICHT nach Firestore gehen (die Zeitreihen der OOS-Kette). */
export const KETTEN_FELDER = Object.freeze(['dailyReturns', 'dayKeys']);

/**
 * Obergrenze indizierbarer Werte, die dieses Modul akzeptiert. Firestore
 * erlaubt 40 000 INDEX-EINTRÄGE; ein Wert kann mehrere erzeugen (auf- und
 * absteigend, Array-Mitgliedschaft). 15 000 Werte lassen Faktor ~2,7 Luft —
 * ein verschlanktes Dokument mit 30 Einträgen liegt bei rund 2 000.
 */
export const INDEX_WERTE_MAX = 15_000;

const istObjekt = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Indizierbare Werte zählen: jeder Skalar, jedes Array-Element (rekursiv),
 * jeder Map-Schlüssel mit Wert. Eine Näherung von oben — mehr als Firestore
 * zählt, nie weniger.
 * @param {unknown} x
 */
export function indexWerte(x) {
  if (Array.isArray(x)) return x.reduce((s, v) => s + Math.max(1, indexWerte(v)), 0);
  if (istObjekt(x)) return Object.values(x).reduce((s, v) => s + indexWerte(v), 0);
  return 1;
}

/**
 * Die Champion-Datei ohne die OOS-Ketten je Eintrag. Neues Objekt; die
 * Eingabe bleibt unverändert (die lokale Datei ist vollständig und soll es
 * bleiben).
 * @param {Record<string, unknown>} champion
 */
export function fuerFirestore(champion) {
  const out = structuredClone(champion);
  for (const block of ['symbols']) {
    const eintraege = out[block];
    if (!istObjekt(eintraege)) continue;
    for (const e of Object.values(eintraege)) {
      if (!istObjekt(e) || !istObjekt(e.oos)) continue;
      for (const f of KETTEN_FELDER) delete e.oos[f];
    }
  }
  return out;
}

/**
 * Darf dieses Dokument nach Firestore? Zählt, statt zu hoffen.
 * @param {unknown} doc
 * @returns {{ok: true, werte: number} | {ok: false, werte: number, grund: string}}
 */
export function pruefeDokument(doc) {
  const werte = indexWerte(doc);
  if (werte <= INDEX_WERTE_MAX) return { ok: true, werte };
  return {
    ok: false,
    werte,
    grund:
      `meta/champion hätte ${werte} indizierbare Werte (Obergrenze ${INDEX_WERTE_MAX}; Firestore bricht bei 40 000 Index-Einträgen ab). ` +
      'Irgendein Block trägt Zeitreihen oder große Arrays — vor dem Veröffentlichen entfernen (scripts/module/championDoc.mjs).',
  };
}

/**
 * `meta/champion` (Firestore-Daten) zurück in die Form von `var/champion.json`.
 * Wirft bei fremder Version (nie raten, wie `loadChampion`); null ohne Dokument.
 * `publishedAt` (Firestore-Timestamp) gehört nicht in die Datei.
 * @param {Record<string, unknown> | undefined} data
 */
export function ausFirestoreDoc(data) {
  if (!data) return null;
  if (data.version !== 1) throw new Error(`meta/champion: unbekannte Champion-Version ${String(data.version)} — Dokument prüfen statt raten`);
  const out = {
    version: 1,
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : 0,
    symbols: istObjekt(data.symbols) ? data.symbols : {},
    noTrade: istObjekt(data.noTrade) ? data.noTrade : {},
  };
  if (istObjekt(data.basis)) out.basis = data.basis;
  if (istObjekt(data.erprobung) && Object.keys(data.erprobung).length) out.erprobung = data.erprobung;
  return out;
}
