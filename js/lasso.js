// なげなわ：囲んだ線・付箋・グループ枠を選び、ドラッグで移動する。コピー・削除・色変更・貼り付けは画面上部の小さな帯から。
// 移動・色変更・貼り付け・削除は、すべて「元に戻す」に対応する（history.js の change）。
//
// 選ぶもの：ページに直接書いた線（点の半分以上が輪の中）、付箋・枠（中心が輪の中）。枠を選ぶと、その枠に入っている付箋も選ぶ。
// 付箋の中の線・枠の名前の線は、付箋・枠と一緒に動く（相対位置で持っているので、付箋・枠の位置を変えるだけでよい）。
// 動かしている間は、選んだ物を下の絵から外して（renderer.hidden）、上の重ね描きの画面に描く。
// 指（ペン）を離したときに、新しい位置で入れ替えて保存する。
import { newId, now, PAGE_WIDTH, PAGE_HEIGHT } from './model.js';
import { COLORS } from './tools.js';
import { drawStroke, strokeGeometry } from './geometry.js';
import { drawSticky, drawFrame, drawConnectorSegment, connectorSegment, rectOf, unionBounds } from './scene.js';
import { frameFor, changeRegion, stickyDependents } from './objects.js';

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

const shifted = (o, dx, dy, t) => ({ ...o, x: Math.round((o.x + dx) * 100) / 100, y: Math.round((o.y + dy) * 100) / 100, updatedAt: t });

export class Lasso {
  constructor({ viewport, notebook, renderer, ink, history }) {
    this.vp = viewport;
    this.nb = notebook;
    this.renderer = renderer;
    this.ink = ink;
    this.history = history;
    this.commit = null;     // (pageId, before, after) 変更を確定する（app.js が ObjectTools の commit を入れる）
    this.sel = null;        // { pageId, pageIndex, strokes: [...], stickies: [...], frames: [...] }
    this.mode = null;       // null | 'draw' | 'drag'
    this.path = [];
    this.drag = null;
    this.clipboard = null;  // { strokes, stickies, frames, inner, connectors }
    this.onChange = () => {};
  }

  get active() {
    return this.mode !== null;
  }
  get hasSelection() {
    return !!this.sel;
  }
  get hasClipboard() {
    const c = this.clipboard;
    return !!c && (c.strokes.length + c.stickies.length + c.frames.length) > 0;
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

  static bounds(items) {
    let b = null;
    for (const s of items.strokes) b = unionBounds(b, strokeGeometry(s).bounds);
    for (const st of items.stickies) b = unionBounds(b, rectOf(st));
    for (const f of items.frames) b = unionBounds(b, rectOf(f));
    return b;
  }

  selectionBounds() {
    return Lasso.bounds(this.sel);
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
      if (this.vp.board < 0) {
        // ノートページの外に出ないようにする
        dx = Math.min(PAGE_WIDTH - d.bounds.maxX, Math.max(-d.bounds.minX, dx));
        dy = Math.min(PAGE_HEIGHT - d.bounds.maxY, Math.max(-d.bounds.minY, dy));
      }
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

    // 輪を書き始めたページの物だけを対象にする
    const doc0 = this.vp.toDoc(path[0][0], path[0][1]);
    let idx = this.vp.pageIndexAt(doc0.y);
    if (idx < 0) idx = this.vp.nearestPageIndex(doc0.y);
    const page = this.nb.pages[idx];
    if (!page || (page.kind === 'board' && this.vp.board < 0)) return this.redraw();
    const index = this.nb.index(page.id);
    if (!index) return this.redraw();
    const poly = path.map(([x, y]) => {
      const p = this.pagePoint(x, y, idx);
      return [p.x, p.y];
    });
    const strokes = index.free.filter((s) => {
      const pts = s.points;
      const n = pts.length / 3;
      if (!n) return false;
      let inside = 0;
      for (let i = 0; i < pts.length; i += 3) if (pointInPolygon(pts[i], pts[i + 1], poly)) inside++;
      return inside / n >= SELECT_RATIO;
    });
    const centerIn = (o) => pointInPolygon(o.x + o.w / 2, o.y + o.h / 2, poly);
    const frames = index.frames.filter(centerIn);
    const frameIds = new Set(frames.map((f) => f.id));
    const stickies = index.stickies.filter((s) => centerIn(s) || (s.frameId && frameIds.has(s.frameId)));
    if (strokes.length || stickies.length || frames.length) this.sel = { pageId: page.id, pageIndex: idx, strokes, stickies, frames };
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

  liftIds() {
    const sel = this.sel;
    const index = this.nb.index(sel.pageId);
    const ids = new Set();
    for (const x of [...sel.strokes, ...sel.stickies, ...sel.frames]) ids.add(x.id);
    const stickyIds = new Set(sel.stickies.map((s) => s.id));
    if (index) for (const c of index.connectors) if (stickyIds.has(c.fromId) || stickyIds.has(c.toId)) ids.add(c.id);
    return ids;
  }

  lift() {
    this.renderer.hidden = this.liftIds();
    this.renderer.refresh(this.sel.pageId, changeRegion(this.nb.index(this.sel.pageId), [this.sel]));
  }

  unlift() {
    this.renderer.hidden = new Set();
    this.renderer.refresh(this.sel.pageId, changeRegion(this.nb.index(this.sel.pageId), [this.sel]));
  }

  // 選んだ物を dx, dy 動かした後の形
  movedItems(dx, dy) {
    const sel = this.sel;
    const t = now();
    const index = this.nb.index(sel.pageId);
    const frames = sel.frames.map((f) => shifted(f, dx, dy, t));
    const movedFrameIds = new Set(frames.map((f) => f.id));
    const allFrames = index ? index.frames.map((f) => frames.find((x) => x.id === f.id) || f) : frames;
    const stickies = sel.stickies.map((s) => {
      const m = shifted(s, dx, dy, t);
      // 枠ごと動かした付箋はそのまま。付箋だけを動かしたときは、入る枠を決め直す
      if (!(s.frameId && movedFrameIds.has(s.frameId))) m.frameId = frameFor(m, allFrames);
      return m;
    });
    return { strokes: sel.strokes.map((s) => translated(s, dx, dy)), stickies, frames };
  }

  commitMove(dx, dy) {
    const before = { strokes: this.sel.strokes, stickies: this.sel.stickies, frames: this.sel.frames };
    const after = this.movedItems(dx, dy);
    this.renderer.hidden = new Set();
    this.commit(this.sel.pageId, before, after);
    this.sel = { ...this.sel, ...after };
    requestAnimationFrame(() => this.redraw());
  }

  // ---- 帯のボタン ----

  copy() {
    if (!this.sel) return false;
    const index = this.nb.index(this.sel.pageId);
    const stickyIds = new Set(this.sel.stickies.map((s) => s.id));
    const inner = [];
    if (index) {
      for (const s of this.sel.stickies) inner.push(...(index.bySticky.get(s.id) || []));
      for (const f of this.sel.frames) inner.push(...(index.byFrame.get(f.id) || []));
    }
    this.clipboard = {
      pageId: this.sel.pageId,
      strokes: this.sel.strokes.map((s) => cloneStroke(s)),
      stickies: this.sel.stickies.map((s) => ({ ...s })),
      frames: this.sel.frames.map((f) => ({ ...f })),
      inner: inner.map((s) => cloneStroke(s)),
      connectors: index ? index.connectors.filter((c) => stickyIds.has(c.fromId) && stickyIds.has(c.toId)).map((c) => ({ ...c })) : [],
    };
    this.onChange();
    return true;
  }

  remove() {
    if (!this.sel) return;
    const sel = this.sel;
    const index = this.nb.index(sel.pageId);
    const stickyIds = new Set(sel.stickies.map((s) => s.id));
    const frameIds = new Set(sel.frames.map((f) => f.id));
    const before = { strokes: [...sel.strokes], stickies: [...sel.stickies], frames: [...sel.frames], connectors: [] };
    const after = { stickies: [] };
    if (index) {
      const dep = stickyDependents(index, stickyIds);
      before.strokes.push(...dep.strokes);
      before.connectors.push(...dep.connectors);
      for (const f of sel.frames) before.strokes.push(...(index.byFrame.get(f.id) || []));
      // 消した枠に入っていた付箋（選んでいない物）は残し、所属だけ外す
      const t = now();
      for (const s of index.stickies) {
        if (!stickyIds.has(s.id) && s.frameId && frameIds.has(s.frameId)) {
          before.stickies.push(s);
          after.stickies.push({ ...s, frameId: null, updatedAt: t });
        }
      }
    }
    this.clearSelection();
    this.commit(sel.pageId, before, after);
    this.redraw();
  }

  recolor(colorKey) {
    if (!this.sel) return;
    const color = COLORS.find((c) => c.key === colorKey);
    if (!color) return;
    const index = this.nb.index(this.sel.pageId);
    const targets = [...this.sel.strokes];
    if (index) for (const s of this.sel.stickies) targets.push(...(index.bySticky.get(s.id) || []));
    if (!targets.length) return;
    const t = now();
    const after = targets.map((s) => cloneStroke(s, { color: color[s.tool] || color.pen, updatedAt: t }));
    this.commit(this.sel.pageId, { strokes: targets }, { strokes: after });
    const recolored = new Map(after.map((s) => [s.id, s]));
    this.sel = { ...this.sel, strokes: this.sel.strokes.map((s) => recolored.get(s.id) || s) };
    this.redraw();
  }

  // 見ているページの、画面の真ん中あたりに貼り付ける
  paste() {
    if (!this.hasClipboard) return false;
    const vp = this.vp;
    const idx = vp.currentPageIndex();
    const page = this.nb.pages[idx];
    if (!page || (page.kind === 'board' && vp.board < 0)) return false;
    const index = this.nb.index(page.id);
    if (!index) return false;
    const clip = this.clipboard;
    const b = Lasso.bounds(clip);
    const center = this.pagePoint(vp.width / 2, vp.height / 2, idx);
    const w = b.maxX - b.minX, h = b.maxY - b.minY;
    let dx = center.x - (b.minX + w / 2), dy = center.y - (b.minY + h / 2);
    const board = vp.board >= 0;
    const fit = () => {
      if (board) return;
      // ページの中におさめる
      dx = Math.min(PAGE_WIDTH - b.maxX, Math.max(-b.minX, dx));
      dy = Math.min(PAGE_HEIGHT - b.maxY, Math.max(-b.minY, dy));
    };
    fit();
    // もとの物と同じページ・同じ場所なら重ならないように少しずらす
    if (clip.pageId === page.id && Math.abs(dx) < 1 && Math.abs(dy) < 1) {
      dx += PASTE_NUDGE;
      dy += PASTE_NUDGE;
      fit();
    }
    const t = now();
    const ids = new Map();
    const idFor = (old) => {
      if (!ids.has(old)) ids.set(old, newId());
      return ids.get(old);
    };
    const frames = clip.frames.map((f, i) => ({ ...shifted(f, dx, dy, t), id: idFor(f.id), pageId: page.id, createdAt: t + i }));
    const allFrames = [...index.frames, ...frames];
    const stickies = clip.stickies.map((s, i) => {
      const m = { ...shifted(s, dx, dy, t), id: idFor(s.id), pageId: page.id, createdAt: t + i, z: index.maxZ + 1 + i };
      m.frameId = s.frameId && ids.has(s.frameId) ? ids.get(s.frameId) : frameFor(m, allFrames);
      return m;
    });
    const strokes = clip.strokes.map((s, i) => ({ ...translated(s, dx, dy), id: newId(), pageId: page.id, createdAt: t + i, updatedAt: t }));
    const inner = clip.inner.map((s, i) => ({
      ...cloneStroke(s), id: newId(), pageId: page.id, createdAt: t + i, updatedAt: t,
      stickyId: s.stickyId ? ids.get(s.stickyId) || null : null,
      frameId: s.frameId ? ids.get(s.frameId) || null : null,
    }));
    const connectors = clip.connectors.map((c, i) => ({ ...c, id: newId(), pageId: page.id, fromId: ids.get(c.fromId), toId: ids.get(c.toId), createdAt: t + i, updatedAt: t }));
    this.clearSelection();
    this.commit(page.id, {}, { strokes: [...strokes, ...inner], stickies, frames, connectors });
    this.sel = { pageId: page.id, pageIndex: idx, strokes, stickies, frames };
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
        if (this.drag && this.drag.moved) this.drawLifted(ctx, dpr, d.dx, d.dy);
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

  // 持ち上げている物を、動かした位置に描く（下の絵からは外してある）
  drawLifted(ctx, dpr, dx, dy) {
    const vp = this.vp, sel = this.sel;
    const index = this.nb.index(sel.pageId);
    const S = vp.deviceScale;
    const X0 = Math.round(vp.ox * dpr);
    const Y0 = Math.round((vp.oy + vp.pageTop(sel.pageIndex) * vp.scale) * dpr);
    ctx.save();
    ctx.setTransform(S, 0, 0, S, X0, Y0);
    const moved = new Map(sel.stickies.map((s) => [s.id, { ...s, x: s.x + dx, y: s.y + dy }]));
    for (const f of sel.frames) drawFrame(ctx, { ...f, x: f.x + dx, y: f.y + dy }, index && index.byFrame.get(f.id));
    if (index) {
      const look = (id) => moved.get(id) || index.stickyById.get(id);
      for (const c of index.connectors) {
        if (!moved.has(c.fromId) && !moved.has(c.toId)) continue;
        drawConnectorSegment(ctx, connectorSegment(look(c.fromId), look(c.toId)), c.arrow, c.color || '#4a5260');
      }
    }
    ctx.translate(dx, dy);
    for (const s of sel.strokes) drawStroke(ctx, s);
    ctx.translate(-dx, -dy);
    for (const s of moved.values()) drawSticky(ctx, s, index && index.bySticky.get(s.id));
    ctx.restore();
  }
}
