/**
 * Listener-Multiplexing über Browserfenster (MILESTONES M9): n Fenster,
 * EIN Firestore-Listener-Satz für die geteilten market/**- und meta-Daten.
 *
 * Mechanik:
 * - Leader-Election über die Web-Locks-API: wer den Lock hält, ist Leader
 *   und hält die ECHTEN onSnapshot-Listener; stirbt der Leader-Tab, rückt
 *   der nächste Lock-Wartende nach und übernimmt alle Interessen.
 * - Follower melden Interesse ('want' je Key) über einen BroadcastChannel
 *   und bekommen jede Snapshot-Lieferung ('data') zugestellt — inklusive
 *   des gecachten letzten Stands direkt beim Anmelden.
 * - Keys sind fachlich ('marketDoc:QQQ', 'bars:TSLA', …); die Factory zum
 *   echten Listener liefert der Aufrufer mit — so kann JEDER Tab bei einer
 *   Leader-Übernahme jeden Key selbst abonnieren.
 *
 * Ohne BroadcastChannel/Web Locks (sehr alte Browser, Tests) degradiert
 * alles auf Direktmodus: jeder Tab abonniert selbst — funktional identisch.
 */

type Emit = (payload: unknown) => void;
export type RealFactory = (emit: Emit) => () => void;

interface MuxMsg {
  t: 'data' | 'want' | 'unwant' | 'leader' | 'bye';
  key?: string;
  payload?: unknown;
  tab?: string;
}

const TAB_ID = Math.random().toString(36).slice(2, 10);

const hasChannel = typeof BroadcastChannel !== 'undefined';
const hasLocks = typeof navigator !== 'undefined' && 'locks' in navigator;

let isLeader = !hasChannel || !hasLocks; // Direktmodus = jeder ist sein eigener Leader
const channel = hasChannel ? new BroadcastChannel('autotrd-mux') : null;

/** Lokale Abonnenten je Key (dieses Fenster). */
const local = new Map<string, Set<Emit>>();
/** Factories je Key — für (Re-)Subscribe bei Leader-Übernahme. */
const factories = new Map<string, RealFactory>();
/** Nur Leader: echte Listener + letzter Stand je Key. */
const live = new Map<string, { unsub: () => void; last?: unknown; hasLast: boolean }>();
/** Nur Leader: Interesse fremder Tabs je Key. */
const remoteWants = new Map<string, Set<string>>();

function post(msg: MuxMsg): void {
  channel?.postMessage(msg);
}

function ensureLive(key: string): void {
  if (!isLeader || live.has(key)) return;
  const real = factories.get(key);
  if (!real) return; // Interesse ohne Factory (kommt mit dem nächsten want)
  const entry: { unsub: () => void; last?: unknown; hasLast: boolean } = {
    unsub: () => undefined,
    hasLast: false,
  };
  live.set(key, entry);
  entry.unsub = real((payload) => {
    entry.last = payload;
    entry.hasLast = true;
    for (const cb of local.get(key) ?? []) cb(payload);
    post({ t: 'data', key, payload });
  });
}

function dropLiveIfUnwanted(key: string): void {
  if (!isLeader) return;
  const wanted = (local.get(key)?.size ?? 0) > 0 || (remoteWants.get(key)?.size ?? 0) > 0;
  if (!wanted) {
    live.get(key)?.unsub();
    live.delete(key);
  }
}

function becomeLeader(): void {
  isLeader = true;
  // Bestehende lokale Interessen echt abonnieren; fremde Tabs melden ihre
  // wants als Antwort auf die leader-Ansage erneut.
  for (const key of local.keys()) ensureLive(key);
  post({ t: 'leader' });
}

channel?.addEventListener('message', (ev: MessageEvent<MuxMsg>) => {
  const msg = ev.data;
  if (msg.t === 'data' && msg.key) {
    if (!isLeader) for (const cb of local.get(msg.key) ?? []) cb(msg.payload);
  } else if (msg.t === 'want' && msg.key && msg.tab) {
    if (!isLeader) return;
    const set = remoteWants.get(msg.key) ?? new Set<string>();
    set.add(msg.tab);
    remoteWants.set(msg.key, set);
    ensureLive(msg.key);
    const entry = live.get(msg.key);
    if (entry?.hasLast) post({ t: 'data', key: msg.key, payload: entry.last });
  } else if (msg.t === 'unwant' && msg.key && msg.tab) {
    remoteWants.get(msg.key)?.delete(msg.tab);
    dropLiveIfUnwanted(msg.key);
  } else if (msg.t === 'leader') {
    // Neuer Leader sammelt Interessen ein → eigene wants erneut melden
    if (!isLeader) {
      for (const key of local.keys()) post({ t: 'want', key, tab: TAB_ID });
    }
  } else if (msg.t === 'bye' && msg.tab) {
    if (!isLeader) return;
    for (const [key, tabs] of remoteWants) {
      tabs.delete(msg.tab);
      dropLiveIfUnwanted(key);
    }
  }
});

if (hasChannel && hasLocks) {
  // Lock-Halter = Leader; das Promise bleibt offen, bis der Tab stirbt —
  // dann bekommt der nächste Wartende den Lock und übernimmt.
  void navigator.locks.request('autotrd-mux-leader', () => {
    becomeLeader();
    return new Promise<void>(() => undefined);
  });
  window.addEventListener('pagehide', () => post({ t: 'bye', tab: TAB_ID }));
}

/**
 * Geteilten Watcher abonnieren. Leader hält den echten Listener, Follower
 * bekommen Broadcasts (0 eigene Firestore-Listener für diesen Key).
 */
export function muxWatch(key: string, real: RealFactory, cb: Emit): () => void {
  factories.set(key, real);
  const set = local.get(key) ?? new Set<Emit>();
  set.add(cb);
  local.set(key, set);

  if (isLeader) {
    ensureLive(key);
    const entry = live.get(key);
    if (entry?.hasLast) cb(entry.last);
  } else {
    post({ t: 'want', key, tab: TAB_ID });
  }

  return () => {
    const cbs = local.get(key);
    cbs?.delete(cb);
    if (cbs && cbs.size === 0) {
      local.delete(key);
      if (isLeader) dropLiveIfUnwanted(key);
      else post({ t: 'unwant', key, tab: TAB_ID });
    }
  };
}

/** Für Tests/Diagnose: ist dieses Fenster der Leader? */
export function muxIsLeader(): boolean {
  return isLeader;
}
