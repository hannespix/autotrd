/**
 * Die Scheduler-Diagnose darf einen gelungenen Deploy nicht rot färben.
 *
 * Befund 23.08., Lauf zu 2d967ff: Schritt „Deploy functions + firestore" war
 * erfolgreich, Revision scanmarket-00222-zav ging live — der Lauf steht
 * trotzdem als „failure". Rot wurde er an dieser Diagnose, die nach unter
 * einer Sekunde ausstieg:
 *
 *   HTTP 503 { code: 503, message: 'The service is currently unavailable.' }
 *       at gfetch (scripts-ci/gcp-lite.mjs:96:17)
 *       at async ensureSelfInvoker (scripts-ci/invoke-scan.mjs:70:15)
 *       at async check-scheduler.mjs:111:9
 *   ##[error]Process completed with exit code 1.
 *
 * Ein transienter Google-503 also — ungefangen bis nach oben, lange vor der
 * Heartbeat-Prüfung, die laut Kopfkommentar der EINZIGE Grund für Exit 1 sein
 * darf. Und der Schritt hat kein `continue-on-error`, anders als die
 * Secret-Diagnose direkt darunter.
 *
 * Zwei Dinge machen das schlimmer als einen Schönheitsfehler:
 *
 *   1. Es ist die Kehrseite der Deploy-Lehre in CLAUDE.md §8. Dort steht, dass
 *      ein grüner PR keinen Deploy beweist. Hier gilt die Umkehrung: Ein roter
 *      Lauf beweist nicht, dass der Code NICHT live ist. Wer die Lauffarbe
 *      glaubt, hält deployten Code für nicht deployt — und lässt eine nötige
 *      Korrektur liegen.
 *   2. Das Skript wurde gegen genau diese Fehlerklasse gebaut. Sein
 *      Kopfkommentar beschreibt einen firebase-tools-Abbruch an einem
 *      transienten 503. Ein Prüfstand, der an derselben Laune scheitert wie
 *      das, was er prüfen soll, misst nichts.
 *
 * `check-scheduler.mjs` läuft beim Import (Top-Level-await gegen Google-APIs)
 * und hat keine testbaren Exporte — hier wacht deshalb der Quelltext.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const quelle = readFileSync(join(hier, '../check-scheduler.mjs'), 'utf8');

describe('Die Eskalationsleiter ist bestes Bemühen, keine Bedingung', () => {
  it('die Service-URL wird nicht mehr ungefangen geholt — der eigentliche Befund', () => {
    expect(quelle).toContain('url = await ensureSelfInvoker({ sa, token, project }).catch(');
    // Genau diese Zeile hat den Deploy rot gefärbt.
    expect(quelle).not.toMatch(/url = await ensureSelfInvoker\(\{ sa, token, project \}\);/);
  });

  it('der Force-Run samt Identitäts-Reparatur liegt in einem Auffangrahmen', () => {
    const i = quelle.indexOf('if (schedulerOk && job) {');
    expect(i).toBeGreaterThan(0);
    // Unmittelbar davor steht das try, danach der Fang.
    expect(quelle.slice(0, i)).toMatch(/try \{\s*$/);
    expect(quelle).toContain('Scheduler-Eskalation abgebrochen');
  });

  it('auch der Direkt-Invoke und sein Heartbeat-Nachschlag fangen ab', () => {
    expect(quelle).toContain('const ok = await invokeScanNow().catch(');
    expect(quelle).toContain('await readHeartbeat(project).catch(() => null)');
  });

  it('Exit 1 hängt weiterhin allein am fehlenden Heartbeat', () => {
    // Das ist die Zusage des Kopfkommentars. Sie darf nicht aufweichen — eine
    // Diagnose ohne jedes Rot wäre genauso wertlos wie eine, die immer rot ist.
    const exits = quelle.match(/process\.exit\((\d)\)/g) ?? [];
    expect(exits).toEqual(['process.exit(0)', 'process.exit(1)']);
    const i = quelle.lastIndexOf('process.exit(1)');
    expect(quelle.slice(i - 400, i)).toContain('meta/health existiert trotz aller Eskalationsstufen NICHT');
  });
});

describe('Eine Diagnose darf nie beschädigen, was sie prüft', () => {
  it('ohne Service-URL wird kein scanmarket-Zeitplan angelegt', () => {
    expect(quelle).toContain("if (s.service === 'scanmarket' && !url) {");
  });

  it('und ein funktionierender Job wird nie mit uri null überschrieben', () => {
    // Ohne `&& url` schriebe eine fehlgeschlagene URL-Abfrage null in den
    // httpTarget eines Jobs, der bis dahin lief.
    expect(quelle).toContain('if (!heartbeat && !freshlyCreated && url) {');
  });
});
