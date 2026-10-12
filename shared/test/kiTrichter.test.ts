import { describe, expect, it } from 'vitest';
import { kiTrichterTag } from '../src/kiNachrichten.js';

const lauf = (teil: Partial<Parameters<typeof kiTrichterTag>[1]> = {}) => ({
  gesichtet: 0, geprueft: 0, handlungsfaehig: 0, ausgelassen: {}, aufrufFehler: 0, budgetErreicht: false, ...teil,
});

describe('KI-Tagestrichter (Loop #138, 12.10.)', () => {
  it('erster Lauf: alles aus dem Lauf, kein Vortag', () => {
    const r = kiTrichterTag(null, lauf({ gesichtet: 3, geprueft: 2, handlungsfaehig: 1, ausgelassen: { irrelevant: 4 } }), '2026-10-13');
    expect(r.trichter).toEqual({ tag: '2026-10-13', laeufe: 1, gesichtet: 3, geprueft: 2, handlungsfaehig: 1, ausgelassen: { irrelevant: 4 }, aufrufFehler: 0, budgetErreicht: false });
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
