/**
 * Command-Palette (MILESTONES M9) — Ctrl+K, Keyboard-first.
 * Symbol-Resolve über den Katalog (Klarnamen UND yfinance-Konvention wie
 * `^NDX` — CLAUDE.md §6) plus App-Befehle (Presets, Panels, Theme, Engine).
 * Der Hotkey ist über `settings.hotkeys.palette` überschreibbar.
 */

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export interface PaletteEntry {
  label: string;
  hint: string;
  run: () => void;
}

interface PaletteOptions {
  /** Katalog-Symbole (symbol + Klarname) für den Resolve. */
  symbols: () => Array<{ symbol: string; name: string }>;
  /** App-Befehle (werden bei jedem Öffnen frisch abgefragt). */
  commands: () => PaletteCommand[];
  /** Symbol gewählt → Publisher (Link-Gruppe entscheidet der Aufrufer). */
  onSymbol: (symbol: string) => void;
  /** Hotkey, Default 'ctrl+k' (Format: 'ctrl+k', 'meta+p', …). */
  hotkey?: string;
}

export function matchesHotkey(e: KeyboardEvent, hotkey: string): boolean {
  const parts = hotkey.toLowerCase().split('+');
  const key = parts[parts.length - 1] ?? 'k';
  return (
    e.key.toLowerCase() === key &&
    parts.includes('ctrl') === (e.ctrlKey || e.metaKey) &&
    parts.includes('shift') === e.shiftKey &&
    parts.includes('alt') === e.altKey
  );
}

/** Palette initialisieren; Rückgabe räumt DOM + Listener wieder ab. */
export function initPalette(opts: PaletteOptions): () => void {
  const wrap = document.createElement('div');
  wrap.id = 'cmdk';
  wrap.className = 'cmdk';
  wrap.innerHTML = `
    <div class="cmdk-bg"></div>
    <div class="cmdk-box" role="dialog" aria-modal="true" aria-label="Command-Palette">
      <input id="cmdkInput" class="cmdk-inp" placeholder="Symbol oder Befehl … (Esc schließt)"
        autocomplete="off" spellcheck="false">
      <div id="cmdkList" class="cmdk-list" role="listbox"></div>
    </div>`;
  document.body.appendChild(wrap);

  const input = wrap.querySelector<HTMLInputElement>('#cmdkInput')!;
  const list = wrap.querySelector<HTMLElement>('#cmdkList')!;
  let entries: PaletteEntry[] = [];
  let cursor = 0;

  const close = (): void => {
    wrap.classList.remove('show');
    input.value = '';
  };
  const open = (): void => {
    wrap.classList.add('show');
    render('');
    input.focus();
  };

  function collect(q: string): PaletteEntry[] {
    const query = q.trim().toLowerCase();
    const cmds: PaletteEntry[] = opts.commands().map((c) => ({
      label: c.label,
      hint: c.hint ?? 'Befehl',
      run: c.run,
    }));
    const syms: PaletteEntry[] = opts.symbols().map((s) => ({
      label: `${s.symbol} — ${s.name}`,
      hint: 'Symbol',
      run: () => opts.onSymbol(s.symbol),
    }));
    if (!query) return [...cmds.slice(0, 6), ...syms.slice(0, 6)];
    const scored = [...cmds, ...syms]
      .map((e) => {
        const l = e.label.toLowerCase();
        const idx = l.indexOf(query);
        // Präfix-Treffer (Symbolanfang) vor Substring-Treffern
        const score = idx === 0 ? 0 : idx > 0 ? 1 : Number.POSITIVE_INFINITY;
        return { e, score, idx };
      })
      .filter((x) => Number.isFinite(x.score))
      .sort((a, b) => a.score - b.score || a.idx - b.idx);
    return scored.slice(0, 12).map((x) => x.e);
  }

  function render(q: string): void {
    entries = collect(q);
    cursor = 0;
    list.innerHTML = '';
    if (entries.length === 0) {
      list.innerHTML = '<div class="cmdk-empty">Kein Treffer</div>';
      return;
    }
    entries.forEach((e, i) => {
      const row = document.createElement('div');
      row.className = 'cmdk-row' + (i === 0 ? ' on' : '');
      row.setAttribute('role', 'option');
      const lbl = document.createElement('span');
      lbl.textContent = e.label;
      const hint = document.createElement('span');
      hint.className = 'cmdk-hint';
      hint.textContent = e.hint;
      row.append(lbl, hint);
      row.addEventListener('click', () => {
        e.run();
        close();
      });
      list.appendChild(row);
    });
  }

  function moveCursor(delta: number): void {
    const rows = list.querySelectorAll('.cmdk-row');
    if (rows.length === 0) return;
    cursor = (cursor + delta + rows.length) % rows.length;
    rows.forEach((r, i) => r.classList.toggle('on', i === cursor));
    rows[cursor]?.scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('input', () => render(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveCursor(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveCursor(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      entries[cursor]?.run();
      close();
    } else if (e.key === 'Escape') close();
  });
  wrap.querySelector('.cmdk-bg')!.addEventListener('click', close);

  const hotkey = opts.hotkey ?? 'ctrl+k';
  const onKey = (e: KeyboardEvent): void => {
    if (matchesHotkey(e, hotkey)) {
      e.preventDefault();
      if (wrap.classList.contains('show')) close();
      else open();
    }
  };
  document.addEventListener('keydown', onKey);

  return () => {
    document.removeEventListener('keydown', onKey);
    wrap.remove();
  };
}
