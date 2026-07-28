/**
 * Strategie-Studio (M10): #/strategy (Liste) und #/strategy/{id} (Editor).
 *
 * Karten-Builder v1: weighted-Wurzeln bekommen Threshold-Stepper +
 * Gewicht-Badges, all/any-Wurzeln einfache Karten-Listen; jedes der 9
 * Blatt-Typen ist anleg- und editierbar. Andere Wurzelformen (z. B.
 * kompilierte Classic-Bäume) zeigt v1 als Nur-Lesen-JSON.
 * Die Live-Vorschau läuft KOMPLETT clientseitig über gecachte Bars
 * (preview.ts) — Label: „Vorschau, kein Backtest".
 */

import {
  validateRuleTree,
  validateStrategySpec,
  type RuleNode,
  type StrategySpec,
} from '@autotrd/shared';
import {
  callAssignStrategy,
  callDeleteStrategy,
  callPromoteStrategy,
  callPublishStrategy,
  callRunBacktest,
  callRunSweep,
  callSaveStrategyDraft,
  type SweepResult,
  type SweepRow,
  loadBarsOnce,
  loadMarketQuotes,
  loadShadowSignals,
  loadStrategyPresets,
  loadWalletSnapshot,
  watchLatestRun,
  watchStrategies,
  type BacktestRunDoc,
  type StrategyRow,
} from './data.js';
import { previewSignals, type PreviewBar } from './preview.js';
import { iBtn, initInfoTips } from './infotips.js';
import { esc } from './html.js';

let cleanup: (() => void) | null = null;
let runSub: (() => void) | null = null;

interface EditorState {
  uid: string;
  id: string | null; // null = neu
  name: string;
  spec: StrategySpec;
  status: string;
  version: number | null;
  symbols: string[];
  mode: 'paper' | 'shadow';
  shadow: import('@autotrd/shared').ShadowAccount | null;
  previewSymbol: string;
  /** Statuszeile — überlebt Rerenders (Publish/Save rendern neu). */
  msg: string;
  barsCache: Map<string, { bars: PreviewBar[] }>;
}

/**
 * Blatt-Typen, die der Builder ANBIETET.
 *
 * `sentiment` und `newsEvent` fehlen seit 28.07.: Kein Lauf füllt mehr die
 * Felder, auf die sie zugreifen. Im Schema bleiben sie (gespeicherte
 * Strategien müssen lesbar bleiben) und liefern beim Auswerten „unbekannt"
 * — was kein Trade bedeutet. Sie hier weiter anzubieten hieße, eine Regel
 * zu verkaufen, die nie feuert.
 */
const LEAF_TYPES = [
  'compare',
  'crossover',
  'priceLevel',
  'changePct',
  'timeWindow',
  'forecast',
  'position',
] as const;

const VALUE_KEYS = ['rsi', 'price', 'macdLine', 'macdSignal', 'macdHistogram', 'pctB', 'bbUpper', 'bbMiddle', 'bbLower'];

function defaultLeaf(type: (typeof LEAF_TYPES)[number]): RuleNode {
  switch (type) {
    case 'compare':
      return { type, left: 'rsi', op: 'lt', right: 30 };
    case 'crossover':
      return { type, fast: 'macdLine', slow: 'macdSignal', direction: 'above' };
    case 'priceLevel':
      return { type, level: 100, side: 'above' };
    case 'changePct':
      return { type, lookbackBars: 5, op: 'gte', pct: 3 };
    case 'timeWindow':
      return { type, start: '09:30', end: '16:00' };
    case 'forecast':
      return { type, direction: 'up', minAbsPct: 0.5 };
    case 'position':
      return { type, state: 'none' };
  }
}

/** Kompakte Ein-Zeilen-Beschreibung eines Blatts für die Karte. */
function leafLabel(n: RuleNode): string {
  switch (n.type) {
    case 'compare': {
      const right = typeof n.right === 'number' ? String(n.right) : n.right.key;
      return `${n.left} ${{ lt: '<', lte: '≤', gt: '>', gte: '≥' }[n.op]} ${right}`;
    }
    case 'crossover':
      return `${n.fast} kreuzt ${n.direction === 'above' ? '↑' : '↓'} ${n.slow}`;
    case 'priceLevel':
      return `Preis ${n.side === 'above' ? '>' : '<'} ${n.level}`;
    case 'changePct':
      return `Δ ${n.lookbackBars} Bars ${n.op === 'gte' ? '≥' : '≤'} ${n.pct} %`;
    case 'timeWindow':
      return `${n.start}–${n.end} ET`;
    case 'forecast':
      return `Prognose ${n.direction === 'up' ? '↑' : '↓'} ≥ ${n.minAbsPct} %`;
    case 'position':
      return `Position ${n.state === 'open' ? 'offen' : 'keine'}${n.minUnrealizedPct !== undefined ? ` ≥ ${n.minUnrealizedPct} %` : ''}${n.maxUnrealizedPct !== undefined ? ` ≤ ${n.maxUnrealizedPct} %` : ''}`;
    default:
      return n.type;
  }
}

/** Parameter-Inputs eines Blatts; data-f benennt das Feld. */
function leafInputs(n: RuleNode): string {
  const num = (f: string, v: number, step = 1): string =>
    `<input class="inp st-num" data-f="${f}" type="number" step="${step}" value="${v}" />`;
  const sel = (f: string, v: string, opts: string[]): string =>
    `<select class="sel" data-f="${f}">${opts.map((o) => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
  switch (n.type) {
    case 'compare':
      return `${sel('left', n.left, VALUE_KEYS)} ${sel('op', n.op, ['lt', 'lte', 'gt', 'gte'])} ${num('right', typeof n.right === 'number' ? n.right : 0, 0.1)}`;
    case 'crossover':
      return `${sel('fast', n.fast, VALUE_KEYS)} ${sel('direction', n.direction, ['above', 'below'])} ${sel('slow', n.slow, VALUE_KEYS)}`;
    case 'priceLevel':
      return `${sel('side', n.side, ['above', 'below'])} ${num('level', n.level, 0.5)}`;
    case 'changePct':
      return `${num('lookbackBars', n.lookbackBars)} Bars ${sel('op', n.op, ['gte', 'lte'])} ${num('pct', n.pct, 0.5)} %`;
    case 'timeWindow':
      return `<input class="inp st-time" data-f="start" value="${n.start}" /> – <input class="inp st-time" data-f="end" value="${n.end}" />`;
    case 'forecast':
      return `${sel('direction', n.direction, ['up', 'down'])} ≥ ${num('minAbsPct', n.minAbsPct, 0.1)} %`;
    case 'position':
      return `${sel('state', n.state, ['none', 'open'])} ${n.state === 'open' ? `min% ${num('minUnrealizedPct', n.minUnrealizedPct ?? 0, 0.5)} max% ${num('maxUnrealizedPct', n.maxUnrealizedPct ?? 100, 0.5)}` : ''}`;
    default:
      return '';
  }
}

function applyLeafField(n: RuleNode, field: string, raw: string): void {
  const rec = n as unknown as Record<string, unknown>;
  if (field === 'tags') {
    rec[field] = raw.split(',').map((t) => t.trim()).filter(Boolean);
  } else if (['left', 'fast', 'slow', 'op', 'direction', 'side', 'state', 'start', 'end'].includes(field)) {
    rec[field] = raw;
  } else if (field === 'right') {
    rec[field] = Number(raw);
  } else {
    rec[field] = Number(raw);
  }
}

/** Editierbare Wurzel? v1: weighted / all / any. */
function editableRoot(n: RuleNode): n is Extract<RuleNode, { type: 'weighted' | 'all' | 'any' }> {
  return n.type === 'weighted' || n.type === 'all' || n.type === 'any';
}

function renderTreeCard(side: 'buy' | 'sell', root: RuleNode): string {
  const title = side === 'buy' ? 'Kaufen (Entry)' : 'Verkaufen (Exit)';
  const color = side === 'buy' ? 'c-gn' : 'c-rd';
  if (!editableRoot(root)) {
    return `<section class="card st-tree" data-side="${side}">
      <h3 class="${color}">${title}</h3>
      <p class="hint">Diese Baum-Form zeigt v1 nur als JSON (z. B. kompilierte Classic-Strategie):</p>
      <pre class="st-json">${esc(JSON.stringify(root, null, 1))}</pre>
    </section>`;
  }
  const kids =
    root.type === 'weighted'
      ? root.children.map((c, i) => ({ node: c.node, weight: c.weight, i }))
      : root.children.map((c, i) => ({ node: c, weight: null as number | null, i }));
  return `<section class="card st-tree" data-side="${side}">
    <h3 class="${color}">${title}</h3>
    <div class="st-root row">
      <label>Verknüpfung ${iBtn('link')}
        <select class="sel" data-root="type">
          ${['weighted', 'all', 'any'].map((t) => `<option ${t === root.type ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </label>
      ${
        root.type === 'weighted'
          ? `<label>Threshold ${iBtn('threshold')}
              <span class="st-stepper">
                <button type="button" class="btn btn-n" data-thr="-1">−</button>
                <b class="mono" data-thr-val>${root.threshold}</b>
                <button type="button" class="btn btn-n" data-thr="1">+</button>
              </span>
            </label>`
          : ''
      }
    </div>
    <div class="st-kids">
      ${kids
        .map(
          (k) => `<div class="st-leaf" data-i="${k.i}">
            <div class="st-leaf-head">
              <span class="chip">${k.node.type}</span>${iBtn(`node:${k.node.type}`)}
              ${k.weight !== null ? `<span class="chip st-w">Gewicht${iBtn('weight')} <input class="inp st-num" data-w="${k.i}" type="number" step="0.5" min="0.5" value="${k.weight}" /></span>` : ''}
              <span class="st-leaf-label mono">${esc(leafLabel(k.node))}</span>
              <button type="button" class="btn btn-n st-del" data-del="${k.i}" aria-label="Regel entfernen">✕</button>
            </div>
            <div class="st-leaf-params">${leafInputs(k.node)}</div>
          </div>`,
        )
        .join('')}
    </div>
    <div class="row st-add">
      <select class="sel" data-add-type>${LEAF_TYPES.map((t) => `<option>${t}</option>`).join('')}</select>
      <button type="button" class="btn btn-n" data-add>+ Regel</button>
    </div>
  </section>`;
}

function svgPreview(bars: PreviewBar[], res: ReturnType<typeof previewSignals>): string {
  if (bars.length < 2) return '<p class="hint">Noch keine Bars im Cache — Symbol wird vom nächsten Scan befüllt.</p>';
  const W = 640;
  const H = 160;
  const closes = bars.map((b) => b.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const x = (i: number): number => (i / (bars.length - 1)) * (W - 10) + 5;
  const y = (v: number): number => H - 18 - ((v - min) / (max - min || 1)) * (H - 36);
  const path = closes.map((c, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(c).toFixed(1)}`).join(' ');
  const holds = res.holds
    .map(
      ([a, b]) =>
        `<rect x="${x(a).toFixed(1)}" y="8" width="${(x(b) - x(a)).toFixed(1)}" height="${H - 26}" class="st-hold" />`,
    )
    .join('');
  const marks = res.markers
    .map((m) =>
      m.dir === 'buy'
        ? `<path d="M${x(m.index)},${y(closes[m.index]!) + 14} l6,10 h-12 z" class="st-mk-buy"><title>Kauf ${m.date}</title></path>`
        : `<path d="M${x(m.index)},${y(closes[m.index]!) - 14} l6,-10 h-12 z" class="st-mk-sell"><title>Verkauf ${m.date}</title></path>`,
    )
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Vorschau-Chart">${holds}<path d="${path}" class="st-line" />${marks}</svg>`;
}

/** A/B-Duell füllen: A = echtes Paper-Wallet (mark-to-market), B = Shadow. */
async function fillAbDuel(root: HTMLElement, st: EditorState): Promise<void> {
  const grid = root.querySelector<HTMLDivElement>('#abGrid');
  const feed = root.querySelector<HTMLDivElement>('#abFeed');
  if (!grid || !feed || !st.shadow || !st.id) return;
  try {
    const [wallet, quotes, signals] = await Promise.all([
      loadWalletSnapshot(st.uid),
      loadMarketQuotes(),
      loadShadowSignals(st.uid, st.id),
    ]);
    const posVal = wallet.positions.reduce(
      (sum, p) => sum + p.qty * (quotes.get(p.symbol)?.quote?.price ?? p.avgEntry),
      0,
    );
    const equityA = wallet.balance + posVal;
    const retA = ((equityA - wallet.initialCapital) / wallet.initialCapital) * 100;
    const retB = ((st.shadow.equity - 25_000) / 25_000) * 100;
    const side = (
      label: string,
      equity: number,
      ret: number,
      detail: string,
      win: boolean,
    ): string => `
      <div class="ab-side${win ? ' ab-win' : ''}">
        <b>${label}${win ? ' <span class="chip">vorn</span>' : ''}</b>
        <span>Equity ${equity.toFixed(2)} $</span>
        <span class="${ret >= 0 ? 'c-gn' : 'c-rd'}">${ret >= 0 ? '+' : ''}${ret.toFixed(2)} % seit Start</span>
        <span>${detail}</span>
      </div>`;
    grid.innerHTML =
      side('A · Paper-Wallet', equityA, retA, `${wallet.positions.length} Position(en) · Cash ${wallet.balance.toFixed(2)} $ · Start ${wallet.initialCapital} $`, retA > retB) +
      side(`B · ${esc(st.name)}`, st.shadow.equity, retB, `${Object.keys(st.shadow.positions ?? {}).length} Position(en) · Cash ${st.shadow.balance.toFixed(2)} $ · Start 25000 $`, retB > retA) +
      `<p class="ab-div hint">Divergenz: ${Math.abs(retB - retA).toFixed(2)} Prozentpunkte ${retB === retA ? '(Patt)' : retB > retA ? 'für B' : 'für A'} —
        beide Seiten handeln mit derselben Risiko-Hülle.</p>`;
    feed.innerHTML =
      signals.length === 0
        ? '<p class="hint">Noch keine Hätte-Signale — sie entstehen nur, wenn der Scan die Richtung wechselt.</p>'
        : `<div class="tw"><table class="tbl">
            <thead><tr><th>Zeit (UTC)</th><th>Symbol</th><th>Hätte …</th><th>Kurs</th></tr></thead>
            <tbody>${signals
              .map(
                (s) => `<tr>
                  <td class="mono">${esc(s.at?.slice(0, 16).replace('T', ' ') ?? s.id.slice(0, 16))}</td>
                  <td class="mono">${esc(s.symbol)}</td>
                  <td class="${s.direction === 'buy' ? 'c-gn' : 'c-rd'}">${s.direction === 'buy' ? 'GEKAUFT' : 'VERKAUFT'}</td>
                  <td class="mono">${s.price.toFixed(2)} $</td>
                </tr>`,
              )
              .join('')}</tbody>
          </table></div>`;
  } catch (e) {
    console.warn('A/B-Duell nicht ladbar:', e);
    grid.innerHTML = '<p class="hint">Duell-Daten gerade nicht lesbar.</p>';
  }
}

async function renderEditor(root: HTMLElement, st: EditorState): Promise<void> {
  runSub?.();
  runSub = null;
  const problems = validateStrategySpec(st.spec);
  root.innerHTML = `
    <main class="st-wrap">
      <header class="st-head">
        <a class="btn btn-n" href="#/strategy">← Studio</a>
        <input id="stName" class="inp st-name" value="${esc(st.name)}" maxlength="60" aria-label="Name" />
        <span class="chip">${st.status}${st.version ? ` · v${st.version}` : ''}</span>
      </header>
      <div class="st-cols">
        <div class="st-col" id="stTrees">
          ${renderTreeCard('buy', st.spec.buy)}
          ${renderTreeCard('sell', st.spec.sell)}
          ${problems.length > 0 ? `<p class="error" role="alert">${esc(problems[0]!)}</p>` : ''}
          <div class="row st-actions">
            <button type="button" id="stSave" class="btn btn-g">Entwurf speichern</button>
            <button type="button" id="stPublish" class="btn btn-n" ${st.id ? '' : 'disabled'}>Publizieren</button>
            <button type="button" id="stDelete" class="btn btn-n st-del" ${st.id ? '' : 'disabled'}
              title="Strategie endgültig löschen — auch publizierte. Offene Positionen bleiben im Wallet und werden von Stop/Take/Konfluenz weiter verwaltet.">Löschen</button>
          </div>
          <div class="row st-assign">
            <input id="stSymbols" class="inp" value="${esc(st.symbols.join(', '))}" placeholder="Symbole, z. B. QQQ, BTC-USD" aria-label="Zuordnung" />
            ${iBtn('modus')}<select id="stMode" class="sel" aria-label="Modus" title="paper = echtes Paper-Wallet · shadow = nur beobachten (virtuelles Konto)">
              <option value="paper" ${st.mode === 'paper' ? 'selected' : ''}>paper</option>
              <option value="shadow" ${st.mode === 'shadow' ? 'selected' : ''}>shadow</option>
            </select>
            <button type="button" id="stAssign" class="btn btn-n" ${st.id ? '' : 'disabled'}>Zuordnen</button>
          </div>
          ${
            st.mode === 'shadow' && st.shadow
              ? `<section class="card st-shadow">
                  <h3>A/B-Duell <span class="chip">A = Paper-Wallet (echt) · B = diese Strategie (virtuell)</span> ${iBtn('divergenz')}</h3>
                  <div class="ab-grid mono" id="abGrid"><p class="hint">Lade Duell …</p></div>
                  <div class="row st-actions">
                    <button type="button" id="stPromote" class="btn btn-g"
                      title="Rollentausch: B handelt ab dem nächsten Scan das echte Paper-Wallet; überlappende Paper-Strategien beobachten als Shadow weiter">B befördern</button>
                  </div>
                  <p class="hint">Befördern tauscht nur die Rollen (transaktional) — dein Wallet und
                  offene Positionen bleiben unangetastet. Seit ${st.shadow.startedAt.slice(0, 10)}.</p>
                  <h3 class="ab-h">Hätte-Feed <span class="chip">Signale nur bei Richtungs-Wechsel</span></h3>
                  <div id="abFeed"><p class="hint">Lade …</p></div>
                </section>`
              : ''
          }
          <p id="stMsg" class="hint" role="status">${esc(st.msg)}</p>
        </div>
        <div class="st-col">
          <section class="card st-preview">
            <h3>Live-Vorschau <span class="chip">Vorschau, kein Backtest</span> ${iBtn('preview')}</h3>
            <div class="row">
              <input id="stPrevSym" class="inp st-sym" value="${esc(st.previewSymbol)}" aria-label="Vorschau-Symbol" />
              <button type="button" id="stPrevLoad" class="btn btn-n">Laden</button>
            </div>
            <div id="stPrevChart" class="st-chart" aria-live="polite"></div>
            <p class="hint">Auswertung alle 5 min · Annahmen: 10:00 ET je Tages-Bar, Prognose in der
            Vorschau unbekannt · Marker ▲ Kauf / ▼ Verkauf, Bänder = Haltephasen</p>
          </section>
          <section class="card st-report">
            <h3>Backtest <span class="chip">1 Jahr Tages-Bars · inkl. Kosten</span> ${iBtn('backtest')}</h3>
            <div class="row">
              <button type="button" id="stBacktest" class="btn btn-n" ${st.id ? '' : 'disabled'}>Backtest starten</button>
              <span class="hint">max. 10/Tag</span>
            </div>
            <div id="stRun" aria-live="polite"><p class="hint">Noch kein Report.</p></div>
          </section>
          <section class="card st-sweep">
            <h3>Parameter-Sweep <span class="chip">Classic-Basis · ≤ 60 Kombis · kein Auto-Apply</span> ${iBtn('sweep')}</h3>
            <div class="row">
              <label>X <select id="swX" class="inp"></select></label>
              <label>Y <select id="swY" class="inp"></select></label>
              <button type="button" id="swRun" class="btn btn-n">Sweep starten</button>
              <span class="hint">max. 5/Tag · Symbol = Vorschau-Symbol</span>
            </div>
            <div id="swOut" aria-live="polite"><p class="hint">Noch kein Sweep.</p></div>
          </section>
        </div>
      </div>
    </main>`;

  const msg = root.querySelector<HTMLParagraphElement>('#stMsg')!;
  const say = (t: string): void => {
    st.msg = t;
    msg.textContent = t;
  };

  const rerender = (): void => void renderEditor(root, st);

  // Vorschau — rein clientseitig; Bars je Symbol gecacht
  const chartBox = root.querySelector<HTMLDivElement>('#stPrevChart')!;
  const updatePreview = async (): Promise<void> => {
    const sym = st.previewSymbol.trim().toUpperCase();
    let cached = st.barsCache.get(sym);
    if (!cached) {
      chartBox.innerHTML = '<p class="hint">Lade Bars …</p>';
      try {
        const bars = await loadBarsOnce(sym);
        cached = { bars: bars.map((b) => ({ date: b.date, close: b.close })) };
        st.barsCache.set(sym, cached);
      } catch {
        chartBox.innerHTML = '<p class="error">Bars nicht lesbar (Symbol unbekannt?)</p>';
        return;
      }
    }
    const probs = validateStrategySpec(st.spec);
    if (probs.length > 0) {
      chartBox.innerHTML = `<p class="error">Spec ungültig: ${esc(probs[0]!)}</p>`;
      return;
    }
    const res = previewSignals(st.spec, cached.bars);
    chartBox.innerHTML =
      svgPreview(cached.bars, res) +
      `<p class="hint mono">${res.markers.filter((m) => m.dir === 'buy').length} Käufe · ${res.markers.filter((m) => m.dir === 'sell').length} Verkäufe · ${res.evaluatedBars} Bars ausgewertet</p>`;
  };
  void updatePreview();

  root.querySelector('#stPrevLoad')!.addEventListener('click', () => {
    st.previewSymbol = root.querySelector<HTMLInputElement>('#stPrevSym')!.value;
    void updatePreview();
  });
  root.querySelector<HTMLInputElement>('#stName')!.addEventListener('input', (e) => {
    st.name = (e.target as HTMLInputElement).value;
  });

  // Baum-Interaktionen (delegiert je Karte)
  root.querySelectorAll<HTMLElement>('.st-tree').forEach((card) => {
    const side = card.dataset.side as 'buy' | 'sell';
    const getRoot = (): RuleNode => st.spec[side];
    const setRoot = (n: RuleNode): void => {
      st.spec[side] = n;
    };

    card.querySelector<HTMLSelectElement>('[data-root="type"]')?.addEventListener('change', (e) => {
      const t = (e.target as HTMLSelectElement).value as 'weighted' | 'all' | 'any';
      const cur = getRoot();
      if (!editableRoot(cur)) return;
      const plain = cur.type === 'weighted' ? cur.children.map((c) => c.node) : cur.children;
      setRoot(
        t === 'weighted'
          ? { type: 'weighted', threshold: 1, children: plain.map((n) => ({ weight: 1, node: n })) }
          : { type: t, children: plain },
      );
      rerender();
    });

    card.querySelectorAll<HTMLButtonElement>('[data-thr]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const cur = getRoot();
        if (cur.type !== 'weighted') return;
        cur.threshold = Math.max(0.5, cur.threshold + Number(btn.dataset.thr));
        rerender();
      }),
    );

    card.querySelectorAll<HTMLInputElement>('[data-w]').forEach((inp) =>
      inp.addEventListener('change', () => {
        const cur = getRoot();
        if (cur.type !== 'weighted') return;
        const child = cur.children[Number(inp.dataset.w)];
        if (child) child.weight = Math.max(0.5, Number(inp.value) || 1);
        void updatePreview();
      }),
    );

    card.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const cur = getRoot();
        if (!editableRoot(cur)) return;
        cur.children.splice(Number(btn.dataset.del), 1);
        rerender();
      }),
    );

    card.querySelector<HTMLButtonElement>('[data-add]')?.addEventListener('click', () => {
      const cur = getRoot();
      if (!editableRoot(cur)) return;
      const t = card.querySelector<HTMLSelectElement>('[data-add-type]')!.value as (typeof LEAF_TYPES)[number];
      const leaf = defaultLeaf(t);
      if (cur.type === 'weighted') cur.children.push({ weight: 1, node: leaf });
      else cur.children.push(leaf);
      rerender();
    });

    // Blatt-Parameter: direkt in den Spec-Baum schreiben, Vorschau neu
    card.querySelectorAll<HTMLElement>('.st-leaf').forEach((leafEl) => {
      const idx = Number(leafEl.dataset.i);
      leafEl.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-f]').forEach((inp) =>
        inp.addEventListener('change', () => {
          const cur = getRoot();
          if (!editableRoot(cur)) return;
          const node = cur.type === 'weighted' ? cur.children[idx]?.node : cur.children[idx];
          if (!node) return;
          applyLeafField(node, inp.dataset.f!, inp.value);
          const label = leafEl.querySelector('.st-leaf-label');
          if (label) label.textContent = leafLabel(node);
          void updatePreview();
        }),
      );
    });
  });

  root.querySelector('#stSave')!.addEventListener('click', () => {
    const probs = [...validateRuleTree(st.spec.buy).map((p) => `buy: ${p}`), ...validateRuleTree(st.spec.sell).map((p) => `sell: ${p}`)];
    if (probs.length > 0) {
      say(`✗ ${probs[0]}`);
      return;
    }
    say('Speichere …');
    callSaveStrategyDraft({ ...(st.id ? { id: st.id } : {}), name: st.name || 'Unbenannt', spec: st.spec })
      .then((id) => {
        st.id = id;
        say('✓ Entwurf gespeichert');
        location.hash = `#/strategy/${id}`;
        rerender();
      })
      .catch((e) => say(`✗ ${(e as Error).message}`));
  });

  root.querySelector('#stPublish')!.addEventListener('click', () => {
    if (!st.id) return;
    say('Publiziere …');
    callPublishStrategy(st.id)
      .then((v) => {
        st.status = 'published';
        st.version = v;
        say(`✓ Version ${v} publiziert — handelt beim nächsten Scan der zugeordneten Symbole`);
        rerender();
      })
      .catch((e) => say(`✗ ${(e as Error).message}`));
  });

  // Löschen mit 2-Klick-Armierung (Owner-Frage 26.07.) — gilt auch für
  // publizierte: danach übernimmt der Classic-Pfad die Symbole wieder,
  // offene Positionen bleiben im Wallet unter Stop/Take/Konfluenz.
  const delBtn = root.querySelector<HTMLButtonElement>('#stDelete')!;
  delBtn.addEventListener('click', () => {
    if (!st.id) return;
    if (!delBtn.classList.contains('armed')) {
      delBtn.classList.add('armed');
      delBtn.textContent = 'Wirklich löschen?';
      window.setTimeout(() => {
        delBtn.classList.remove('armed');
        delBtn.textContent = 'Löschen';
      }, 4000);
      return;
    }
    delBtn.disabled = true;
    say('Lösche …');
    callDeleteStrategy(st.id)
      .then(() => {
        location.hash = '#/strategy';
      })
      .catch((e) => {
        delBtn.disabled = false;
        say(`✗ ${(e as Error).message}`);
      });
  });

  const runBox = root.querySelector<HTMLDivElement>('#stRun')!;
  const renderRun = (run: BacktestRunDoc | null): void => {
    if (!run) return;
    const eq = run.equityCurve;
    let spark = '';
    if (eq.length > 1) {
      const vals = eq.map((p) => p.value);
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const pts = vals
        .map((v, i) => `${((i / (vals.length - 1)) * 300).toFixed(1)},${(60 - ((v - min) / (max - min || 1)) * 52 + 4).toFixed(1)}`)
        .join(' ');
      spark = `<svg viewBox="0 0 300 64" class="st-spark" role="img" aria-label="Equity-Kurve"><polyline points="${pts}" /></svg>`;
    }
    const pct = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)} %`;
    runBox.innerHTML = `
      ${spark}
      <div class="st-metrics mono">
        <span class="${run.totalReturnPct >= 0 ? 'c-gn' : 'c-rd'}">${pct(run.totalReturnPct)} Rendite</span>
        <span>${pct(run.buyHoldPct)} Buy&amp;Hold ${iBtn('buyhold')}</span>
        <span>${run.numTrades} Trades · ${run.winRatePct.toFixed(0)} % Winrate ${iBtn('winrate')}</span>
        <span>MaxDD ${run.maxDrawdownPct.toFixed(1)} % ${iBtn('maxdd')} · Sharpe ${run.sharpe.toFixed(2)} ${iBtn('sharpe')}</span>
      </div>
      <p class="hint">${run.symbol} · ${run.barsFrom} → ${run.barsTo} · ${run.specSource === 'compiled' ? 'publizierte Version' : 'Entwurf'} · ${run.at.slice(0, 16).replace('T', ' ')}Z</p>`;
  };
  if (st.id) runSub = watchLatestRun(st.uid, st.id, renderRun);

  root.querySelector('#stBacktest')!.addEventListener('click', () => {
    if (!st.id) return;
    say('Backtest läuft …');
    callRunBacktest(st.id, st.previewSymbol.trim().toUpperCase() || 'QQQ')
      .then(() => say('✓ Backtest fertig — Report unten'))
      .catch((e) => say(`✗ ${(e as Error).message}`));
  });

  // Parameter-Sweep (M11): Achsen wählen → Heatmap → besten Punkt als Entwurf
  const SWEEP_AXES: Record<string, { label: string; values: number[] }> = {
    rsiBuy: { label: 'RSI Kauf <', values: [20, 25, 30, 35, 40] },
    rsiSell: { label: 'RSI Verkauf >', values: [60, 65, 70, 75, 80] },
    bbBreakout: { label: 'BB-Ausbruch %', values: [70, 80, 90, 100] },
    minConfluence: { label: 'Min. Konfluenz', values: [1, 2, 3] },
    forecastWeight: { label: 'Prognose-Gewicht', values: [0, 1, 2] },
  };
  const swX = root.querySelector<HTMLSelectElement>('#swX')!;
  const swY = root.querySelector<HTMLSelectElement>('#swY')!;
  for (const [key, ax] of Object.entries(SWEEP_AXES)) {
    swX.add(new Option(ax.label, key, key === 'rsiBuy', key === 'rsiBuy'));
    swY.add(new Option(ax.label, key, key === 'minConfluence', key === 'minConfluence'));
  }
  swY.add(new Option('— keine —', ''));
  const swOut = root.querySelector<HTMLElement>('#swOut')!;
  root.querySelector('#swRun')!.addEventListener('click', () => {
    const xParam = swX.value;
    const yParam = swY.value || undefined;
    if (yParam === xParam) {
      say('✗ X- und Y-Parameter müssen verschieden sein');
      return;
    }
    say('Sweep läuft — bis zu 60 Backtests …');
    callRunSweep({
      symbol: st.previewSymbol.trim().toUpperCase() || 'QQQ',
      xParam,
      xValues: SWEEP_AXES[xParam]!.values,
      ...(yParam ? { yParam, yValues: SWEEP_AXES[yParam]!.values } : {}),
    })
      .then((res) => {
        say(`✓ Sweep fertig — ${res.combos} Kombis (${res.barsFrom} … ${res.barsTo})`);
        renderSweep(res, xParam, yParam);
      })
      .catch((e) => say(`✗ ${(e as Error).message}`));
  });
  const renderSweep = (res: SweepResult, xParam: string, yParam?: string): void => {
    const xs = [...new Set(res.rows.map((r) => r.x))].sort((a, b) => a - b);
    const ys = [...new Set(res.rows.map((r) => r.y))].sort((a, b) => (a ?? 0) - (b ?? 0));
    const byKey = new Map(res.rows.map((r) => [`${r.x}|${r.y}`, r]));
    const maxAbs = Math.max(1e-9, ...res.rows.map((r) => Math.abs(r.totalReturnPct)));
    const cell = (r: SweepRow | undefined): string => {
      if (!r) return '<td></td>';
      const a = (Math.abs(r.totalReturnPct) / maxAbs) * 0.55;
      const bg = r.totalReturnPct >= 0 ? `rgba(38,207,157,${a})` : `rgba(242,88,107,${a})`;
      const isBest = r === res.best || (r.x === res.best.x && r.y === res.best.y);
      return `<td class="sw-cell${isBest ? ' sw-best' : ''}" style="background:${bg}"
        title="Rendite ${r.totalReturnPct.toFixed(1)} % · Sharpe ${r.sharpe.toFixed(2)} · MaxDD ${r.maxDrawdownPct.toFixed(1)} % · ${r.numTrades} Trades · Winrate ${r.winRatePct.toFixed(0)} %">
        ${r.totalReturnPct.toFixed(1)}</td>`;
    };
    const xl = SWEEP_AXES[xParam]!.label;
    const yl = yParam ? SWEEP_AXES[yParam]!.label : '';
    swOut.innerHTML = `
      <div class="sw-wrap"><table class="sw-tbl mono">
        <tr><th>${yParam ? `${yl} \\ ${xl}` : xl}</th>${xs.map((x) => `<th>${x}</th>`).join('')}</tr>
        ${ys.map((y) => `<tr><th>${y ?? '—'}</th>${xs.map((x) => cell(byKey.get(`${x}|${y}`))).join('')}</tr>`).join('')}
      </table></div>
      <p class="hint">Zellen = Rendite % (Hover zeigt Sharpe/MaxDD/Trades) · bester Punkt umrandet:
        ${xl} = <b>${res.best.x}</b>${yParam ? ` · ${yl} = <b>${res.best.y}</b>` : ''} →
        ${res.best.totalReturnPct.toFixed(1)} % · Sharpe ${res.best.sharpe.toFixed(2)}</p>
      <button type="button" id="swAdopt" class="btn btn-g">Als Entwurf übernehmen</button>
      <span class="hint">legt eine NEUE Strategie an — nichts wird automatisch live geschaltet</span>`;
    swOut.querySelector('#swAdopt')!.addEventListener('click', () => {
      const name = `Sweep ${xl} ${res.best.x}${yParam ? ` × ${yl} ${res.best.y}` : ''}`.slice(0, 60);
      say('Lege Entwurf an …');
      callSaveStrategyDraft({ name, spec: res.bestSpec })
        .then(() => say(`✓ Entwurf „${name}" angelegt — in der Strategie-Liste`))
        .catch((e) => say(`✗ ${(e as Error).message}`));
    });
  };

  root.querySelector('#stAssign')!.addEventListener('click', () => {
    if (!st.id) return;
    const symbols = root
      .querySelector<HTMLInputElement>('#stSymbols')!
      .value.split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const mode = (root.querySelector<HTMLSelectElement>('#stMode')!.value === 'shadow' ? 'shadow' : 'paper') as 'paper' | 'shadow';
    say('Ordne zu …');
    callAssignStrategy(st.id, symbols, mode)
      .then(() => {
        st.symbols = symbols;
        st.mode = mode;
        // Server legt beim Einschalten ein frisches Konto an — lokal spiegeln,
        // damit die A/B-Karte sofort erscheint (Werte identisch zum Server-Init).
        if (mode === 'shadow' && !st.shadow) {
          const now = new Date().toISOString();
          st.shadow = { balance: 25_000, positions: {}, equity: 25_000, startedAt: now, updatedAt: now };
        }
        say(symbols.length > 0 ? `✓ Zugeordnet (${mode}): ${symbols.join(', ')}` : '✓ Zuordnung entfernt');
        rerender();
      })
      .catch((e) => say(`✗ ${(e as Error).message}`));
  });

  // A/B (M11): Duell + Hätte-Feed füllen, Befördern = transaktionaler Rollentausch
  if (st.mode === 'shadow' && st.shadow && st.id) void fillAbDuel(root, st);
  root.querySelector('#stPromote')?.addEventListener('click', () => {
    if (!st.id) return;
    say('Befördere …');
    callPromoteStrategy(st.id)
      .then((demoted) => {
        st.mode = 'paper';
        st.msg = `✓ Befördert — „${st.name}" handelt jetzt dein Paper-Wallet${
          demoted.length > 0 ? ` · ${demoted.length} bisherige Paper-Strategie(n) beobachten als Shadow weiter` : ''
        }`;
        rerender();
      })
      .catch((e) => say(`✗ ${(e as Error).message}`));
  });
}

function renderList(root: HTMLElement, uid: string): () => void {
  root.innerHTML = `
    <main class="st-wrap">
      <header class="st-head">
        <a class="btn btn-n" href="#">← Dashboard</a>
        <h2>Strategie-Studio</h2>
      </header>
      <section class="st-new">
        <h3>Neue Strategie aus Preset <span class="hint">— jede Regel-Art einmal; kopieren, anpassen, publizieren</span></h3>
        <div id="stPresetGrid" class="st-presets"><p class="hint">Lade Presets …</p></div>
      </section>
      <div class="wl-sec">Deine Strategien</div>
      <div id="stList" class="st-list"><p class="hint">Lade Strategien …</p></div>
    </main>`;

  void loadStrategyPresets().then((presets) => {
    const grid = root.querySelector<HTMLDivElement>('#stPresetGrid');
    if (!grid) return;
    grid.innerHTML = presets
      .map(
        (p) => `<article class="card st-preset">
          <b>${esc(p.name)}</b>
          <p>${esc(p.description)}</p>
          <button type="button" class="btn btn-g" data-preset="${p.id}">Anlegen</button>
        </article>`,
      )
      .join('');
    grid.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const preset = presets.find((p) => p.id === btn.dataset.preset);
        if (!preset) return;
        btn.disabled = true;
        btn.textContent = 'Lege an …';
        callSaveStrategyDraft({ name: `${preset.name} (Kopie)`, spec: structuredClone(preset.spec) })
          .then((id) => {
            location.hash = `#/strategy/${id}`;
          })
          .catch((e) => {
            btn.disabled = false;
            btn.textContent = 'Anlegen';
            root
              .querySelector('#stList')!
              .insertAdjacentHTML('afterbegin', `<p class="error">${esc((e as Error).message)}</p>`);
          });
      }),
    );
  });

  const unsub = watchStrategies(uid, (rows: StrategyRow[]) => {
    const list = root.querySelector('#stList');
    if (!list) return;
    list.innerHTML =
      rows.length === 0
        ? '<p class="hint">Noch keine Strategien — leg die erste aus einem Preset an.</p>'
        : rows
            .map(
              (r) => `<a class="card st-item" href="#/strategy/${r.id}">
                <b>${esc(r.doc.name)}</b>
                <span class="chip ${r.doc.status === 'published' ? 'c-gn' : ''}">${r.doc.status}${r.doc.compiled ? ` · v${r.doc.compiled.version}` : ''}</span>
                <span class="mono st-syms">${r.doc.symbols?.join(' · ') ?? ''}</span>
                <button type="button" class="btn btn-n st-del" data-del="${r.id}"
                  title="Strategie endgültig löschen — auch publizierte">Löschen</button>
              </a>`,
            )
            .join('');
    // Löschen direkt aus der Liste (Owner-Frage 26.07.): 2-Klick-Armierung;
    // der Knopf sitzt IM Karten-Link — Klicks dürfen nicht navigieren.
    list.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((btn) =>
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!btn.classList.contains('armed')) {
          btn.classList.add('armed');
          btn.textContent = 'Wirklich löschen?';
          window.setTimeout(() => {
            btn.classList.remove('armed');
            btn.textContent = 'Löschen';
          }, 4000);
          return;
        }
        btn.disabled = true;
        btn.textContent = 'Lösche …';
        callDeleteStrategy(btn.dataset.del!).catch((e) => {
          btn.disabled = false;
          btn.textContent = 'Löschen';
          list.insertAdjacentHTML('afterbegin', `<p class="error">${esc((e as Error).message)}</p>`);
        }); // watchStrategies räumt die Karte nach dem Löschen selbst weg
      }),
    );
  });
  return unsub;
}

export function mountStudio(root: HTMLElement, uid: string): void {
  initInfoTips(); // ⓘ-Erklär-Popover (idempotent)
  unmountStudio();
  const route = location.hash; // '#/strategy' oder '#/strategy/{id}'
  const id = route.startsWith('#/strategy/') ? route.slice('#/strategy/'.length) : null;

  if (!id) {
    const unsub = renderList(root, uid);
    cleanup = unsub;
    return;
  }

  // Editor: Strategie einmal über den Watcher holen (liefert auch Updates
  // nach Publish durch die Callables), aber nur beim ERSTEN Snapshot rendern —
  // sonst würde jede Speicherung den Editor-Zustand überschreiben.
  let rendered = false;
  const unsub = watchStrategies(uid, (rows) => {
    if (rendered) return;
    const row = rows.find((r) => r.id === id);
    if (!row) {
      root.innerHTML = '<main class="st-wrap"><p class="error">Strategie nicht gefunden.</p><a class="btn btn-n" href="#/strategy">← Studio</a></main>';
      return;
    }
    rendered = true;
    const st: EditorState = {
      uid,
      id,
      name: row.doc.name,
      spec: structuredClone(row.doc.draft),
      status: row.doc.status,
      version: row.doc.compiled?.version ?? null,
      symbols: row.doc.symbols ?? [],
      mode: row.doc.mode ?? 'paper',
      shadow: row.doc.shadow ?? null,
      previewSymbol: row.doc.symbols?.[0] ?? 'QQQ',
      msg: '',
      barsCache: new Map(),
    };
    void renderEditor(root, st);
  });
  cleanup = unsub;
}

export function unmountStudio(): void {
  cleanup?.();
  cleanup = null;
  runSub?.();
  runSub = null;
}
