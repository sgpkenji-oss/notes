// ページ一覧：ページの縮小表示、並べ替え（つかんで動かす／‹ ›ボタン）、追加、削除。
import * as db from './db.js';
import { h, clear } from './dom.js';
import { PAGE_WIDTH, PAGE_HEIGHT, PAPER_TYPES } from './model.js';
import { drawPaper } from './paper.js';
import { drawStroke, strokeGeometry } from './geometry.js';
import { confirmDialog } from './dialogs.js';
import { toast } from './notices.js';

const THUMB_W = 150; // 縮小表示の幅（CSSピクセル）

export class PageList {
  // actions：getCurrentIndex() / select(index) / add(paper) / move(from, to) / remove(index) / close()
  constructor(notebook, actions) {
    this.nb = notebook;
    this.a = actions;
    this.el = document.getElementById('page-list');
    this.token = 0;
    this.dragging = null;
    this.grid = h('div', { class: 'pl-grid' });
    this.title = h('h2', { class: 'screen-title' });
    this.menu = h('div', { class: 'pl-add-menu', hidden: true });
    for (const p of PAPER_TYPES) {
      this.menu.append(h('button', {
        type: 'button', class: `paper paper-${p.key}`,
        onclick: async () => { this.menu.hidden = true; await actions.add(p.key); this.render(); },
      }, h('i'), h('span', {}, p.label)));
    }
    const addButton = h('button', { type: 'button', class: 'primary-button', onclick: () => { this.menu.hidden = !this.menu.hidden; } }, '＋ ページを追加');
    this.el.append(
      h('header', { class: 'screen-head' },
        h('button', { type: 'button', class: 'head-button', onclick: () => actions.close() }, '← ノートに戻る'),
        this.title,
        h('div', { class: 'pl-add' }, addButton, this.menu)),
      h('div', { class: 'pl-body' },
        h('p', { class: 'lib-hint' }, 'ページをタップすると開きます。「≡」をつかんで動かすか、「‹ ›」で並べ替えます。'),
        this.grid));
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open() {
    this.el.hidden = false;
    this.menu.hidden = true;
    this.render();
  }

  close() {
    this.token++;
    this.el.hidden = true;
  }

  render() {
    const token = ++this.token;
    const pages = this.nb.pages;
    const current = this.a.getCurrentIndex();
    this.title.textContent = `ページ一覧（${pages.length}枚）`;
    clear(this.grid);
    const canvases = [];
    pages.forEach((page, i) => {
      const canvas = h('canvas', { class: 'pl-thumb' });
      const hh = Math.round((THUMB_W * PAGE_HEIGHT) / PAGE_WIDTH);
      canvas.style.width = `${THUMB_W}px`;
      canvas.style.height = `${hh}px`;
      canvases.push([page, canvas]);
      let item = null;
      item = h('div', { class: `pl-item${i === current ? ' current' : ''}`, 'data-id': page.id },
        h('button', { type: 'button', class: 'pl-open', 'aria-label': `${i + 1}ページ目を開く`, onclick: () => this.a.select(this.indexOf(item)) }, canvas),
        h('div', { class: 'pl-foot' },
          h('span', { class: 'pl-handle', 'aria-label': 'つかんで並べ替え', title: 'つかんで並べ替え' }, '≡'),
          h('span', { class: 'pl-num' }, String(i + 1)),
          h('button', { type: 'button', class: 'pl-btn', 'aria-label': '前へ', disabled: i === 0, onclick: () => this.move(this.indexOf(item), this.indexOf(item) - 1) }, '‹'),
          h('button', { type: 'button', class: 'pl-btn', 'aria-label': '後ろへ', disabled: i === pages.length - 1, onclick: () => this.move(this.indexOf(item), this.indexOf(item) + 1) }, '›'),
          h('button', { type: 'button', class: 'pl-btn danger-text', 'aria-label': `${i + 1}ページ目を削除`, disabled: pages.length <= 1, onclick: () => this.remove(this.indexOf(item)) }, '削除')));
      this.bindDrag(item);
      this.grid.append(item);
    });
    this.drawThumbs(canvases, token);
  }

  // 縮小表示を、画面を固めないように1枚ずつ描く
  async drawThumbs(list, token) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const [page, canvas] of list) {
      if (token !== this.token) return;
      let strokes = this.nb.strokes(page.id);
      if (!strokes) {
        strokes = await db.getAllByIndex('strokes', 'pageId', page.id);
        strokes.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
        if (token !== this.token) return;
      }
      const w = Math.round(THUMB_W * dpr);
      const hgt = Math.round((w * PAGE_HEIGHT) / PAGE_WIDTH);
      canvas.width = w;
      canvas.height = hgt;
      const ctx = canvas.getContext('2d');
      const s = w / PAGE_WIDTH;
      ctx.setTransform(s, 0, 0, s, 0, 0);
      drawPaper(ctx, page.paper, { minX: 0, minY: 0, maxX: PAGE_WIDTH, maxY: PAGE_HEIGHT }, s);
      for (const stroke of strokes) drawStroke(ctx, stroke, strokeGeometry(stroke));
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  indexOf(item) {
    return [...this.grid.children].indexOf(item);
  }

  // 番号・「‹ ›」の有効/無効・いま見ているページの枠を、並びに合わせて更新する
  refreshItems() {
    const kids = [...this.grid.children];
    const current = this.a.getCurrentIndex();
    kids.forEach((el, i) => {
      el.classList.toggle('current', i === current);
      el.querySelector('.pl-num').textContent = String(i + 1);
      const [prev, next] = el.querySelectorAll('.pl-btn:not(.danger-text)');
      prev.disabled = i === 0;
      next.disabled = i === kids.length - 1;
    });
  }

  // カードの位置をアニメーションで入れ替え、動かしたページを一瞬ハイライトする
  async move(from, to, { dragged = null } = {}) {
    const items = [...this.grid.children];
    const moving = dragged || items[from];
    const first = new Map(items.map((el) => [el, el.getBoundingClientRect()]));
    await this.a.move(from, to);
    if (!dragged) {
      const target = this.grid.children[to];
      if (to > from) target.after(moving);
      else target.before(moving);
    }
    this.refreshItems();
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const el of this.grid.children) {
      const a = first.get(el), b = el.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if (reduce || (!dx && !dy)) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
      el.getBoundingClientRect(); // 動き始めの位置を確定させる
      el.style.transition = 'transform 0.28s ease';
      el.style.transform = '';
      el.addEventListener('transitionend', () => { el.style.transition = ''; }, { once: true });
    }
    moving.classList.remove('flash');
    void moving.offsetWidth;
    moving.classList.add('flash');
    moving.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    toast(`${from + 1}ページ目を ${to + 1}ページ目に移しました`, 1800);
  }

  async remove(index) {
    const ok = await confirmDialog({
      title: `${index + 1}ページ目を削除しますか？`,
      message: 'このページに書いた内容はすべて消え、元に戻せません。',
      okLabel: '削除', danger: true,
    });
    if (!ok) return;
    await this.a.remove(index);
    this.render();
  }

  // 「≡」をつかんで動かす（Pointer Events。指でもペンでもマウスでも動く）。
  // 動かしている間に、つかんだカードをDOM上で入れ替えるため、ポインタの捕捉には頼らず window で受け取る。
  bindDrag(item) {
    const handle = item.querySelector('.pl-handle');
    handle.addEventListener('pointerdown', (e) => {
      if (this.dragging) return;
      e.preventDefault();
      const drag = { id: e.pointerId, from: [...this.grid.children].indexOf(item) };
      this.dragging = drag;
      item.classList.add('dragging');

      const onMove = (ev) => {
        if (ev.pointerId !== drag.id) return;
        ev.preventDefault();
        for (const other of this.grid.children) {
          if (other === item) continue;
          const r = other.getBoundingClientRect();
          if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) continue;
          const kids = [...this.grid.children];
          if (kids.indexOf(item) < kids.indexOf(other)) other.after(item);
          else other.before(item);
          break;
        }
      };
      const onEnd = async (ev, cancelled) => {
        if (ev.pointerId !== drag.id) return;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        this.dragging = null;
        item.classList.remove('dragging');
        const to = [...this.grid.children].indexOf(item);
        if (cancelled || to === drag.from) return this.render();
        await this.move(drag.from, to, { dragged: item });
      };
      const onUp = (ev) => onEnd(ev, false);
      const onCancel = (ev) => onEnd(ev, true);
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    });
  }
}
