/**
 * SECREVIEW #8 — CLI ↔ Doku ↔ Repo-Hygiene. Jeder Fall schlägt fehl, solange
 * die Abweichung besteht.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cli = readFileSync('src/cli.ts', 'utf8');
const betrieb = readFileSync('docs/BETRIEB.md', 'utf8');
const gitignore = readFileSync('.gitignore', 'utf8');

function fnBody(src: string, name: string): string {
  const i = src.indexOf(`async function ${name}(`);
  const j = src.indexOf(`\nasync function `, i + 1);
  const k = src.indexOf(`\nfunction `, i + 1);
  const end = [j, k].filter((x) => x > 0).sort((a, b) => a - b)[0] ?? src.length;
  return src.slice(i, end);
}

describe('secreview: CLI/Docs-Abgleich', () => {
  it('USAGE verspricht `optimize --days <n>` — cmdOptimize liest die Option nicht (lookbackDays kommt nur aus der Config)', () => {
    expect(cli).toMatch(/optimize:\s+--equity <usd> --days <n>/);
    expect(fnBody(cli, 'cmdOptimize'), 'cmdOptimize ignoriert --days').toMatch(/values\.days/);
  });

  it('`halt --reason <text>` existiert in der CLI, fehlt aber in USAGE und BETRIEB.md §2', () => {
    expect(cli).toMatch(/reason: \{ type: 'string' \}/);
    expect(cli.includes('halt:') && /halt:\s+--reason/.test(cli), 'USAGE nennt --reason nicht').toBe(true);
    expect(betrieb, 'BETRIEB.md nennt --reason nicht').toMatch(/--reason/);
  });

  it('README lässt `config/config.yaml` anlegen — .gitignore schließt die Live-Config nicht aus', () => {
    expect(gitignore, 'config/config.yaml (mode: live, Symbole, Risiko) kann versehentlich committet werden').toMatch(/config\/config\.yaml|^config\.yaml$/m);
  });

  it('BETRIEB §7: Stop-Fills während der Abwesenheit werden mit exitReason "reconcile" nachgebucht — tatsächlich bucht syncOrders sie als "stop"; "reconcile" ist der GESCHÄTZTE Kurs ohne Fill-Beleg', () => {
    const orders = readFileSync('src/engine/orders.ts', 'utf8');
    expect(orders).toMatch(/reasonForOrder\(o, 'signal'\)/); // Bein-Fills ⇒ 'stop' / 'target'
    const claim = /geschlossene Positionen\s*\(Stop-Fill\) werden mit `exitReason: "reconcile"` nachgebucht/.test(betrieb.replace(/\n\s+/g, ' '));
    expect(claim, 'Doku-Aussage widerspricht dem Code (Stop-Fill ⇒ "stop", nur Schätzung ⇒ "reconcile")').toBe(false);
  });
});
