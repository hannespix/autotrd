/**
 * Zeitzonen-Brücke für die Chart-Anzeige (Owner-Frage 04.08.: „gibt es
 * Timezone-Probleme?" — ja, bei 1T/1W).
 *
 * Der Kern des Problems: Lightweight Charts rendert numerische Zeitstempel
 * IMMER als UTC — es gibt keine Zeitzonen-Option. Ein 5-Minuten-Bar der
 * US-Eröffnung (13:30 UTC) erscheint auf der Achse als „13:30", während
 * dieselbe Kerze in der Kurszeile daneben als „15:30" stand, weil die per
 * `toLocaleTimeString` in Ortszeit formatiert wurde. Zwei Uhrzeiten für einen
 * Bar, zwei Stunden auseinander.
 *
 * Die übliche Lösung (und die von Lightweight Charts empfohlene): den
 * Zeitstempel VOR der Übergabe um den lokalen Offset verschieben. Die
 * Bibliothek rendert ihn weiter als UTC — und trifft damit die Ortszeit.
 *
 * Wichtig: Der Offset gehört zum EINZELNEN Zeitstempel, nicht zum „jetzt".
 * Sommer-/Winterzeit springt mitten in geladene Historien hinein; ein global
 * gemerkter Offset würde Bars vor dem Wechsel um eine Stunde verschieben.
 * Deshalb bekommt jede Funktion den Offset des jeweiligen Zeitpunkts.
 */

/**
 * Echten UNIX-Zeitstempel in einen verschieben, dessen UTC-Darstellung die
 * Ortszeit zeigt. `offsetMinuten` ist das Ergebnis von
 * `Date.prototype.getTimezoneOffset()` — in JS positiv WESTLICH von Greenwich
 * (Berlin im Sommer: −120).
 */
export function alsOrtszeit(unixSek: number, offsetMinuten: number): number {
  return unixSek - offsetMinuten * 60;
}

/** Rückweg: verschobener Anzeige-Zeitstempel → echter UNIX-Zeitstempel. */
export function ausOrtszeit(unixSek: number, offsetMinuten: number): number {
  return unixSek + offsetMinuten * 60;
}

/**
 * Tages-Präfix für ein Intraday-Label (Owner-Fund 04.08.: „bei Google und
 * Amazon wird 22 Uhr gezeigt, obwohl hier 15:15 ist").
 *
 * Die 22:00 waren richtig — es war der gestrige US-Handelsschluss (16:00 New
 * York). Falsch war nur, dass nichts es sagte: Eine nackte Uhrzeit liest man
 * als „jetzt", und dann wirkt der Chart kaputt. Vor der US-Eröffnung um 15:30
 * unserer Zeit ist die jüngste Kerze zwangsläufig von gestern; bei Krypto
 * dagegen von eben — deshalb zeigten verschiedene Charts verschiedene
 * Uhrzeiten, ohne dass eine davon falsch war.
 *
 * Beide Argumente sind ISO-Tage (`YYYY-MM-DD`) in DERSELBEN Zeitzone —
 * gemischt man Bar-Tag in Ortszeit mit „heute" in UTC, springt das Ergebnis
 * abends um einen Tag.
 */
export function tagesPraefix(barTag: string, heuteTag: string): string {
  if (barTag === heuteTag) return '';
  const bar = Date.parse(barTag);
  const heute = Date.parse(heuteTag);
  if (!Number.isFinite(bar) || !Number.isFinite(heute)) return '';
  const tage = Math.round((heute - bar) / 86_400_000);
  if (tage === 1) return 'gestern';
  const teile = barTag.split('-');
  return teile.length === 3 ? `${teile[2]}.${teile[1]}.` : '';
}

/** Lokaler Kalendertag eines Zeitstempels als ISO-Tag (ohne UTC-Versatz). */
export function lokalerTag(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Kurzname der Zeitzone fürs Achsen-Label („MESZ", „MEZ") — damit im Chart
 * steht, worauf sich die Uhrzeiten beziehen. Fällt auf den IANA-Namen bzw.
 * einen UTC-Versatz zurück, wenn die Umgebung keinen Kurznamen kennt.
 */
export function zonenKuerzel(d: Date, sprache = 'de-DE'): string {
  try {
    const teil = new Intl.DateTimeFormat(sprache, { timeZoneName: 'short' })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName');
    if (teil?.value) return teil.value;
  } catch {
    /* Intl ohne timeZoneName — unten weiter */
  }
  const off = -d.getTimezoneOffset();
  if (off === 0) return 'UTC';
  const vz = off > 0 ? '+' : '−';
  const std = Math.floor(Math.abs(off) / 60);
  const min = Math.abs(off) % 60;
  return `UTC${vz}${std}${min > 0 ? `:${String(min).padStart(2, '0')}` : ''}`;
}
