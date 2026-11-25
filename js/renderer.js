// 下の canvas（確定した線・付箋・コネクタ・枠）を描く。
// 表示中のページだけを描く。ページは 512px 四方の「タイル」に分けて絵を覚えておき、
// スクロールのときは覚えた絵を貼るだけにして、再描画を軽くする（付箋がたくさんあっても、スクロール中は描き直さない）。
// 拡大縮小の途中は覚えた絵を伸び縮みさせて貼り、指を離してから新しい大きさで描き直す。
//
// タイルの種類
//   note    ：ノートページ（紙＋中身）
//   preview ：ノートページの並びの中に出す、ボードページの縮小表示（タップで開く）
//   board   ：ボードページを開いているとき。広さに上限がないので、タイルの番号はマイナスにもなる
import { PAGE_WIDTH, PAGE_HEIGHT } from './model.js';
import { drawPaper } from './paper.js';
import { drawStroke, strokeGeometry, boundsIntersect } from './geometry.js';
import { drawScene, contentBounds, drawBoardBackground, stickyBounds, BOARD_BACKGROUND } from './scene.js';

const TILE = 512;
const MAX_TILES = 64;        // 覚えておくタイルの数（1枚 約1MB）
const POOL_MAX = 16;
const BUDGET_MS = 10;        // 1回の描画でタイルを作ってよい時間
const BACKGROUND = '#e6e7ea';
const PAGE_EDGE = '#cdd1d7';

class TileLayer {
  constructor(scale) {
    this.scale = scale; // 1単位あたりのデバイスピクセル数
    this.tiles = new Map();
  }
  key(pageId, tx, ty, mode) {
    return mode === 'board' ? `${pageId}:b:${tx}:${ty}` : `${pageId}:${tx}:${ty}`;
  }
  cols() {
    return Math.ceil((PAGE_WIDTH * this.scale) / TILE);
  }
  rows() {
    return Math.ceil((PAGE_HEIGHT * this.scale) / TILE);
  }
  unitsRect(tx, ty, board = false) {
    const s = this.scale;
    return {
      minX: (tx * TILE) / s,
      minY: (ty * TILE) / s,
      maxX: board ? ((tx + 1) * TILE) / s : Math.min(PAGE_WIDTH, ((tx + 1) * TILE) / s),
      maxY: board ? ((ty + 1) * TILE) / s : Math.min(PAGE_HEIGHT, ((ty + 1) * TILE) / s),
    };
  }
}

function intersectRect(a, b) {
  return { minX: Math.max(a.minX, b.minX), minY: Math.max(a.minY, b.minY), maxX: Math.min(a.maxX, b.maxX), maxY: Math.min(a.maxY, b.maxY) };
}

export class Renderer {
  constructor(canvas, viewport, notebook) {
    this.canvas = canvas;
    this.vp = viewport;
    this.nb = notebook;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.layer = null;     // いまの大きさのタイル
    this.oldLayer = null;  // 拡大率を変えた直後、描き直しが終わるまで代わりに使う
    this.pool = [];
    this.frame = 0;
    this.scheduled = false;
    this.interacting = false; // 指で操作中（拡大率が変わっている途中）
    this.hidden = new Set();  // 持ち上げて動かしている線・付箋などのID（下の絵には描かない）
  }

  // ノートを切り替えたとき、覚えていた絵をすべて捨てる
  reset() {
    this.clearTiles();
    this.hidden = new Set();
  }

  // ノートページの並び ⇔ ボードページを切り替えたとき
  clearTiles() {
    this.dropLayer(this.layer);
    this.dropLayer(this.oldLayer);
    this.layer = null;
    this.oldLayer = null;
  }

  resize() {
    const vp = this.vp;
    this.canvas.width = Math.round(vp.width * vp.dpr);
    this.canvas.height = Math.round(vp.height * vp.dpr);
    this.render();
  }

  setInteracting(on) {
    this.interacting = on;
    if (!on) this.requestRender();
  }

  requestRender() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.render();
    });
  }

  render() {
    const vp = this.vp, ctx = this.ctx;
    const S = vp.deviceScale;
    if (!this.layer) {
      this.layer = new TileLayer(S);
    } else if (!this.interacting && Math.abs(this.layer.scale - S) > 1e-9) {
      this.dropLayer(this.oldLayer);
      this.oldLayer = this.layer;
      this.layer = new TileLayer(S);
    }
    this.frame++;
    this.renderedThisFrame = 0;
    const deadline = performance.now() + BUDGET_MS;
    let complete = true;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    if (vp.board >= 0) {
      // ボードページ：画面いっぱいがボード
      ctx.fillStyle = BOARD_BACKGROUND;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      const page = this.nb.pages[vp.board];
      if (page) {
        const loaded = this.nb.isLoaded(page.id);
        if (!loaded) this.nb.ensureLoaded(page.id);
        if (!this.drawPage(page, vp.ox * vp.dpr, vp.oy * vp.dpr, S, deadline, loaded, 'board')) complete = false;
      }
    } else {
      ctx.fillStyle = BACKGROUND;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      const [first, last] = vp.visiblePageRange();
      for (let i = first; i <= last; i++) {
        const page = this.nb.pages[i];
        if (!page) continue;
        const X0 = vp.ox * vp.dpr;
        const Y0 = (vp.oy + vp.pageTop(i) * vp.scale) * vp.dpr;
        const x0 = Math.round(X0), y0 = Math.round(Y0);
        const x1 = Math.round(X0 + PAGE_WIDTH * S), y1 = Math.round(Y0 + PAGE_HEIGHT * S);
        const mode = page.kind === 'board' ? 'preview' : 'note';
        ctx.fillStyle = PAGE_EDGE;
        ctx.fillRect(x0 - 1, y0 - 1, x1 - x0 + 2, y1 - y0 + 2);
        ctx.fillStyle = mode === 'preview' ? BOARD_BACKGROUND : '#ffffff';
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

        const loaded = this.nb.isLoaded(page.id);
        if (!loaded) this.nb.ensureLoaded(page.id); // 読み込めたら invalidatePage → 再描画
        if (!this.drawPage(page, X0, Y0, S, deadline, loaded, mode)) complete = false;
      }
    }
    this.evict();
    if (!complete) {
      this.requestRender();
    } else if (this.oldLayer && !this.interacting) {
      this.dropLayer(this.oldLayer);
      this.oldLayer = null;
    }
  }

  // 1ページ分のタイルを貼る。足りないタイルが残ったら false
  drawPage(page, X0, Y0, S, deadline, canRender, mode) {
    const layer = this.layer;
    const board = mode === 'board';
    const k = S / layer.scale;
    const cw = this.canvas.width, ch = this.canvas.height;
    const vx0 = board ? 0 : Math.max(0, X0), vy0 = board ? 0 : Math.max(0, Y0);
    const vx1 = board ? cw : Math.min(cw, X0 + PAGE_WIDTH * S), vy1 = board ? ch : Math.min(ch, Y0 + PAGE_HEIGHT * S);
    if (vx1 <= vx0 || vy1 <= vy0) return true;
    let tx0 = Math.floor((vx0 - X0) / k / TILE), tx1 = Math.floor((vx1 - X0) / k / TILE);
    let ty0 = Math.floor((vy0 - Y0) / k / TILE), ty1 = Math.floor((vy1 - Y0) / k / TILE);
    if (!board) {
      tx0 = Math.max(0, tx0); ty0 = Math.max(0, ty0);
      tx1 = Math.min(layer.cols() - 1, tx1); ty1 = Math.min(layer.rows() - 1, ty1);
    }
    // 縮小の途中で細かいタイルを大量に作るとメモリが足りなくなるので作らない
    const allowRender = canRender && k > 0.6;

    const ready = [];
    let missing = false;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        let t = layer.tiles.get(layer.key(page.id, tx, ty, mode));
        if (!t && allowRender && (this.renderedThisFrame === 0 || performance.now() < deadline)) {
          t = this.renderTile(layer, page, tx, ty, mode);
          this.renderedThisFrame++;
        }
        if (t) {
          t.used = this.frame;
          ready.push(t);
        } else {
          missing = true;
        }
      }
    }
    if (missing && this.oldLayer) {
      for (const t of this.oldLayer.tiles.values()) {
        if (t.pageId === page.id && t.mode === mode) this.blit(t, X0, Y0, S / this.oldLayer.scale);
      }
    }
    for (const t of ready) this.blit(t, X0, Y0, k);
    // 描けなかった理由が「読み込み中」や「縮小の途中」なら、読み込み後・指を離した後に描き直すので、ここでは続けない
    return !missing || !allowRender;
  }

  blit(t, X0, Y0, k) {
    const dx0 = Math.round(X0 + t.tx * TILE * k);
    const dy0 = Math.round(Y0 + t.ty * TILE * k);
    const dx1 = Math.round(X0 + (t.tx * TILE + t.w) * k);
    const dy1 = Math.round(Y0 + (t.ty * TILE + t.h) * k);
    this.ctx.drawImage(t.canvas, 0, 0, t.w, t.h, dx0, dy0, dx1 - dx0, dy1 - dy0);
  }

  // タイルを描く。reuse を渡すと、そのタイルの clip の範囲（ページ座標）だけを描き直す
  renderTile(layer, page, tx, ty, mode, reuse = null, clip = null) {
    const canvas = reuse ? reuse.canvas : this.pool.pop() || this.newCanvas();
    const ctx = canvas.getContext('2d');
    const s = layer.scale;
    const board = mode === 'board';
    let r = layer.unitsRect(tx, ty, board);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (!reuse) {
      ctx.fillStyle = mode === 'note' ? '#ffffff' : BOARD_BACKGROUND;
      ctx.fillRect(0, 0, TILE, TILE);
    }
    ctx.setTransform(s, 0, 0, s, -tx * TILE, -ty * TILE);
    if (clip) {
      r = intersectRect(r, { minX: clip.minX - 1, minY: clip.minY - 1, maxX: clip.maxX + 1, maxY: clip.maxY + 1 });
      ctx.beginPath();
      ctx.rect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
      ctx.clip();
    }
    const idx = this.nb.index(page.id);
    if (mode === 'note') {
      drawPaper(ctx, page.paper, r, s);
      if (idx) drawScene(ctx, idx, r, this.hidden);
    } else if (mode === 'board') {
      drawBoardBackground(ctx, r, s);
      if (idx) drawScene(ctx, idx, r, this.hidden);
    } else {
      this.drawPreview(ctx, idx, r);
    }
    ctx.restore();
    if (reuse) return reuse;
    const t = {
      canvas, pageId: page.id, tx, ty, mode,
      w: board ? TILE : Math.min(TILE, Math.ceil(PAGE_WIDTH * s) - tx * TILE),
      h: board ? TILE : Math.min(TILE, Math.ceil(PAGE_HEIGHT * s) - ty * TILE),
      used: this.frame,
    };
    layer.tiles.set(layer.key(page.id, tx, ty, mode), t);
    return t;
  }

  // ノートページの並びの中のボードページ：中身全体を縮めて見せ、「タップで開く」と書く
  drawPreview(ctx, idx, r) {
    ctx.fillStyle = BOARD_BACKGROUND;
    ctx.fillRect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
    ctx.fillStyle = '#4a5260';
    ctx.font = '600 40px -apple-system, "Hiragino Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ボードページ', PAGE_WIDTH / 2, 70);
    ctx.fillStyle = '#7b828d';
    ctx.font = '28px -apple-system, "Hiragino Sans", sans-serif';
    ctx.fillText('タップすると開きます（2本指で上下左右に動かせます）', PAGE_WIDTH / 2, 122);
    ctx.textAlign = 'start';
    if (!idx) return;
    const cb = contentBounds(idx);
    if (!cb) return;
    const area = { x: 50, y: 170, w: PAGE_WIDTH - 100, h: PAGE_HEIGHT - 220 };
    const cw = Math.max(1, cb.maxX - cb.minX), chh = Math.max(1, cb.maxY - cb.minY);
    const f = Math.min(area.w / cw, area.h / chh, 1);
    const ox = area.x + (area.w - cw * f) / 2 - cb.minX * f;
    const oy = area.y + (area.h - chh * f) / 2 - cb.minY * f;
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.x - 20, area.y - 20, area.w + 40, area.h + 40);
    ctx.clip();
    ctx.transform(f, 0, 0, f, ox, oy);
    drawScene(ctx, idx, { minX: (r.minX - ox) / f, minY: (r.minY - oy) / f, maxX: (r.maxX - ox) / f, maxY: (r.maxY - oy) / f }, null);
    ctx.restore();
  }

  newCanvas() {
    const c = document.createElement('canvas');
    c.width = TILE;
    c.height = TILE;
    c.getContext('2d', { alpha: false });
    return c;
  }

  release(t) {
    if (this.pool.length < POOL_MAX) this.pool.push(t.canvas);
    else { t.canvas.width = 0; t.canvas.height = 0; } // iPadのSafariでメモリをすぐ返すため
  }

  dropLayer(layer) {
    if (!layer) return;
    for (const t of layer.tiles.values()) this.release(t);
    layer.tiles.clear();
  }

  evict() {
    const tiles = this.layer.tiles;
    if (tiles.size <= MAX_TILES) return;
    const old = [...tiles.entries()].filter(([, t]) => t.used < this.frame).sort((a, b) => a[1].used - b[1].used);
    for (const [key, t] of old) {
      if (tiles.size <= MAX_TILES) break;
      this.release(t);
      tiles.delete(key);
    }
  }

  // 線のページ座標での外枠（付箋・枠の中の線は、持ち主の位置を足す）。持ち主が見つからなければ null
  strokeBounds(stroke) {
    const b = strokeGeometry(stroke).bounds;
    if (!stroke.stickyId && !stroke.frameId) return b;
    const idx = this.nb.index(stroke.pageId);
    const owner = idx && (stroke.stickyId ? idx.stickyById.get(stroke.stickyId) : idx.frameById.get(stroke.frameId));
    if (!owner) return null;
    return { minX: b.minX + owner.x, minY: b.minY + owner.y, maxX: b.maxX + owner.x, maxY: b.maxY + owner.y };
  }

  // 書き終えた線を、覚えているタイルに上から描き足す。
  // 付箋の中の線・枠の名前の線・付箋の下にかかる線は、重なりの順を守るためにその範囲を描き直す
  addStroke(stroke) {
    const g = strokeGeometry(stroke);
    const idx = this.nb.index(stroke.pageId);
    if (stroke.stickyId || stroke.frameId || (idx && idx.stickies.some((st) => boundsIntersect(stickyBounds(st), g.bounds)))) {
      this.refresh(stroke.pageId, this.strokeBounds(stroke));
      return;
    }
    for (const layer of [this.layer, this.oldLayer]) {
      if (!layer) continue;
      for (const t of layer.tiles.values()) {
        if (t.pageId !== stroke.pageId || t.mode === 'preview' || !boundsIntersect(g.bounds, layer.unitsRect(t.tx, t.ty, t.mode === 'board'))) continue;
        const ctx = t.canvas.getContext('2d');
        ctx.setTransform(layer.scale, 0, 0, layer.scale, -t.tx * TILE, -t.ty * TILE);
        drawStroke(ctx, stroke, g);
      }
    }
  }

  // 線を消したときなど、その範囲のタイルを捨てて描き直させる
  invalidateStroke(stroke) {
    this.invalidate(stroke.pageId, this.strokeBounds(stroke));
  }

  invalidatePage(pageId) {
    this.invalidate(pageId, null);
  }

  invalidate(pageId, bounds) {
    for (const layer of [this.layer, this.oldLayer]) {
      if (!layer) continue;
      for (const [key, t] of layer.tiles) {
        if (t.pageId !== pageId) continue;
        if (bounds && t.mode !== 'preview' && !boundsIntersect(bounds, layer.unitsRect(t.tx, t.ty, t.mode === 'board'))) continue;
        this.release(t);
        layer.tiles.delete(key);
      }
    }
    this.requestRender();
  }

  // その範囲を、ちらつかないように「いま見えているタイル」はその場で描き直す（見えていないタイルは捨てる）。
  // bounds が null ならページ全体。付箋を動かした・置いた・消したときなどに使う
  refresh(pageId, bounds) {
    const page = this.nb.pages.find((p) => p.id === pageId);
    if (this.layer && page) {
      for (const [key, t] of this.layer.tiles) {
        if (t.pageId !== pageId) continue;
        const board = t.mode === 'board';
        if (bounds && t.mode !== 'preview' && !boundsIntersect(bounds, this.layer.unitsRect(t.tx, t.ty, board))) continue;
        if (t.mode !== 'preview' && t.used === this.frame) {
          this.renderTile(this.layer, page, t.tx, t.ty, t.mode, t, bounds);
        } else {
          this.release(t);
          this.layer.tiles.delete(key);
        }
      }
    }
    if (this.oldLayer) {
      for (const [key, t] of this.oldLayer.tiles) {
        if (t.pageId !== pageId) continue;
        if (bounds && t.mode !== 'preview' && !boundsIntersect(bounds, this.oldLayer.unitsRect(t.tx, t.ty, t.mode === 'board'))) continue;
        this.release(t);
        this.oldLayer.tiles.delete(key);
      }
    }
    this.requestRender();
  }
}
