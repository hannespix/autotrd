/**
 * PWA-Verdrahtung: Service-Worker-Registrierung + dezenter Install-Chip.
 *
 * Der Chip erscheint nur, wenn der Browser `beforeinstallprompt` liefert
 * (Chromium; iOS installiert über das Teilen-Menü), die App nicht schon
 * standalone läuft und der User ihn nicht kürzlich weggeklickt hat.
 */

const DISMISS_KEY = 'autotrd-pwa-dismissed';
const DISMISS_DAYS = 14;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function recentlyDismissed(): boolean {
  const ts = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
  return Date.now() - ts < DISMISS_DAYS * 86_400_000;
}

function showChip(ev: BeforeInstallPromptEvent): void {
  if (document.querySelector('#pwaChip')) return;
  const chip = document.createElement('div');
  chip.id = 'pwaChip';
  chip.className = 'pwa-chip';
  chip.innerHTML = `
    <button type="button" class="pwa-install">⬇ Als App installieren</button>
    <button type="button" class="pwa-close" aria-label="Hinweis schließen">✕</button>`;
  document.body.append(chip);

  chip.querySelector<HTMLButtonElement>('.pwa-install')!.addEventListener('click', () => {
    chip.remove();
    void ev.prompt();
  });
  chip.querySelector<HTMLButtonElement>('.pwa-close')!.addEventListener('click', () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    chip.remove();
  });
}

export function initPwa(): void {
  if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW-Registrierung', e));
    });
  }

  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    if (isStandalone() || recentlyDismissed()) return;
    showChip(ev as BeforeInstallPromptEvent);
  });
  window.addEventListener('appinstalled', () => {
    document.querySelector('#pwaChip')?.remove();
  });
}
