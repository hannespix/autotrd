import { describe, expect, it } from 'vitest';
import {
  PRUEF_SCHWELLE,
  kiStaerkeStufe,
  kiTrichterTag,
  leeresSichtungsProfil,
  sichtungsProfilSumme,
  sichtungsProfilZaehlen,
  type SichtungsUrteil,
} from '../src/kiNachrichten.js';

const lauf = (teil: Partial<Parameters<typeof kiTrichterTag>[1]> = {}) => ({
  gesichtet: 0, geprueft: 0, handlungsfaehig: 0, ausgelassen: {}, aufrufFehler: 0, budgetErreicht: false, ...teil,
});

describe('KI-Tagestrichter (Loop #138, 12.10.)', () => {
  it('erster Lauf: alles aus dem Lauf, kein Vortag', () => {
    const r = kiTrichterTag(null, lauf({ gesichtet: 3, geprueft: 2, handlungsfaehig: 1, ausgelassen: { irrelevant: 4 } }), '2026-10-13');
    expect(r.trichter).toEqual({ tag: '2026-10-13', laeufe: 1, gesichtet: 3, geprueft: 2, handlungsfaehig: 1, ausgelassen: { irrelevant: 4 }, aufrufFehler: 0, budgetErreicht: false, profil: leeresSichtungsProfil() });
    expect(r.vortag).toBeNull();
  });

  it('gleicher Tag summiert, Auslass-Gründe zusammengeführt, Budget bleibt gesetzt', () => {
    const a = kiTrichterTag(null, lauf({ gesichtet: 2, geprueft: 2, handlungsfaehig: 1, aufrufFehler: 1, ausgelassen: { irrelevant: 1 }, budgetErreicht: true }), '2026-10-13');
    const b = kiTrichterTag({ trichter: a.trichter }, lauf({ gesichtet: 1, geprueft: 1, handlungsfaehig: 2, aufrufFehler: 1, ausgelassen: { irrelevant: 2, zu_alt: 1 } }), '2026-10-13');
    expect(b.trichter).toMatchObject({ laeufe: 2, gesichtet: 3, geprueft: 3, handlungsfaehig: 3, aufrufFehler: 2, ausgelassen: { irrelevant: 3, zu_alt: 1 }, budgetErreicht: true });
    expect(b.vortag).toBeNull();
  });

  it('neuer Tag beginnt bei null, der alte wird Vortag', () => {
    const a = kiTrichterTag(null, lauf({ gesichtet: 5, handlungsfaehig: 2 }), '2026-10-12');
    const b = kiTrichterTag({ trichter: a.trichter }, lauf({ gesichtet: 1 }), '2026-10-13');
    expect(b.trichter).toMatchObject({ tag: '2026-10-13', laeufe: 1, gesichtet: 1, handlungsfaehig: 0 });
    expect(b.vortag).toMatchObject({ tag: '2026-10-12', gesichtet: 5, handlungsfaehig: 2 });
  });

  it('kaputte Altwerte zählen als 0, nie als NaN oder negativ', () => {
    const r = kiTrichterTag({ trichter: { tag: '2026-10-13', gesichtet: -4, geprueft: Number.NaN, laeufe: 'x' as unknown as number } }, lauf({ gesichtet: 1 }), '2026-10-13');
    expect(r.trichter).toMatchObject({ laeufe: 1, gesichtet: 1, geprueft: 0 });
  });
});

describe('Sichtungs-Profil (Loop #138, 19.10.)', () => {
  const u = (staerke: number, eindeutig: boolean): SichtungsUrteil => ({
    id: 'n1', symbol: 'AAPL', richtung: 'positiv', eindeutig, staerke, ereignis: 'sonstiges' as SichtungsUrteil['ereignis'], kurz: '',
  });

  it('Stufen-Grenzen gehören zur oberen Stufe; die Prüf-Schwelle fällt auf eine Grenze', () => {
    expect(kiStaerkeStufe(0)).toBe('unter02');
    expect(kiStaerkeStufe(0.2)).toBe('unter04');
    expect(kiStaerkeStufe(0.59)).toBe('unter06');
    expect(kiStaerkeStufe(PRUEF_SCHWELLE)).toBe('unter08');
    expect(kiStaerkeStufe(1)).toBe('ab08');
    expect(kiStaerkeStufe(Number.NaN)).toBe('unter02');
  });

  it('zählt alle Urteile und getrennt die eindeutigen — so wird sichtbar, welche Bedingung sperrt', () => {
    const p = leeresSichtungsProfil();
    sichtungsProfilZaehlen(p, [u(0.7, false), u(0.3, true), u(0.9, true), u(0.95, true)], 1);
    expect(p).toEqual({
      urteile: 4, eindeutig: 3, kandidaten: 1,
      staerke: { unter08: 1, unter04: 1, ab08: 2 },
      staerkeEindeutig: { unter04: 1, ab08: 2 },
      verfallen: {},
    });
  });

  it('Tagessumme addiert, verträgt kaputten Altstand und fließt in den Trichter', () => {
    const a = leeresSichtungsProfil();
    sichtungsProfilZaehlen(a, [u(0.5, true)], 0);
    a.verfallen.zu_alt = 2;
    const s = sichtungsProfilSumme({ urteile: 4, staerke: { unter06: 1 }, verfallen: { zu_alt: 1, budget: -3 } as never, eindeutig: 'x' as never }, a);
    expect(s).toEqual({ urteile: 5, eindeutig: 1, kandidaten: 0, staerke: { unter06: 2 }, staerkeEindeutig: { unter06: 1 }, verfallen: { zu_alt: 3 } });
    const t1 = kiTrichterTag(null, { gesichtet: 1, geprueft: 0, handlungsfaehig: 0, ausgelassen: {}, aufrufFehler: 0, budgetErreicht: false, profil: a }, '2026-10-19');
    const t2 = kiTrichterTag({ trichter: t1.trichter }, { gesichtet: 1, geprueft: 0, handlungsfaehig: 0, ausgelassen: {}, aufrufFehler: 0, budgetErreicht: false, profil: a }, '2026-10-19');
    expect(t2.trichter.profil).toMatchObject({ urteile: 2, eindeutig: 2, verfallen: { zu_alt: 4 } });
    const neu = kiTrichterTag({ trichter: t2.trichter }, { gesichtet: 0, geprueft: 0, handlungsfaehig: 0, ausgelassen: {}, aufrufFehler: 0, budgetErreicht: false }, '2026-10-20');
    expect(neu.trichter.profil).toEqual(leeresSichtungsProfil());
  });
});
