// 付箋・コネクタ・グループ枠の操作。
//   付箋     ：付箋の道具でタップした所に置く。上の帯をつまんで移動、右下の角で大きさを変える。帯をタップすると色・削除のメニュー
//   コネクタ ：コネクタの道具で付箋Aから付箋Bへなぞると、つながる。線をタップすると矢印（なし・先だけ・両方）と削除のメニュー
//   グループ枠：枠の道具で付箋を囲むと枠ができる。上辺に名前を手書きできる。上辺をつまんで移動（中の付箋も一緒に動く）、右下の角で大きさを変える
// ペンでも指でもつまめる（指でつまんだときは画面を動かさない）。
//
// 変更はすべて「変更の記録」 { type: 'change', pageId, before, after } として元に戻す・やり直すに積む（history.js）。
// 動かしている間は、動かす物を下の絵から外して（renderer.hidden）、上の重ね描きの画面に描く。離したときに保存して描き直す。
import {
  PAGE_WIDTH, PAGE_HEIGHT, STICKY_BAND, STICKY_MIN, FRAME_BAND, FRAME_MIN, FRAME_PAD,
  createSticky, createConnector, createFrame, now,
} from './model.js';
import { strokeGeometry } from './geometry.js';
import {
  STICKY_COLORS, FRAME_COLORS, drawSticky, drawFrame, drawConnectorSegment, connectorSegment, segmentBounds,
  stickyBounds, frameBounds, unionBounds, distToSegment, rectOf,
} from './scene.js';
import { h } from './dom.js';

const MOVE_THRESHOLD = 3;   // これより動いたら「動かす」（画面ピクセル）
const CONNECTOR_HIT = 14;   // コネクタをタップしたとみなす距離（画面ピクセル）
const MIN_LOOP = 12;

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRect(x, y, r) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

// 付箋の中心を含む枠のうち、いちばん小さい枠（無ければ null）。frames は枠の一覧
export function frameFor(st, frames) {
  const cx = st.x + st.w / 2, cy = st.y + st.h / 2;
  let best = null;
  for (const f of frames) {
    if (!inRect(cx, cy, f)) continue;
    if (!best || f.w * f.h < best.w * best.h) best = f;
  }
  return best ? best.id : null;
}

// 変更にかかわる範囲（描き直す範囲）。idx はいまのページの索引、lists は変更の前・後の { strokes, stickies, connectors, frames }
export function changeRegion(idx, lists) {
  let b = null;
  const stickyIds = new Set(), frameIds = new Set();
  const local = new Map();
  for (const L of lists) {
    if (!L) continue;
    for (const st of L.stickies || []) { b = unionBounds(b, stickyBounds(st)); stickyIds.add(st.id); local.set(st.id, st); }
    for (const f of L.frames || []) { b = unionBounds(b, frameBounds(f)); frameIds.add(f.id); }
    for (const c of L.connectors || []) { stickyIds.add(c.fromId); stickyIds.add(c.toId); }
    for (const s of L.strokes || []) {
      if (s.stickyId) stickyIds.add(s.stickyId);
      else if (s.frameId) frameIds.add(s.frameId);
      else b = unionBounds(b, strokeGeometry(s).bounds);
    }
  }
  if (!idx) return b;
  for (const id of stickyIds) { const st = idx.stickyById.get(id); if (st) b = unionBounds(b, stickyBounds(st)); }
  for (const id of frameIds) { const f = idx.frameById.get(id); if (f) b = unionBounds(b, frameBounds(f)); }
  const find = (id) => idx.stickyById.get(id) || local.get(id);
  for (const c of idx.connectors) {
    if (!stickyIds.has(c.fromId) && !stickyIds.has(c.toId)) continue;
    b = unionBounds(b, segmentBounds(connectorSegment(idx.stickyById.get(c.fromId), idx.stickyById.get(c.toId))));
  }
  for (const L of lists) {
    for (const c of (L && L.connectors) || []) {
      const a = find(c.fromId), z = find(c.toId);
      if (a && z) b = unionBounds(b, segmentBounds(connectorSegment(a, z)));
    }
  }
  return b;
}

// 付箋を消すときに一緒に消す物（中の線・つながっているコネクタ）
export function stickyDependents(idx, stickyIds) {
  const strokes = [], connectors = [];
  for (const id of stickyIds) strokes.push(...(idx.bySticky.get(id) || []));
  for (const c of idx.connectors) if (stickyIds.has(c.fromId) || stickyIds.has(c.toId)) connectors.push(c);
  // つなぐ先が消えているコネクタ（索引からは外れている）も一緒に片付ける
  return { strokes, connectors };
}

// ---- 小さなメニュー（付箋・コネクタ・枠をタップしたとき） ----

class Popover {
  constructor() {
    this.el = h('div', { id: 'object-menu', hidden: true });
    document.body.append(this.el);
    const outside = (e) => {
      if (!this.el.hidden && !this.el.contains(e.target)) this.close();
    };
    document.addEventListener('touchstart', outside, { capture: true, passive: true });
    document.addEventListener('mousedown', outside, true);
  }
  get isOpen() {
    return !this.el.hidden;
  }
  // x, y は画面（ブラウザの表示領域）の座標。rows は要素の並び
  open(x, y, title, rows) {
    this.el.replaceChildren(h('div', { class: 'om-title' }, title), ...rows);
    this.el.hidden = false;
    const r = this.el.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - r.width - 8, x - r.width / 2));
    let top = y + 16;
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, y - r.height - 16);
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }
  close() {
    this.el.hidden = true;
  }
}

export class ObjectTools {
  constructor({ viewport, notebook, renderer, ink, history, stage, toast, beforeEdit }) {
    this.vp = viewport;
    this.nb = notebook;
    this.renderer = renderer;
    this.ink = ink;
    this.history = history;
    this.stage = stage;
    this.toast = toast;
    this.beforeEdit = beforeEdit || (() => {}); // なげなわの選択を外すなど
    this.op = null;
    this.menu = new Popover();
  }

  get active() {
    return !!this.op;
  }

  // ---- 座標と当たり判定 ----

  // 画面座標 → { pageIndex, page, x, y（ページ座標）}。ページの外（すきま）なら null
  at(sx, sy) {
    const doc = this.vp.toDoc(sx, sy);
    const i = this.vp.pageIndexAt(doc.y);
    if (i < 0) return null;
    const page = this.nb.pages[i];
    if (!page) return null;
    if (page.kind === 'board' && this.vp.board < 0) return null; // ノートページの並びの中のボードページ（縮小表示）は、開いてから操作する
    return { pageIndex: i, page, x: doc.x, y: doc.y - this.vp.pageTop(i), board: this.vp.board >= 0 };
  }

  px(n) {
    return n / this.vp.scale; // 画面ピクセル → ページ座標
  }

  // いちばん上の付箋と、触れた部分（'corner' | 'band' | 'body'）
  hitSticky(idx, x, y) {
    for (let i = idx.stickies.length - 1; i >= 0; i--) {
      const st = idx.stickies[i];
      if (!inRect(x, y, st)) continue;
      const c = Math.max(26, this.px(24));
      if (x >= st.x + st.w - c && y >= st.y + st.h - c) return { st, part: 'corner' };
      if (y <= st.y + Math.min(st.h / 2, Math.max(STICKY_BAND, this.px(22)))) return { st, part: 'band' };
      return { st, part: 'body' };
    }
    return null;
  }

  // 枠の上辺（'band'）か右下の角（'corner'）。後から作った枠を優先
  hitFrame(idx, x, y) {
    const c = Math.max(36, this.px(26));
    for (let i = idx.frames.length - 1; i >= 0; i--) {
      const f = idx.frames[i];
      if (x >= f.x + f.w - c && x <= f.x + f.w + this.px(6) && y >= f.y + f.h - c && y <= f.y + f.h + this.px(6)) return { f, part: 'corner' };
    }
    for (let i = idx.frames.length - 1; i >= 0; i--) {
      const f = idx.frames[i];
      if (x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + Math.min(f.h, FRAME_BAND)) return { f, part: 'band' };
    }
    return null;
  }

  hitConnector(idx, x, y) {
    const tol = this.px(CONNECTOR_HIT);
    let best = null, bestD = Infinity;
    for (const c of idx.connectors) {
      const g = connectorSegment(idx.stickyById.get(c.fromId), idx.stickyById.get(c.toId));
      const d = distToSegment(x, y, g);
      if (d <= tol && d < bestD) { best = c; bestD = d; }
    }
    return best;
  }

  // ペン・マーカーで書き始めた所が付箋・枠の上辺なら、そこに書くための情報（ink.begin に渡す原点など）
  writeTarget(pageId, x, y) {
    const idx = this.nb.index(pageId);
    if (!idx) return null;
    const hs = this.hitSticky(idx, x, y);
    if (hs) {
      const st = hs.st;
      return { stickyId: st.id, origin: { x: st.x, y: st.y, clip: { x: 0, y: 0, w: st.w, h: st.h } } };
    }
    const hf = this.hitFrame(idx, x, y);
    if (hf && hf.part === 'band') {
      const f = hf.f;
      return { frameId: f.id, origin: { x: f.x, y: f.y, clip: { x: 0, y: 0, w: f.w, h: Math.min(f.h, FRAME_BAND) } } };
    }
    return null;
  }

  // ---- ペンの操作 ----
  // 付箋の帯・角などをつかんだら true（そのペンの動きはここで受け持つ）。false ならふつうに書く・消す

  penStart(sx, sy, tool) {
    this.menu.close();
    const objTool = tool === 'sticky' || tool === 'connector' || tool === 'frame';
    const a = this.at(sx, sy);
    if (!a || (!a.board && (a.x < 0 || a.x > PAGE_WIDTH))) return objTool;
    const idx = this.nb.index(a.page.id);
    if (!idx) return objTool;
    const hs = this.hitSticky(idx, a.x, a.y);

    if (tool === 'connector') {
      if (hs) return this.startOp({ type: 'connect', a, from: hs.st, sx, sy });
      const c = this.hitConnector(idx, a.x, a.y);
      if (c) return this.startOp({ type: 'tap-connector', a, connector: c, sx, sy });
      return true;
    }
    if (hs && (hs.part === 'band' || hs.part === 'corner')) {
      return this.startOp({ type: hs.part === 'band' ? 'move-sticky' : 'resize-sticky', a, st: hs.st, sx, sy });
    }
    const hf = hs ? null : this.hitFrame(idx, a.x, a.y);
    if (hf && hf.part === 'corner') return this.startOp({ type: 'resize-frame', a, f: hf.f, sx, sy });
    if (tool === 'frame') {
      if (hf) return this.startOp({ type: 'move-frame', a, f: hf.f, sx, sy });
      return this.startOp({ type: 'frame-loop', a, path: [[sx, sy]] });
    }
    if (tool === 'sticky') {
      if (hs) return false; // 付箋の上では、そのままペンで書く
      return this.startOp({ type: 'create-sticky', a, sx, sy });
    }
    return false;
  }

  // 指でつまむ（付箋の帯・角、枠の上辺・角）。つまんだら true
  fingerStart(sx, sy) {
    this.menu.close();
    const a = this.at(sx, sy);
    if (!a) return false;
    const idx = this.nb.index(a.page.id);
    if (!idx) return false;
    const hs = this.hitSticky(idx, a.x, a.y);
    if (hs) {
      if (hs.part === 'body') return false;
      return this.startOp({ type: hs.part === 'band' ? 'move-sticky' : 'resize-sticky', a, st: hs.st, sx, sy, finger: true });
    }
    const hf = this.hitFrame(idx, a.x, a.y);
    if (hf) return this.startOp({ type: hf.part === 'band' ? 'move-frame' : 'resize-frame', a, f: hf.f, sx, sy, finger: true });
    return false;
  }

  // 指でタップ：コネクタならメニュー。何かしたら true
  fingerTap(sx, sy) {
    const a = this.at(sx, sy);
    if (!a) return false;
    const idx = this.nb.index(a.page.id);
    if (!idx) return false;
    if (this.hitSticky(idx, a.x, a.y)) return false;
    const c = this.hitConnector(idx, a.x, a.y);
    if (!c) return false;
    this.openConnectorMenu(a.page.id, c, sx, sy);
    return true;
  }

  startOp(op) {
    this.beforeEdit();
    op.moved = false;
    op.dx = 0;
    op.dy = 0;
    op.pageId = op.a.page.id;
    op.pageIndex = op.a.pageIndex;
    op.start = { x: op.a.x, y: op.a.y };
    this.op = op;
    if (op.type === 'frame-loop' || op.type === 'connect') this.redraw();
    return true;
  }

  move(sx, sy) {
    const op = this.op;
    if (!op) return;
    if (op.type === 'frame-loop') {
      const last = op.path[op.path.length - 1];
      if (Math.hypot(sx - last[0], sy - last[1]) < 2) return;
      op.path.push([sx, sy]);
      this.redraw();
      return;
    }
    const doc = this.vp.toDoc(sx, sy);
    const p = { x: doc.x, y: doc.y - this.vp.pageTop(op.pageIndex) };
    op.cur = p;
    op.dx = p.x - op.start.x;
    op.dy = p.y - op.start.y;
    if (!op.moved && Math.hypot(sx - op.sx, sy - op.sy) > MOVE_THRESHOLD) {
      op.moved = true;
      if (op.type !== 'connect' && op.type !== 'create-sticky' && op.type !== 'tap-connector') this.lift();
    }
    if (op.moved) this.redraw();
  }

  end() {
    const op = this.op;
    if (!op) return;
    this.op = null;
    const idx = this.nb.index(op.pageId);
    if (!idx) return this.finishOverlay();
    switch (op.type) {
      case 'create-sticky': return this.createStickyAt(op, idx);
      case 'tap-connector':
        this.finishOverlay();
        if (!op.moved) this.openConnectorMenu(op.pageId, op.connector, op.sx, op.sy);
        return;
      case 'connect': return this.finishConnect(op, idx);
      case 'frame-loop': return this.finishFrameLoop(op, idx);
      default:
        if (!op.moved) {
          this.finishOverlay();
          if (op.type === 'move-sticky') this.openStickyMenu(op.pageId, op.st, op.sx, op.sy);
          else if (op.type === 'move-frame') this.openFrameMenu(op.pageId, op.f, op.sx, op.sy);
          return;
        }
        return this.commitDrag(op, idx);
    }
  }

  // ペンが触れた・道具を変えたなど。動かしていた物は元の位置に戻す
  cancel() {
    const op = this.op;
    if (!op) return;
    this.op = null;
    if (op.lifted) this.unlift(op);
    this.finishOverlay();
  }

  // ---- 動かす（帯・角をつまんだとき） ----

  // 動かしている物（ページ座標）。clamp でノートページの外に出ないようにする
  dragged(op, idx) {
    const board = this.vp.board >= 0;
    const limitMove = (b, dx, dy) => {
      if (board) return [dx, dy];
      return [Math.min(PAGE_WIDTH - b.maxX, Math.max(-b.minX, dx)), Math.min(PAGE_HEIGHT - b.maxY, Math.max(-b.minY, dy))];
    };
    const t = now();
    if (op.type === 'move-sticky') {
      const st = op.st;
      const [dx, dy] = limitMove(rectOf(st), op.dx, op.dy);
      const moved = { ...st, x: Math.round(st.x + dx), y: Math.round(st.y + dy), z: idx.maxZ + 1, updatedAt: t };
      return { stickies: [moved], frames: [] };
    }
    if (op.type === 'resize-sticky') {
      const st = op.st;
      let w = Math.max(STICKY_MIN, st.w + op.dx), hh = Math.max(STICKY_MIN, st.h + op.dy);
      if (!board) { w = Math.min(w, PAGE_WIDTH - st.x); hh = Math.min(hh, PAGE_HEIGHT - st.y); }
      return { stickies: [{ ...st, w: Math.round(w), h: Math.round(hh), updatedAt: t }], frames: [] };
    }
    if (op.type === 'move-frame') {
      const f = op.f;
      const members = idx.stickies.filter((s) => s.frameId === f.id);
      let b = rectOf(f);
      for (const s of members) b = unionBounds(b, rectOf(s));
      let [dx, dy] = limitMove(b, op.dx, op.dy);
      dx = Math.round(dx);
      dy = Math.round(dy);
      return {
        frames: [{ ...f, x: f.x + dx, y: f.y + dy, updatedAt: t }],
        stickies: members.map((s) => ({ ...s, x: s.x + dx, y: s.y + dy, updatedAt: t })),
      };
    }
    // resize-frame
    const f = op.f;
    let w = Math.max(FRAME_MIN, f.w + op.dx), hh = Math.max(FRAME_MIN, f.h + op.dy);
    if (!board) { w = Math.min(w, PAGE_WIDTH - f.x); hh = Math.min(hh, PAGE_HEIGHT - f.y); }
    return { frames: [{ ...f, w: Math.round(w), h: Math.round(hh), updatedAt: t }], stickies: [] };
  }

  liftIds(op, idx) {
    const ids = new Set();
    const stickyIds = new Set();
    if (op.st) stickyIds.add(op.st.id);
    if (op.f) {
      ids.add(op.f.id);
      if (op.type === 'move-frame') for (const s of idx.stickies) if (s.frameId === op.f.id) stickyIds.add(s.id);
    }
    for (const id of stickyIds) ids.add(id);
    for (const c of idx.connectors) if (stickyIds.has(c.fromId) || stickyIds.has(c.toId)) ids.add(c.id);
    return { ids, stickyIds };
  }

  lift() {
    const op = this.op;
    const idx = this.nb.index(op.pageId);
    if (!idx) return;
    const { ids, stickyIds } = this.liftIds(op, idx);
    op.lifted = { ids, stickyIds };
    this.renderer.hidden = ids;
    this.renderer.refresh(op.pageId, changeRegion(idx, [{ stickies: [...stickyIds].map((id) => idx.stickyById.get(id)), frames: op.f ? [op.f] : [] }]));
  }

  unlift(op) {
    const idx = this.nb.index(op.pageId);
    this.renderer.hidden = new Set();
    this.renderer.refresh(op.pageId, idx ? changeRegion(idx, [{ stickies: [...op.lifted.stickyIds].map((id) => idx.stickyById.get(id)).filter(Boolean), frames: op.f ? [op.f] : [] }]) : null);
  }

  commitDrag(op, idx) {
    const after = this.dragged(op, idx);
    const before = {
      stickies: after.stickies.map((s) => idx.stickyById.get(s.id)),
      frames: after.frames.map((f) => idx.frameById.get(f.id)),
    };
    // 所属する枠を決め直す（付箋を動かした・大きさを変えた、枠の大きさを変えた）
    if (op.type === 'move-sticky' || op.type === 'resize-sticky') {
      for (const s of after.stickies) s.frameId = frameFor(s, idx.frames);
    } else if (op.type === 'resize-frame') {
      const frames = idx.frames.map((f) => (f.id === op.f.id ? after.frames[0] : f));
      for (const s of idx.stickies) {
        const fid = frameFor(s, frames);
        if (fid !== (s.frameId || null)) {
          before.stickies.push(s);
          after.stickies.push({ ...s, frameId: fid, updatedAt: now() });
        }
      }
    }
    this.renderer.hidden = new Set();
    this.commit(op.pageId, before, after);
    this.finishOverlay();
  }

  // ---- 付箋を置く ----

  createStickyAt(op, idx) {
    this.finishOverlay();
    const board = this.vp.board >= 0;
    const st = createSticky({ pageId: op.pageId, x: 0, y: 0, color: this.stickyColor ? this.stickyColor() : 'yellow', z: idx.maxZ + 1 });
    let x = op.start.x - st.w / 2, y = op.start.y - STICKY_BAND / 2;
    if (!board) {
      x = Math.min(PAGE_WIDTH - st.w, Math.max(0, x));
      y = Math.min(PAGE_HEIGHT - st.h, Math.max(0, y));
    }
    st.x = Math.round(x);
    st.y = Math.round(y);
    st.frameId = frameFor(st, idx.frames);
    this.commit(op.pageId, {}, { stickies: [st] });
  }

  // ---- コネクタ ----

  finishConnect(op, idx) {
    this.finishOverlay();
    if (!op.moved || !op.cur) return;
    const hs = this.hitSticky(idx, op.cur.x, op.cur.y);
    const to = hs && hs.st;
    if (!to || to.id === op.from.id) return;
    const dup = idx.connectors.find((c) => (c.fromId === op.from.id && c.toId === to.id) || (c.fromId === to.id && c.toId === op.from.id));
    if (dup) {
      this.toast('この2つの付箋は、すでにつながっています');
      return;
    }
    this.commit(op.pageId, {}, { connectors: [createConnector({ pageId: op.pageId, fromId: op.from.id, toId: to.id })] });
  }

  // ---- 枠を作る ----

  finishFrameLoop(op, idx) {
    this.finishOverlay();
    const path = op.path;
    if (path.length < 3) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of path) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    if (Math.max(maxX - minX, maxY - minY) < MIN_LOOP) return;
    const top = this.vp.pageTop(op.pageIndex);
    const poly = path.map(([x, y]) => {
      const d = this.vp.toDoc(x, y);
      return [d.x, d.y - top];
    });
    const inside = idx.stickies.filter((s) => pointInPolygon(s.x + s.w / 2, s.y + s.h / 2, poly));
    let r;
    if (inside.length) {
      let b = null;
      for (const s of inside) b = unionBounds(b, rectOf(s));
      r = { x: b.minX - FRAME_PAD, y: b.minY - FRAME_PAD - FRAME_BAND, w: b.maxX - b.minX + FRAME_PAD * 2, h: b.maxY - b.minY + FRAME_PAD * 2 + FRAME_BAND };
    } else {
      let b = null;
      for (const [x, y] of poly) b = unionBounds(b, { minX: x, minY: y, maxX: x, maxY: y });
      r = { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
      if (r.w < FRAME_MIN || r.h < FRAME_MIN) {
        this.toast('付箋をぐるっと囲むと、グループ枠ができます');
        return;
      }
    }
    if (this.vp.board < 0) {
      r.w = Math.min(r.w, PAGE_WIDTH);
      r.h = Math.min(r.h, PAGE_HEIGHT);
      r.x = Math.min(PAGE_WIDTH - r.w, Math.max(0, r.x));
      r.y = Math.min(PAGE_HEIGHT - r.h, Math.max(0, r.y));
    }
    const f = createFrame({ pageId: op.pageId, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
    const frames = [...idx.frames, f];
    const before = { stickies: [] }, after = { frames: [f], stickies: [] };
    for (const s of idx.stickies) {
      const fid = frameFor(s, frames);
      if (fid !== (s.frameId || null)) {
        before.stickies.push(s);
        after.stickies.push({ ...s, frameId: fid, updatedAt: now() });
      }
    }
    this.commit(op.pageId, before, after);
    this.toast(inside.length ? `付箋${inside.length}枚をグループ枠にまとめました。上辺に名前を書けます` : 'グループ枠を作りました。上辺に名前を書けます', 3500);
  }

  // ---- 変更を確定する（元に戻すに積み、保存し、描き直す） ----

  commit(pageId, before, after) {
    const r0 = changeRegion(this.nb.index(pageId), [before, after]);
    this.nb.applyChange(before, after);
    this.history.push({ type: 'change', pageId, before, after });
    const r1 = changeRegion(this.nb.index(pageId), [before, after]);
    this.renderer.refresh(pageId, unionBounds(r0, r1));
    this.renderer.render();
  }

  // ---- メニュー ----

  screenPoint(sx, sy) {
    const r = this.stage.getBoundingClientRect();
    return [r.left + sx, r.top + sy];
  }

  openStickyMenu(pageId, st, sx, sy) {
    const [x, y] = this.screenPoint(sx, sy);
    const colors = h('div', { class: 'om-row' }, STICKY_COLORS.map((c) => h('button', {
      type: 'button', class: `om-swatch${c.key === st.color ? ' on' : ''}`, 'aria-label': `${c.label}にする`,
      onclick: () => { this.menu.close(); this.recolorSticky(pageId, st.id, c.key); },
    }, h('i', { style: `background:${c.fill};box-shadow:inset 0 0 0 1.5px ${c.edge}` }))));
    this.menu.open(x, y, '付箋', [
      colors,
      h('div', { class: 'om-row' },
        h('button', { type: 'button', class: 'om-btn danger-text', onclick: () => { this.menu.close(); this.deleteSticky(pageId, st.id); } }, '付箋を削除')),
    ]);
  }

  openConnectorMenu(pageId, c, sx, sy) {
    const [x, y] = this.screenPoint(sx, sy);
    const choice = (value, label) => h('button', {
      type: 'button', class: `om-btn${c.arrow === value ? ' on' : ''}`,
      onclick: () => { this.menu.close(); this.setArrow(pageId, c.id, value); },
    }, label);
    this.menu.open(x, y, 'コネクタの矢印', [
      h('div', { class: 'om-row' }, choice('none', 'なし'), choice('end', '先だけ →'), choice('both', '両方 ↔')),
      h('div', { class: 'om-row' },
        h('button', { type: 'button', class: 'om-btn danger-text', onclick: () => { this.menu.close(); this.deleteConnector(pageId, c.id); } }, 'コネクタを削除')),
    ]);
  }

  openFrameMenu(pageId, f, sx, sy) {
    const [x, y] = this.screenPoint(sx, sy);
    const colors = h('div', { class: 'om-row' }, FRAME_COLORS.map((c) => h('button', {
      type: 'button', class: `om-swatch${c.key === f.color ? ' on' : ''}`, 'aria-label': `${c.label}にする`,
      onclick: () => { this.menu.close(); this.recolorFrame(pageId, f.id, c.key); },
    }, h('i', { style: `background:${c.band};box-shadow:inset 0 0 0 2px ${c.line}` }))));
    this.menu.open(x, y, 'グループ枠', [
      colors,
      h('div', { class: 'om-row' },
        h('button', { type: 'button', class: 'om-btn danger-text', onclick: () => { this.menu.close(); this.deleteFrame(pageId, f.id); } }, '枠を削除（付箋は残ります）')),
    ]);
  }

  closeMenu() {
    this.menu.close();
  }

  recolorSticky(pageId, id, color) {
    const idx = this.nb.index(pageId);
    const st = idx && idx.stickyById.get(id);
    if (!st || st.color === color) return;
    this.commit(pageId, { stickies: [st] }, { stickies: [{ ...st, color, updatedAt: now() }] });
  }

  deleteSticky(pageId, id) {
    const idx = this.nb.index(pageId);
    const st = idx && idx.stickyById.get(id);
    if (!st) return;
    const dep = stickyDependents(idx, new Set([id]));
    this.commit(pageId, { stickies: [st], strokes: dep.strokes, connectors: dep.connectors }, {});
  }

  setArrow(pageId, id, arrow) {
    const idx = this.nb.index(pageId);
    const c = idx && idx.connectors.find((x) => x.id === id);
    if (!c || c.arrow === arrow) return;
    this.commit(pageId, { connectors: [c] }, { connectors: [{ ...c, arrow, updatedAt: now() }] });
  }

  deleteConnector(pageId, id) {
    const idx = this.nb.index(pageId);
    const c = idx && idx.connectors.find((x) => x.id === id);
    if (c) this.commit(pageId, { connectors: [c] }, {});
  }

  recolorFrame(pageId, id, color) {
    const idx = this.nb.index(pageId);
    const f = idx && idx.frameById.get(id);
    if (!f || f.color === color) return;
    this.commit(pageId, { frames: [f] }, { frames: [{ ...f, color, updatedAt: now() }] });
  }

  // 枠を消す。名前の線も消し、中の付箋は残す（所属だけ外す）
  deleteFrame(pageId, id) {
    const idx = this.nb.index(pageId);
    const f = idx && idx.frameById.get(id);
    if (!f) return;
    const members = idx.stickies.filter((s) => s.frameId === id);
    const t = now();
    this.commit(pageId,
      { frames: [f], strokes: idx.byFrame.get(id) || [], stickies: members },
      { stickies: members.map((s) => ({ ...s, frameId: null, updatedAt: t })) });
  }

  // ---- 重ね描き ----

  finishOverlay() {
    requestAnimationFrame(() => {
      if (!this.op && !this.ink.active) this.ink.clear();
    });
  }

  redraw() {
    const op = this.op;
    if (!op) return;
    const vp = this.vp;
    const idx = this.nb.index(op.pageId);
    if (!idx) return;
    this.ink.overlay((ctx, dpr) => {
      if (op.type === 'frame-loop') {
        if (op.path.length < 2) return;
        ctx.beginPath();
        op.path.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.fillStyle = 'rgba(47, 93, 138, 0.08)';
        ctx.fill();
        ctx.setLineDash([7, 5]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(47, 93, 138, 0.95)';
        ctx.stroke();
        ctx.setLineDash([]);
        return;
      }
      const S = vp.deviceScale;
      const X0 = Math.round(vp.ox * dpr);
      const Y0 = Math.round((vp.oy + vp.pageTop(op.pageIndex) * vp.scale) * dpr);
      ctx.setTransform(S, 0, 0, S, X0, Y0);
      if (op.type === 'connect') {
        if (!op.cur) return;
        const hs = this.hitSticky(idx, op.cur.x, op.cur.y);
        const target = hs && hs.st.id !== op.from.id ? hs.st : null;
        const g = target
          ? connectorSegment(op.from, target)
          : connectorSegment(op.from, { x: op.cur.x, y: op.cur.y, w: 0, h: 0 });
        drawConnectorSegment(ctx, g, 'end', target ? '#2f5d8a' : 'rgba(47, 93, 138, 0.6)', 3.2);
        if (target) {
          ctx.strokeStyle = '#2f5d8a';
          ctx.lineWidth = 4 / vp.scale;
          ctx.strokeRect(target.x - 4, target.y - 4, target.w + 8, target.h + 8);
        }
        return;
      }
      if (!op.lifted) return;
      const d = this.dragged(op, idx);
      const moved = new Map(d.stickies.map((s) => [s.id, s]));
      for (const f of d.frames) drawFrame(ctx, f, idx.byFrame.get(f.id));
      const look = (id) => moved.get(id) || idx.stickyById.get(id);
      for (const c of idx.connectors) {
        if (!op.lifted.ids.has(c.id)) continue;
        drawConnectorSegment(ctx, connectorSegment(look(c.fromId), look(c.toId)), c.arrow, c.color || '#4a5260');
      }
      for (const s of d.stickies) drawSticky(ctx, s, idx.bySticky.get(s.id));
      // 大きさを変えている途中は、枠線で示す
      if (op.type === 'resize-sticky' || op.type === 'resize-frame') {
        const o = d.stickies[0] || d.frames[0];
        ctx.setLineDash([8 / vp.scale, 6 / vp.scale]);
        ctx.strokeStyle = 'rgba(47, 93, 138, 0.9)';
        ctx.lineWidth = 2 / vp.scale;
        ctx.strokeRect(o.x, o.y, o.w, o.h);
        ctx.setLineDash([]);
      }
    });
  }
}
