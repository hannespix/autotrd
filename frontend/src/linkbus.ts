/**
 * Link-Bus (MILESTONES M9) — „gemeinsame Aufmerksamkeit" zwischen Panels.
 *
 * Drei Link-Gruppen A/B/C halten je ein aktuelles Symbol; Panels abonnieren
 * ihre Gruppe und folgen deren Symbolwechseln. Rein clientseitig — der Bus
 * erzeugt selbst KEINE Firestore-Reads (Panels verwalten ihre Listener).
 * Zeit-/Crosshair-Events folgen mit dem Chart-Stack (M9 Teil 2).
 */

export type LinkGroup = 'A' | 'B' | 'C';

export const GROUP_COLORS: Record<LinkGroup, string> = {
  A: '#25d0ee', // Aurora-Cyan
  B: '#b98aff', // Aurora-Violett
  C: '#ffb86b', // Aurora-Amber
};

type SymbolHandler = (symbol: string) => void;

const symbols: Record<LinkGroup, string> = { A: 'QQQ', B: 'QQQ', C: 'QQQ' };
const subscribers = new Map<object, { group: LinkGroup; onSymbol: SymbolHandler }>();

/** Aktuelles Symbol einer Gruppe. */
export function groupSymbol(group: LinkGroup): string {
  return symbols[group];
}

/** Symbol einer Gruppe setzen — benachrichtigt alle Panels dieser Gruppe. */
export function publishSymbol(group: LinkGroup, symbol: string): void {
  if (symbols[group] === symbol) return;
  symbols[group] = symbol;
  for (const sub of subscribers.values()) {
    if (sub.group === group) sub.onSymbol(symbol);
  }
}

/**
 * Panel anmelden. `key` identifiziert den Abonnenten (beliebiges Objekt,
 * z. B. das Panel-Element). Liefert eine unsubscribe-Funktion.
 */
export function subscribe(key: object, group: LinkGroup, onSymbol: SymbolHandler): () => void {
  subscribers.set(key, { group, onSymbol });
  return () => subscribers.delete(key);
}

/** Gruppe eines bestehenden Abonnenten wechseln (Link-Chip-Klick). */
export function setGroup(key: object, group: LinkGroup): void {
  const sub = subscribers.get(key);
  if (!sub) return;
  sub.group = group;
  sub.onSymbol(symbols[group]);
}

export function nextGroup(g: LinkGroup): LinkGroup {
  return g === 'A' ? 'B' : g === 'B' ? 'C' : 'A';
}

/** Startzustand (z. B. beim Workspace-Laden) ohne Notify setzen. */
export function seedSymbols(next: Partial<Record<LinkGroup, string>>): void {
  Object.assign(symbols, next);
}

/** Nur für Unmount-Aufräumen. */
export function clearSubscribers(): void {
  subscribers.clear();
}
