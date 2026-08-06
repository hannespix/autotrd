/**
 * Rechtstexte (M7, vervollständigt 06.08. auf Owner-Auftrag): Impressum,
 * Datenschutzerklärung, Risikohinweis. Eigenes Modul mit eigenem Modal am
 * <body>, damit Login-Screen UND Dashboard denselben Footer/Dialog nutzen.
 *
 * Stand der Texte: autotrd ist KEIN reines Paper-Trading-Tool mehr — die
 * Broker-Anbindung (Alpaca) ist gebaut, Echtgeld ist mehrstufig verriegelt,
 * aber vorgesehen. Risikohinweis und Datenschutz beschreiben diesen
 * tatsächlichen Stand; bei Architektur-Änderungen (neue Datenempfänger,
 * neue Handelswege) MÜSSEN diese Texte im selben PR mitziehen.
 */

export type LegalKind = 'impressum' | 'datenschutz' | 'disclaimer';

const TITLES: Record<LegalKind, string> = {
  impressum: 'Impressum',
  datenschutz: 'Datenschutzerklärung',
  disclaimer: 'Risikohinweis',
};

const TEXTS: Record<LegalKind, string> = {
  impressum: `
    <p>Angaben gemäß § 5 DDG:</p>
    <p><strong>Hannes Pix</strong><br>
    autotrd — automatisierte Trading-Plattform<br>
    Eisenbahnstraße 19<br>
    79241 Ihringen am Kaiserstuhl<br>
    Baden-Württemberg, Deutschland</p>
    <p>Kontakt: <a href="mailto:overlord@autotrd.net">overlord@autotrd.net</a><br>
    Website: https://autotrd.net</p>
    <p><strong>Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV:</strong>
    Hannes Pix, Anschrift wie oben.</p>
    <p><strong>EU-Streitschlichtung:</strong> Die Europäische Kommission stellt
    eine Plattform zur Online-Streitbeilegung (OS) bereit:
    https://ec.europa.eu/consumers/odr/. Wir sind nicht bereit oder
    verpflichtet, an Streitbeilegungsverfahren vor einer
    Verbraucherschlichtungsstelle teilzunehmen.</p>
    <p><strong>Haftung für Inhalte:</strong> Als Diensteanbieter sind wir gemäß
    § 7 Abs. 1 DDG für eigene Inhalte auf diesen Seiten nach den allgemeinen
    Gesetzen verantwortlich. Nach §§ 8 bis 10 DDG sind wir jedoch nicht
    verpflichtet, übermittelte oder gespeicherte fremde Informationen zu
    überwachen. Marktdaten, Signale und Kennzahlen werden ohne Gewähr für
    Richtigkeit, Vollständigkeit und Aktualität bereitgestellt.</p>
    <p><strong>Haftung für Links:</strong> Unser Angebot enthält Links zu
    externen Webseiten Dritter, auf deren Inhalte wir keinen Einfluss haben;
    für diese fremden Inhalte übernehmen wir keine Gewähr.</p>
    <p><strong>Urheberrecht:</strong> Die durch den Seitenbetreiber erstellten
    Inhalte und Werke auf diesen Seiten unterliegen dem deutschen
    Urheberrecht.</p>`,
  datenschutz: `
    <p><strong>Verantwortlicher:</strong> Hannes Pix, Eisenbahnstraße 19,
    79241 Ihringen am Kaiserstuhl,
    <a href="mailto:overlord@autotrd.net">overlord@autotrd.net</a></p>
    <p><strong>Welche Daten verarbeiten wir?</strong> Beim Anlegen eines Kontos
    speichern wir deine E-Mail-Adresse und eine zufällige Nutzer-ID
    (Google Firebase Authentication). In der App speichern wir deine
    Einstellungen (Strategie, Watchlist, Oberfläche), dein Wallet sowie
    Positionen, Trades und daraus berechnete Kennzahlen — auch für den
    Steuer-Export, den du selbst erzeugst. Die Freischaltung neuer Konten
    erfolgt manuell durch den Betreiber (Zugangsstufe am Konto).</p>
    <p><strong>Broker-Anbindung (optional):</strong> Wenn du dein eigenes
    Broker-Konto (Alpaca) verbindest, hinterlegst du dessen API-Schlüssel.
    Das Schlüssel-Geheimnis wird verschlüsselt gespeichert (der
    Hauptschlüssel liegt ausschließlich in der Server-Umgebung), wird nie im
    Browser angezeigt und ausschließlich für Order-Übermittlung, Depot-Abgleich
    und Kontostand-Abfragen verwendet. Dabei werden Order- und Bestandsdaten
    an Alpaca Securities LLC (USA) übertragen. Rechtsgrundlage ist Art. 6
    Abs. 1 lit. b DSGVO (Durchführung des von dir gewünschten Dienstes); die
    Verbindung kannst du jederzeit in der App trennen.</p>
    <p><strong>Wo liegen die Daten?</strong> Authentifizierung und Datenbank
    laufen über Google Firebase (Google Ireland Ltd. bzw. Google LLC); dabei
    kann eine Verarbeitung in den USA stattfinden — Google ist unter dem
    EU-U.S. Data Privacy Framework zertifiziert. Die Web-App selbst wird von
    der Webgo GmbH (Deutschland) ausgeliefert; beim Abruf entstehen dort
    übliche Server-Logs (IP-Adresse, Zeitpunkt, abgerufene Datei) gemäß den
    Datenschutzhinweisen von Webgo. Rechtsgrundlage ist Art. 6 Abs. 1
    lit. b DSGVO (Bereitstellung des Dienstes).</p>
    <p><strong>Was machen wir nicht?</strong> Kein Tracking, keine Werbung,
    keine Analyse-Cookies, kein Verkauf von Daten. Der Local Storage des
    Browsers speichert nur Oberflächen-Einstellungen (z. B. hell/dunkel).</p>
    <p><strong>Marktdaten &amp; News</strong> werden serverseitig von
    öffentlichen Quellen (Yahoo Finance, Google News RSS) und — bei
    verbundenem Broker — von Alpaca geladen; dein Browser kontaktiert diese
    Quellen nicht direkt.</p>
    <p><strong>Deine Rechte:</strong> Auskunft, Berichtigung, Löschung,
    Einschränkung, Datenübertragbarkeit, Widerspruch (Art. 15–21 DSGVO) sowie
    Beschwerde bei einer Aufsichtsbehörde. Zur Konto-Löschung genügt eine
    formlose E-Mail an
    <a href="mailto:overlord@autotrd.net">overlord@autotrd.net</a>.</p>`,
  disclaimer: `
    <p><strong>autotrd ist keine Anlageberatung.</strong> Alle Signale,
    Prognosen und Kennzahlen dienen Informations- und Lernzwecken; sie sind
    keine Finanz-, Rechts- oder Steuerberatung und keine Kauf- oder
    Verkaufsempfehlung. Die automatische Engine führt ausschließlich die von
    dir selbst gewählten Einstellungen aus — die Verantwortung für jede
    Einstellung und jeden Trade liegt bei dir.</p>
    <p><strong>autotrd ist nicht mehr nur Simulation.</strong> Standard ist
    Paper-Trading mit simuliertem Guthaben. Du kannst aber dein echtes
    Broker-Konto (Alpaca) verbinden — dann platziert die Plattform Orders in
    DEINEM Depot: zunächst am Papier-Endpunkt, nach ausdrücklicher
    mehrstufiger Freischaltung auch mit echtem Geld. Ab diesem Moment bewegen
    Fehler — deine wie unsere — echtes Geld.</p>
    <p><strong>Die Gefahren des Tradings, ohne Beschönigung:</strong></p>
    <ul>
      <li><strong>Totalverlust:</strong> Der Handel mit Aktien, ETFs,
      Rohstoffen und Kryptowährungen kann zum Verlust des gesamten
      eingesetzten Kapitals führen.</li>
      <li><strong>Hebel</strong> vervielfacht Verluste genauso wie Gewinne —
      bis hin zu Nachschuss-Situationen (Margin), in denen Positionen
      zwangsweise geschlossen werden.</li>
      <li><strong>Leerverkäufe:</strong> Beim Short ist der theoretische
      Verlust unbegrenzt, weil ein Kurs beliebig steigen kann.</li>
      <li><strong>Kryptowährungen</strong> sind extrem volatil, handeln rund
      um die Uhr und sind teils unreguliert.</li>
      <li><strong>Automatisierte Systeme</strong> können durch Software-Fehler,
      fehlerhafte oder verzögerte Kursdaten, Ausfälle oder Netzprobleme
      falsch oder gar nicht handeln. Auch Stop-Orders sind keine Garantie:
      Bei Kurslücken wird schlechter oder gar nicht ausgeführt.</li>
      <li><strong>Kosten:</strong> Gebühren und Spreads fallen bei jedem Trade
      an und können Gewinne vollständig aufzehren — unsere eigene Messung
      über hunderte simulierte Trades zeigt genau das.</li>
      <li><strong>Vergangenheit ist keine Zukunft:</strong> Simulierte oder
      historische Ergebnisse — auch alle Kennzahlen in dieser App — lassen
      keinen verlässlichen Rückschluss auf künftige Ergebnisse zu.
      Paper-Trading unterschätzt reale Reibung (Slippage, Teilausführungen,
      Liquidität) systematisch.</li>
    </ul>
    <p><strong>Setze nur Geld ein, dessen vollständigen Verlust du dir
    leisten kannst.</strong> Wenn du unsicher bist, hole unabhängigen,
    qualifizierten Rat ein, bevor du echtes Geld einsetzt.</p>
    <p>Kursdaten stammen von öffentlichen Quellen bzw. vom angebundenen
    Broker — teils verzögert und stets ohne Gewähr für Richtigkeit oder
    Vollständigkeit.</p>`,
};

function ensureModal(): HTMLElement {
  let modal = document.getElementById('legalModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'legalModal';
  modal.className = 'dmodal';
  modal.innerHTML = `
    <div class="dmodal-bg" data-legal-close></div>
    <div class="dsheet" style="width:min(640px,100%)" role="dialog" aria-modal="true" aria-labelledby="legalTitle">
      <button class="dclose" data-legal-close aria-label="Schließen">✕</button>
      <h3 id="legalTitle"></h3>
      <!-- selectable: Rechtstexte sind zum Lesen UND Kopieren da (Adressen,
           Paragraphen) — die App-weite Markier-Sperre gilt hier nicht. -->
      <div id="legalBody" class="legal-body selectable"></div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelectorAll('[data-legal-close]').forEach((el) =>
    el.addEventListener('click', () => modal!.classList.remove('show')),
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') modal!.classList.remove('show');
  });
  return modal;
}

export function openLegal(kind: LegalKind): void {
  const modal = ensureModal();
  modal.querySelector('#legalTitle')!.textContent = TITLES[kind];
  modal.querySelector('#legalBody')!.innerHTML = TEXTS[kind];
  modal.classList.add('show');
}

/** Footer mit den drei Pflicht-Links + Disclaimer-Zeile in `container` hängen. */
export function mountLegalFooter(container: HTMLElement): void {
  const foot = document.createElement('footer');
  foot.className = 'legal-foot';
  foot.innerHTML = `
    <span>Trading birgt erhebliche Verlustrisiken — keine Anlageberatung.</span>
    <nav>
      <a href="#" data-legal="disclaimer">Risikohinweis</a>
      <a href="#" data-legal="impressum">Impressum</a>
      <a href="#" data-legal="datenschutz">Datenschutz</a>
    </nav>`;
  foot.querySelectorAll<HTMLAnchorElement>('[data-legal]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openLegal(a.dataset.legal as LegalKind);
    }),
  );
  container.appendChild(foot);
}
