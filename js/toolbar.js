// 道具の帯（ペン・マーカー・消しゴム・なげなわ・付箋・コネクタ・枠、色、太さ、元に戻す・やり直す、ページの追加）。
import { TOOLS, COLORS, SIZES } from './tools.js';
import { PAPER_TYPES } from './model.js';
import { STICKY_COLORS } from './scene.js';

const ICONS = {
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20l1.2-4.6L16.6 4a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8 4 20z"/><path d="M14.5 6.1l3.4 3.4"/></svg>',
  marker: '<svg viewBox="0 0 24 24"><path d="M9 15l-2.5 5h5L13 17"/><path d="M9 15l8.5-10.5a2 2 0 0 1 2.9-.2l.3.3a2 2 0 0 1-.2 2.9L13 17z"/><path d="M3 21h8"/></svg>',
  eraser: '<svg viewBox="0 0 24 24"><path d="M8.5 20L3.7 15.2a1.5 1.5 0 0 1 0-2.1L13 3.8a1.5 1.5 0 0 1 2.1 0l5.1 5.1a1.5 1.5 0 0 1 0 2.1L11 20z"/><path d="M8 9.5l6.5 6.5"/><path d="M11 20h9"/></svg>',
  lasso: '<svg viewBox="0 0 24 24"><path stroke-dasharray="3 2.6" d="M12 4c4.6 0 8 2.2 8 5s-3.4 5-8 5-8-2.2-8-5 3.4-5 8-5z"/><path d="M8.5 13.6c-.9 1.6-.6 3.4 1 4.3 1.2.7 2.5.4 3-.6"/></svg>',
  sticky: '<svg viewBox="0 0 24 24"><path d="M5 4h14v10l-6 6H5z"/><path d="M5 8h14"/><path d="M13 20v-6h6"/></svg>',
  connector: '<svg viewBox="0 0 24 24"><rect x="2.5" y="3.5" width="7" height="6" rx="1.2"/><rect x="14.5" y="14.5" width="7" height="6" rx="1.2"/><path d="M9.5 8.5l6 6"/><path d="M15.7 11.4l.3 3.6-3.6-.3"/></svg>',
  frame: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.5" stroke-dasharray="3.2 2.4"/><path d="M3.5 9h17"/><rect x="7" y="12" width="4.5" height="4.5" rx=".8"/><rect x="13" y="12" width="4.5" height="4.5" rx=".8"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
  redo: '<svg viewBox="0 0 24 24"><path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>',
};

function button(className, html, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.innerHTML = html;
  b.setAttribute('aria-label', label);
  return b;
}

export class Toolbar {
  constructor({ tools, history, onUndo, onRedo, onAddPage }) {
    this.tools = tools;
    this.history = history;

    const toolGroup = document.getElementById('tool-group');
    this.toolButtons = TOOLS.map((t) => {
      const b = button('tool', `${ICONS[t.key]}<span>${t.label}</span>`, t.label);
      b.dataset.key = t.key;
      b.addEventListener('click', () => tools.setTool(t.key));
      toolGroup.append(b);
      return b;
    });

    const colorGroup = document.getElementById('color-group');
    this.colorButtons = COLORS.map((c) => {
      const b = button('swatch', `<i style="background:${c.pen}"></i>`, c.label);
      b.dataset.key = c.key;
      b.addEventListener('click', () => tools.setColor(c.key));
      colorGroup.append(b);
      return b;
    });
    // 付箋の道具のときは、付箋の色を出す
    this.stickyButtons = STICKY_COLORS.map((c) => {
      const b = button('swatch sticky-swatch', `<i style="background:${c.fill};box-shadow:inset 0 0 0 1.5px ${c.edge}"></i>`, `${c.label}の付箋`);
      b.dataset.key = c.key;
      b.hidden = true;
      b.addEventListener('click', () => tools.setColor(c.key));
      colorGroup.append(b);
      return b;
    });

    const sizeGroup = document.getElementById('size-group');
    this.sizeButtons = SIZES.map((z, i) => {
      const b = button('size', `<i style="width:${4 + i * 4}px;height:${4 + i * 4}px"></i>`, z.label);
      b.dataset.key = z.key;
      b.addEventListener('click', () => tools.setSize(z.key));
      sizeGroup.append(b);
      return b;
    });

    const historyGroup = document.getElementById('history-group');
    this.undoButton = button('icon', ICONS.undo, '元に戻す');
    this.redoButton = button('icon', ICONS.redo, 'やり直す');
    this.undoButton.addEventListener('click', onUndo);
    this.redoButton.addEventListener('click', onRedo);
    historyGroup.append(this.undoButton, this.redoButton);

    // ページの追加（紙の種類を選ぶ）
    const addButton = document.getElementById('add-page-button');
    const menu = document.getElementById('add-page-menu');
    for (const p of PAPER_TYPES) {
      const b = button(`paper paper-${p.key}`, `<i></i><span>${p.label}</span>`, `${p.label}のページを追加`);
      b.addEventListener('click', () => {
        menu.hidden = true;
        onAddPage(p.key);
      });
      menu.append(b);
    }
    const boardButton = button('paper paper-board', '<i></i><span>ボード</span>', 'ボードページを追加');
    boardButton.addEventListener('click', () => {
      menu.hidden = true;
      onAddPage('board');
    });
    menu.append(boardButton);
    addButton.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!menu.hidden) {
        menu.hidden = true;
        return;
      }
      const r = addButton.getBoundingClientRect();
      menu.style.top = `${r.bottom + 6}px`;
      menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
      menu.hidden = false;
    });
    document.addEventListener('click', (e) => {
      if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true;
    });
    document.addEventListener('touchstart', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== addButton && !addButton.contains(e.target)) menu.hidden = true;
    }, { passive: true });

    this.update();
  }

  update() {
    const tools = this.tools;
    for (const b of this.toolButtons) b.classList.toggle('active', b.dataset.key === tools.tool);
    const o = tools.options;
    const sticky = tools.tool === 'sticky';
    for (const b of this.colorButtons) {
      b.hidden = sticky;
      b.classList.toggle('active', !!o && b.dataset.key === o.color);
      b.disabled = !o;
      const c = COLORS.find((x) => x.key === b.dataset.key);
      b.firstChild.style.background = tools.tool === 'marker' ? c.marker : c.pen;
    }
    for (const b of this.stickyButtons) {
      b.hidden = !sticky;
      b.classList.toggle('active', sticky && b.dataset.key === o.color);
    }
    for (const b of this.sizeButtons) {
      b.classList.toggle('active', tools.hasSize && b.dataset.key === o.size);
      b.disabled = !tools.hasSize;
    }
    this.undoButton.disabled = !this.history.canUndo;
    this.redoButton.disabled = !this.history.canRedo;
  }
}
