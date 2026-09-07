/**
 * Planung des Umstiegs vom Altsystem auf den Engine-Takt — reine Logik ohne
 * Firestore, damit sie testbar ist. `umstieg.mjs` führt den Plan aus.
 *
 * Regeln:
 *  - Die Engine wird für JEDEN Nutzer ausgeschaltet, der nicht Admin ist und
 *    nicht in der Behalten-Liste steht. Wer im Altsystem „an" hatte, handelte
 *    dort eine andere, nie gemessene Strategie — der Champion des Neubaus
 *    darf nicht ungefragt für ihn loslegen. Einschalten ist eine bewusste
 *    Entscheidung in der neuen Einstellungskarte.
 *  - Alte Positions-Spiegel (`users/{uid}/positions`) stammen aus dem
 *    internen Papierbuch bzw. dem alten Broker-Buch. Der neue Takt schreibt
 *    diesen Spiegel ausschließlich aus seinem eigenen Buch; alte Docs werden
 *    nach `positionsArchiv` verschoben, nicht gelöscht.
 */

/** @typedef {{ uid: string; admin: boolean; running: boolean; positions: string[] }} UserSicht */

/**
 * @param {UserSicht[]} users
 * @param {{ behalten?: string[] }} o
 * @returns {{ ausschalten: string[]; behalten: string[]; archivieren: Array<{ uid: string; docs: string[] }> }}
 */
export function planeUmstieg(users, o = {}) {
  const keep = new Set(o.behalten ?? []);
  const ausschalten = [];
  const behalten = [];
  const archivieren = [];
  for (const u of users) {
    if (u.running) {
      if (u.admin || keep.has(u.uid)) behalten.push(u.uid);
      else ausschalten.push(u.uid);
    }
    if (u.positions.length > 0) archivieren.push({ uid: u.uid, docs: [...u.positions] });
  }
  return { ausschalten, behalten, archivieren };
}

/** Nutzer-Doc → Sicht für die Planung. */
export function userSichtVon(uid, data, positionsIds) {
  const settings = data && typeof data.settings === 'object' && data.settings ? data.settings : {};
  const strategy = settings && typeof settings.strategy === 'object' && settings.strategy ? settings.strategy : {};
  const engine = strategy && typeof strategy.engine === 'object' && strategy.engine ? strategy.engine : {};
  return {
    uid,
    admin: data?.admin === true,
    running: engine.running === true,
    positions: [...positionsIds],
  };
}
