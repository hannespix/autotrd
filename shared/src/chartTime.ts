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
