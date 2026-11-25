// 画面上段のタブの帯（ライブラリボタン＋開いているノートのタブ）。表示だけを担当する。
import { h, clear } from './dom.js';

export class Tabs {
  constructor({ onSelect, onClose, onLibrary }) {
    this.el = document.getElementById('tabs');
    this.onSelect = onSelect;
    this.onClose = onClose;
    document.getElementById('library-button').addEventListener('click', onLibrary);
  }

  // tabs = [{ id, name }]
  render(tabs, activeId) {
    clear(this.el);
    for (const t of tabs) {
      const active = t.id === activeId;
      const tab = h('div', { class: `tab${active ? ' active' : ''}`, role: 'tab', 'aria-selected': String(active), 'data-id': t.id },
        h('button', { type: 'button', class: 'tab-name', onclick: () => this.onSelect(t.id) }, t.name),
        tabs.length > 1 && h('button', {
          type: 'button', class: 'tab-close', 'aria-label': `${t.name}を閉じる`,
          onclick: (e) => { e.stopPropagation(); this.onClose(t.id); },
        }, '×'));
      this.el.append(tab);
    }
    const active = this.el.querySelector('.tab.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}
