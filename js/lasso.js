// なげなわ：囲んだ線を選び、ドラッグで移動する。コピー・削除・色変更・貼り付けは画面上部の小さな帯から。
// 移動・色変更・貼り付け・削除は、すべて「元に戻す」に対応する（history.js の add / erase / replace）。
//
// 動かしている間は、選んだ線を下の絵から外して（renderer.hidden）、上の重ね描きの画面に描く。
// 指（ペン）を離したときに、新しい位置の線で入れ替えて保存する。
import { newId, now, PAGE_WIDTH, PAGE_HEIGHT } from './model.js';
import { COLORS } from './tools.js';
import { drawStroke, strokeGeometry } from './geometry.js';

const SELECT_RATIO = 0.5;  // 点の半分以上が輪の中にある線を選ぶ
const BOX_PAD = 8;         // 選択の枠の余白（画面ピクセル）
const MIN_LOOP = 12;       // これより小さい輪は「ただのタップ」とみなす（画面ピクセル）
const PASTE_NUDGE = 40;    // 貼り付けるとき、同じ場所なら少しずらす（ページ座標）

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function cloneStroke(s, patch = {}) {
  return { ...s, points: s.points.slice(), ...patch };
}

function translated(s, dx, dy) {
  const pts = s.points.slice();
  for (let i = 0; i < pts.length; i += 3) {
    pts[i] = Math.round((pts[i] + dx) * 100) / 100;
    pts[i + 1] = Math.round((pts[i + 1] + dy) * 100) / 100;
  }
  return { ...s, points: pts, updatedAt: now() };
}

export class Lasso {
  constructor({ viewport, notebook, renderer, ink, history }) {
    this.vp = viewport;
    this.nb = notebook;
    this.renderer = renderer;
    this.ink = ink;
    this.history = history;
    this.sel = null;        // { pageId, pageIndex, strokes: [...] }
    this.mode = null;       // null | 'draw' | 'drag'
    this.path = [];
    this.drag = null;
    this.clipboard = [];
    this.onChange = () => {};
  }

  get active() {
    return this.mode !== null;
  }
  get hasSelection() {
    return !!this.sel;
  }
  get hasClipboard() {
    return this.clipboard.length > 0;
  }

  // ---- 座標 ----

  pagePoint(sx, sy, pageIndex) {
    const doc = this.vp.toDoc(sx, sy);
    return { x: doc.x, y: doc.y - this.vp.pageTop(pageIndex) };
  }

  // ページ座標の外枠 → 画面座標の外枠
  toScreenRect(b, pageIndex, pad = 0, dx = 0, dy = 0) {
    const vp = this.vp, s = vp.scale;
    const x0 = vp.ox + (b.minX + dx) * s;
    const y0 = vp.oy + (vp.pageTop(pageIndex) + b.minY + dy) * s;
    return { x: x0 - pad, y: y0 - pad, w: (b.maxX - b.minX) * s + pad * 2, h: (b.maxY - b.minY) * s + pad * 2 };
  }

  selectionBounds() {
    let b = null;
    for (const s of this.sel.strokes) {
      const g = strokeGeometry(s).bounds;
      if (!b) b = { minX: g.minX, minY: g.minY, maxX: g.maxX, maxY: g.maxY };
      else {
        b.minX = Math.min(b.minX, g.minX);
        b.minY = Math.min(b.minY, g.minY);
        b.maxX = Math.max(b.maxX, g.maxX);
        b.maxY = Math.max(b.maxY, g.maxY);
      }
    }
    return b;
  }

  // ---- ペンの操作 ----

  begin(sx, sy) {
    if (this.sel && this.hitSelection(sx, sy)) {
      const start = this.pagePoint(sx, sy, this.sel.pageIndex);
      this.mode = 'drag';
      this.drag = { start, dx: 0, dy: 0, bounds: this.selectionBounds(), moved: false };
      return;
    }
    this.clearSelection();
    this.mode = 'draw';
    this.path = [[sx, sy]];
    this.redraw();
  }

  move(sx, sy) {
    if (this.mode === 'draw') {
      const last = this.path[this.path.length - 1];
      if (Math.hypot(sx - last[0], sy - last[1]) < 2) return;
      this.path.push([sx, sy]);
      this.redraw();
    } else if (this.mode === 'drag') {
      const d = this.drag;
      const p = this.pagePoint(sx, sy, this.sel.pageIndex);
      let dx = p.x - d.start.x, dy = p.y - d.start.y;
      // ページの外に出ないようにする
      dx = Math.min(PAGE_WIDTH - d.bounds.maxX, Math.max(-d.bounds.minX, dx));
      dy = Math.min(PAGE_HEIGHT - d.bounds.maxY, Math.max(-d.bounds.minY, dy));
      d.dx = dx;
      d.dy = dy;
      if (!d.moved && Math.hypot(dx, dy) * this.vp.scale > 3) {
        d.moved = true;
        this.lift();
      }
      this.redraw();
    }
  }

  end() {
    const mode = this.mode;
    this.mode = null;
    if (mode === 'draw') {
      this.finishLoop();
    } else if (mode === 'drag') {
      const d = this.drag;
      this.drag = null;
      if (d.moved) this.commitMove(d.dx, d.dy);
      else this.redraw();
    }
    this.onChange();
  }

  cancel() {
    if (this.mode === 'drag' && this.drag && this.drag.moved) this.unlift();
    this.mode = null;
    this.drag = null;
    this.path = [];
    this.redraw();
  }

  // ---- 輪から選ぶ ----

  finishLoop() {
    const path = this.path;
    this.path = [];
    if (path.length < 3) return this.redraw();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of path) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    if (Math.max(maxX - minX, maxY - minY) < MIN_LOOP) return this.redraw();

    // 輪を書き始めたページの線だけを対象にする
    const doc0 = this.vp.toDoc(path[0][0], path[0][1]);
    let idx = this.vp.pageIndexAt(doc0.y);
    if (idx < 0) idx = this.vp.nearestPageIndex(doc0.y);
    const page = this.nb.pages[idx];
    const list = page && this.nb.strokes(page.id);
    if (!list) return this.redraw();
    const poly = path.map(([x, y]) => {
      const p = this.pagePoint(x, y, idx);
      return [p.x, p.y];
    });
    const picked = list.filter((s) => {
      const pts = s.points;
      const n = pts.length / 3;
      if (!n) return false;
      let inside = 0;
      for (let i = 0; i < pts.length; i += 3) if (pointInPolygon(pts[i], pts[i + 1], poly)) inside++;
      return inside / n >= SELECT_RATIO;
    });
    if (picked.length) this.sel = { pageId: page.id, pageIndex: idx, strokes: picked };
    this.redraw();
  }

  hitSelection(sx, sy) {
    if (!this.sel) return false;
    const r = this.toScreenRect(this.selectionBounds(), this.sel.pageIndex, BOX_PAD + 6);
    return sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h;
  }

  clearSelection() {
    if (this.drag && this.drag.moved) this.unlift();
    this.sel = null;
    this.drag = null;
    this.mode = null;
    this.path = [];
    this.onChange();
  }

  // 道具を変えたとき・ノートを切り替えたときなど
  clear() {
    this.clearSelection();
    this.redraw();
  }

  // ---- 動かす ----

  lift() {
    this.renderer.hidden = new Set(this.sel.strokes.map((s) => s.id));
    for (const s of this.sel.strokes) this.renderer.invalidateStroke(s);
  }

  unlift() {
    this.renderer.hidden = new Set();
    this.renderer.invalidatePage(this.sel.pageId);
  }

  commitMove(dx, dy) {
    const before = this.sel.strokes;
    const after = before.map((s) => translated(s, dx, dy));
    this.renderer.hidden = new Set();
    this.nb.replaceStrokes(before, after);
    this.history.push({ type: 'replace', before, after });
    this.sel.strokes = after;
    this.renderer.invalidatePage(this.sel.pageId);
    this.renderer.render();
    requestAnimationFrame(() => this.redraw());
  }

  // ---- 帯のボタン ----

  copy() {
    if (!this.sel) return false;
    this.clipboard = this.sel.strokes.map((s) => cloneStroke(s));
    this.onChange();
    return true;
  }

  remove() {
    if (!this.sel) return;
    const strokes = this.sel.strokes;
    this.nb.removeStrokes(strokes);
    for (const s of strokes) this.renderer.invalidateStroke(s);
    this.history.push({ type: 'erase', strokes });
    this.clearSelection();
    this.redraw();
  }

  recolor(colorKey) {
    if (!this.sel) return;
    const color = COLORS.find((c) => c.key === colorKey);
    if (!color) return;
    const before = this.sel.strokes;
    const after = before.map((s) => cloneStroke(s, { color: color[s.tool] || color.pen, updatedAt: now() }));
    this.nb.replaceStrokes(before, after);
    this.history.push({ type: 'replace', before, after });
    this.sel.strokes = after;
    for (const s of before) this.renderer.invalidateStroke(s);
    this.redraw();
  }

  // 見ているページの、画面の真ん中あたりに貼り付ける
  paste() {
    if (!this.clipboard.length) return false;
    const vp = this.vp;
    const idx = vp.currentPageIndex();
    const page = this.nb.pages[idx];
    if (!page) return false;
    let b = null;
    for (const s of this.clipboard) {
      const g = strokeGeometry(s).bounds;
      if (!b) b = { minX: g.minX, minY: g.minY, maxX: g.maxX, maxY: g.maxY };
      else {
        b.minX = Math.min(b.minX, g.minX); b.minY = Math.min(b.minY, g.minY);
        b.maxX = Math.max(b.maxX, g.maxX); b.maxY = Math.max(b.maxY, g.maxY);
      }
    }
    const center = this.pagePoint(vp.width / 2, vp.height / 2, idx);
    const w = b.maxX - b.minX, h = b.maxY - b.minY;
    let dx = center.x - (b.minX + w / 2), dy = center.y - (b.minY + h / 2);
    // ページの中におさめる
    dx = Math.min(PAGE_WIDTH - b.maxX, Math.max(-b.minX, dx));
    dy = Math.min(PAGE_HEIGHT - b.maxY, Math.max(-b.minY, dy));
    // もとの線と同じページ・同じ場所なら重ならないように少しずらす
    const same = this.clipboard[0].pageId === page.id && Math.abs(dx) < 1 && Math.abs(dy) < 1;
    if (same) {
      dx = Math.min(PAGE_WIDTH - b.maxX, dx + PASTE_NUDGE);
      dy = Math.min(PAGE_HEIGHT - b.maxY, dy + PASTE_NUDGE);
    }
    const t = now();
    const strokes = this.clipboard.map((s, i) => ({
      ...translated(s, dx, dy), id: newId(), pageId: page.id, createdAt: t + i, updatedAt: t,
    }));
    this.clearSelection();
    this.nb.addStrokes(strokes);
    this.history.push({ type: 'add', strokes });
    this.sel = { pageId: page.id, pageIndex: idx, strokes };
    this.renderer.invalidatePage(page.id);
    this.renderer.render();
    this.onChange();
    requestAnimationFrame(() => this.redraw());
    return true;
  }

  // ---- 重ね描き ----

  redraw() {
    const vp = this.vp;
    if (!this.mode && !this.sel) {
      if (!this.ink.active) this.ink.clear();
      return;
    }
    this.ink.overlay((ctx, dpr) => {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      if (this.mode === 'draw' && this.path.length > 1) {
        ctx.beginPath();
        this.path.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.fillStyle = 'rgba(47, 93, 138, 0.08)';
        ctx.fill();
        ctx.setLineDash([7, 5]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(47, 93, 138, 0.95)';
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (this.sel) {
        const d = this.drag && this.drag.moved ? this.drag : { dx: 0, dy: 0 };
        if (this.drag && this.drag.moved) {
          // 持ち上げている線を、動かした位置に描く（下の絵からは外してある）
          const S = vp.deviceScale;
          const X0 = Math.round(vp.ox * dpr) + d.dx * S;
          const Y0 = Math.round((vp.oy + vp.pageTop(this.sel.pageIndex) * vp.scale) * dpr) + d.dy * S;
          ctx.save();
          ctx.setTransform(S, 0, 0, S, X0, Y0);
          for (const s of this.sel.strokes) drawStroke(ctx, s);
          ctx.restore();
        }
        const r = this.toScreenRect(this.selectionBounds(), this.sel.pageIndex, BOX_PAD, d.dx, d.dy);
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(r.x, r.y, r.w, r.h, 8) : ctx.rect(r.x, r.y, r.w, r.h);
        ctx.fillStyle = 'rgba(47, 93, 138, 0.07)';
        ctx.fill();
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(47, 93, 138, 0.9)';
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });
  }
}
