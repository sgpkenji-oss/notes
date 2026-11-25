// 道具の帯（ペン・マーカー・消しゴム、色、太さ、元に戻す・やり直す、ページの追加）。
import { TOOLS, COLORS, SIZES } from './tools.js';
import { PAPER_TYPES } from './model.js';

const ICONS = {
  pen: '<svg viewBox="0 0 24 24"><path d="M4 20l1.2-4.6L16.6 4a2 2 0 0 1 2.8 0l.6.6a2 2 0 0 1 0 2.8L8.6 18.8 4 20z"/><path d="M14.5 6.1l3.4 3.4"/></svg>',
  marker: '<svg viewBox="0 0 24 24"><path d="M9 15l-2.5 5h5L13 17"/><path d="M9 15l8.5-10.5a2 2 0 0 1 2.9-.2l.3.3a2 2 0 0 1-.2 2.9L13 17z"/><path d="M3 21h8"/></svg>',
  eraser: '<svg viewBox="0 0 24 24"><path d="M8.5 20L3.7 15.2a1.5 1.5 0 0 1 0-2.1L13 3.8a1.5 1.5 0 0 1 2.1 0l5.1 5.1a1.5 1.5 0 0 1 0 2.1L11 20z"/><path d="M8 9.5l6.5 6.5"/><path d="M11 20h9"/></svg>',
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
    for (const b of this.colorButtons) {
      b.classList.toggle('active', !!o && b.dataset.key === o.color);
      b.disabled = !o;
      const c = COLORS.find((x) => x.key === b.dataset.key);
      b.firstChild.style.background = tools.tool === 'marker' ? c.marker : c.pen;
    }
    for (const b of this.sizeButtons) {
      b.classList.toggle('active', !!o && b.dataset.key === o.size);
      b.disabled = !o;
    }
    this.undoButton.disabled = !this.history.canUndo;
    this.redoButton.disabled = !this.history.canRedo;
  }
}
