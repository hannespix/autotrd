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
  callPublishStrategy,
  callRunBacktest,
  callSaveStrategyDraft,
  loadBarsOnce,
  loadEventsOnce,
  loadStrategyPresets,
  watchLatestRun,
  watchStrategies,
  type BacktestRunDoc,
  type StrategyRow,
} from './data.js';
import { previewSignals, type PreviewBar, type PreviewDayInfo } from './preview.js';

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
  barsCache: Map<string, { bars: PreviewBar[]; days: Map<string, PreviewDayInfo> }>;
}

const LEAF_TYPES = [
  'compare',
  'crossover',
  'priceLevel',
  'changePct',
  'timeWindow',
  'sentiment',
  'newsEvent',
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
    case 'sentiment':
      return { type, op: 'gte', value: 0.2 };
    case 'newsEvent':
      return { type, tags: ['earnings'] };
    case 'forecast':
      return { type, direction: 'up', minAbsPct: 0.5 };
    case 'position':
      return { type, state: 'none' };
  }
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
    case 'sentiment':
      return `Sentiment ${n.op === 'gte' ? '≥' : '≤'} ${n.value}`;
    case 'newsEvent':
      return `News: ${n.tags.join(', ')}`;
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
    case 'sentiment':
      return `${sel('op', n.op, ['gte', 'lte'])} ${num('value', n.value, 0.1)}`;
    case 'newsEvent':
      return `<input class="inp" data-f="tags" value="${esc(n.tags.join(', '))}" placeholder="tag1, tag2" />`;
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
      <label>Verknüpfung
        <select class="sel" data-root="type">
          ${['weighted', 'all', 'any'].map((t) => `<option ${t === root.type ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </label>
      ${
        root.type === 'weighted'
          ? `<label>Threshold
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
              <span class="chip">${k.node.type}</span>
              ${k.weight !== null ? `<span class="chip st-w">Gewicht <input class="inp st-num" data-w="${k.i}" type="number" step="0.5" min="0.5" value="${k.weight}" /></span>` : ''}
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
          </div>
          <div class="row st-assign">
            <input id="stSymbols" class="inp" value="${esc(st.symbols.join(', '))}" placeholder="Symbole, z. B. QQQ, BTC-USD" aria-label="Zuordnung" />
            <select id="stMode" class="sel" aria-label="Modus" title="paper = echtes Paper-Wallet · shadow = nur beobachten (virtuelles Konto)">
              <option value="paper" ${st.mode === 'paper' ? 'selected' : ''}>paper</option>
              <option value="shadow" ${st.mode === 'shadow' ? 'selected' : ''}>shadow</option>
            </select>
            <button type="button" id="stAssign" class="btn btn-n" ${st.id ? '' : 'disabled'}>Zuordnen</button>
          </div>
          ${
            st.mode === 'shadow' && st.shadow
              ? `<section class="card st-shadow">
                  <h3>Shadow-Konto <span class="chip">virtuell — berührt nie dein Wallet</span></h3>
                  <div class="st-metrics mono">
                    <span>Equity ${st.shadow.equity.toFixed(2)} $</span>
                    <span>Cash ${st.shadow.balance.toFixed(2)} $</span>
                    <span class="${st.shadow.equity >= 25000 ? 'c-gn' : 'c-rd'}">${(((st.shadow.equity - 25000) / 25000) * 100).toFixed(2)} % seit Start</span>
                    <span>${Object.keys(st.shadow.positions ?? {}).length} offene Position(en)</span>
                  </div>
                  <p class="hint">Seit ${st.shadow.startedAt.slice(0, 10)} · Hätte-Signale entstehen nur bei Richtungs-Wechseln im Scan.</p>
                </section>`
              : ''
          }
          <p id="stMsg" class="hint" role="status">${esc(st.msg)}</p>
        </div>
        <div class="st-col">
          <section class="card st-preview">
            <h3>Live-Vorschau <span class="chip">Vorschau, kein Backtest</span></h3>
            <div class="row">
              <input id="stPrevSym" class="inp st-sym" value="${esc(st.previewSymbol)}" aria-label="Vorschau-Symbol" />
              <button type="button" id="stPrevLoad" class="btn btn-n">Laden</button>
            </div>
            <div id="stPrevChart" class="st-chart" aria-live="polite"></div>
            <p class="hint">Auswertung alle 5 min · Annahmen: 10:00 ET je Tages-Bar, Prognose in der
            Vorschau unbekannt · Marker ▲ Kauf / ▼ Verkauf, Bänder = Haltephasen</p>
          </section>
          <section class="card st-report">
            <h3>Backtest <span class="chip">1 Jahr Tages-Bars · inkl. Kosten</span></h3>
            <div class="row">
              <button type="button" id="stBacktest" class="btn btn-n" ${st.id ? '' : 'disabled'}>Backtest starten</button>
              <span class="hint">max. 10/Tag</span>
            </div>
            <div id="stRun" aria-live="polite"><p class="hint">Noch kein Report.</p></div>
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
        const [bars, days] = await Promise.all([loadBarsOnce(sym), loadEventsOnce(sym)]);
        cached = { bars: bars.map((b) => ({ date: b.date, close: b.close })), days };
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
    const res = previewSignals(st.spec, cached.bars, cached.days);
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
        <span>${pct(run.buyHoldPct)} Buy&amp;Hold</span>
        <span>${run.numTrades} Trades · ${run.winRatePct.toFixed(0)} % Winrate</span>
        <span>MaxDD ${run.maxDrawdownPct.toFixed(1)} % · Sharpe ${run.sharpe.toFixed(2)}</span>
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
        say(symbols.length > 0 ? `✓ Zugeordnet (${mode}): ${symbols.join(', ')}` : '✓ Zuordnung entfernt');
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
              </a>`,
            )
            .join('');
  });
  return unsub;
}

export function mountStudio(root: HTMLElement, uid: string): void {
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
