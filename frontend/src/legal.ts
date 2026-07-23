/**
 * Rechtliches Minimum (MILESTONES M7): Impressum, Datenschutzerklärung,
 * Risiko-Disclaimer. Eigenes Modul mit eigenem Modal am <body>, damit
 * Login-Screen UND Dashboard denselben Footer/Dialog nutzen können.
 *
 * [OWNER]: Platzhalter in eckigen Klammern vor dem Livegang ausfüllen —
 * Impressumspflicht (§ 5 DDG) gilt, sobald die Seite öffentlich ist.
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
    <p><strong>[Vor- und Nachname des Betreibers]</strong><br>
    [Straße Hausnummer]<br>
    [PLZ Ort], Deutschland</p>
    <p>Kontakt: <a href="mailto:[E-Mail-Adresse]">[E-Mail-Adresse]</a></p>
    <p>Verantwortlich für den Inhalt: [Vor- und Nachname], Anschrift wie oben.</p>
    <p class="hint">autotrd ist ein privates, nicht-kommerzielles Lern- und
    Analyse-Tool für Paper-Trading (simulierter Handel ohne echtes Geld).</p>`,
  datenschutz: `
    <p><strong>Verantwortlicher:</strong> [Vor- und Nachname], [Anschrift],
    <a href="mailto:[E-Mail-Adresse]">[E-Mail-Adresse]</a></p>
    <p><strong>Welche Daten verarbeiten wir?</strong> Beim Anlegen eines Kontos
    speichern wir deine E-Mail-Adresse und eine zufällige Nutzer-ID. In der App
    speichern wir deine Einstellungen (Strategie, Watchlist), dein simuliertes
    Paper-Wallet sowie simulierte Positionen und Trades. Es werden keine
    echten Depot-, Bank- oder Zahlungsdaten verarbeitet.</p>
    <p><strong>Wo liegen die Daten?</strong> Authentifizierung und Datenbank
    laufen über Google Firebase (Google Ireland Ltd. bzw. Google LLC).
    Dabei kann eine Verarbeitung in den USA stattfinden; Google ist unter dem
    EU-U.S. Data Privacy Framework zertifiziert. Rechtsgrundlage ist
    Art. 6 Abs. 1 lit. b DSGVO (Bereitstellung des Dienstes).</p>
    <p><strong>Was machen wir nicht?</strong> Kein Tracking, keine Werbung,
    keine Analyse-Cookies, kein Verkauf von Daten. Der Local Storage des
    Browsers speichert nur die Theme-Einstellung (hell/dunkel).</p>
    <p><strong>Marktdaten &amp; News</strong> werden serverseitig von
    öffentlichen Quellen (Yahoo Finance, Google News RSS) geladen — dein
    Browser kontaktiert diese Quellen nicht direkt.</p>
    <p><strong>Deine Rechte:</strong> Auskunft, Berichtigung, Löschung,
    Einschränkung, Datenübertragbarkeit, Widerspruch (Art. 15–21 DSGVO) sowie
    Beschwerde bei einer Aufsichtsbehörde. Zur Konto-Löschung genügt eine
    formlose E-Mail an die oben genannte Adresse.</p>`,
  disclaimer: `
    <p><strong>autotrd ist keine Anlageberatung.</strong> Alle Signale,
    Prognosen, KI-Zusammenfassungen und sonstigen Inhalte dienen ausschließlich
    Lern- und Informationszwecken und stellen keine Finanz-, Rechts- oder
    Steuerberatung und keine Kauf- oder Verkaufsempfehlung dar.</p>
    <p>Das Handeln in dieser App ist <strong>Paper-Trading</strong>: Es wird
    ausschließlich mit simuliertem Guthaben gehandelt, es fließt kein echtes
    Geld. Simulierte Ergebnisse lassen keinen Rückschluss auf reale Ergebnisse
    zu — reale Märkte kennen Slippage, Gebühren und Liquiditätsrisiken.</p>
    <p>Prognosen basieren auf einfachen statistischen Modellen und
    News-Sentiment; sie können falsch liegen und tun das regelmäßig. Der
    Handel mit echten Wertpapieren, Derivaten oder Kryptowährungen kann zum
    Totalverlust führen. Entscheidungen triffst du in eigener Verantwortung.</p>
    <p>Kursdaten stammen von öffentlichen Quellen (verzögert, ohne Gewähr auf
    Richtigkeit oder Vollständigkeit).</p>`,
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
      <div id="legalBody" class="legal-body"></div>
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
    <span>Paper-Trading zu Lernzwecken — keine Anlageberatung.</span>
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
