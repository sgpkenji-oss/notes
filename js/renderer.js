// 下の canvas（確定した線）を描く。
// 表示中のページだけを描く。ページは 512px 四方の「タイル」に分けて絵を覚えておき、
// スクロールのときは覚えた絵を貼るだけにして、再描画を軽くする。
// 拡大縮小の途中は覚えた絵を伸び縮みさせて貼り、指を離してから新しい大きさで描き直す。
import { PAGE_WIDTH, PAGE_HEIGHT } from './model.js';
import { drawPaper } from './paper.js';
import { drawStroke, strokeGeometry, boundsIntersect } from './geometry.js';

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
  key(pageId, tx, ty) {
    return `${pageId}:${tx}:${ty}`;
  }
  cols() {
    return Math.ceil((PAGE_WIDTH * this.scale) / TILE);
  }
  rows() {
    return Math.ceil((PAGE_HEIGHT * this.scale) / TILE);
  }
  unitsRect(tx, ty) {
    const s = this.scale;
    return {
      minX: (tx * TILE) / s,
      minY: (ty * TILE) / s,
      maxX: Math.min(PAGE_WIDTH, ((tx + 1) * TILE) / s),
      maxY: Math.min(PAGE_HEIGHT, ((ty + 1) * TILE) / s),
    };
  }
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
    this.hidden = new Set();  // なげなわで持ち上げている線のID（下の絵には描かない）
  }

  // ノートを切り替えたとき、覚えていた絵をすべて捨てる
  reset() {
    this.dropLayer(this.layer);
    this.dropLayer(this.oldLayer);
    this.layer = null;
    this.oldLayer = null;
    this.hidden = new Set();
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
      ctx.fillStyle = PAGE_EDGE;
      ctx.fillRect(x0 - 1, y0 - 1, x1 - x0 + 2, y1 - y0 + 2);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

      const loaded = this.nb.isLoaded(page.id);
      if (!loaded) this.nb.ensureLoaded(page.id); // 読み込めたら invalidatePage → 再描画
      if (!this.drawPage(page, X0, Y0, S, deadline, loaded)) complete = false;
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
  drawPage(page, X0, Y0, S, deadline, canRender) {
    const layer = this.layer;
    const k = S / layer.scale;
    const cw = this.canvas.width, ch = this.canvas.height;
    const vx0 = Math.max(0, X0), vy0 = Math.max(0, Y0);
    const vx1 = Math.min(cw, X0 + PAGE_WIDTH * S), vy1 = Math.min(ch, Y0 + PAGE_HEIGHT * S);
    if (vx1 <= vx0 || vy1 <= vy0) return true;
    const tx0 = Math.max(0, Math.floor((vx0 - X0) / k / TILE));
    const tx1 = Math.min(layer.cols() - 1, Math.floor((vx1 - X0) / k / TILE));
    const ty0 = Math.max(0, Math.floor((vy0 - Y0) / k / TILE));
    const ty1 = Math.min(layer.rows() - 1, Math.floor((vy1 - Y0) / k / TILE));
    // 縮小の途中で細かいタイルを大量に作るとメモリが足りなくなるので作らない
    const allowRender = canRender && k > 0.6;

    const ready = [];
    let missing = false;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        let t = layer.tiles.get(layer.key(page.id, tx, ty));
        if (!t && allowRender && (this.renderedThisFrame === 0 || performance.now() < deadline)) {
          t = this.renderTile(layer, page, tx, ty);
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
        if (t.pageId === page.id) this.blit(t, X0, Y0, S / this.oldLayer.scale);
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

  renderTile(layer, page, tx, ty) {
    const canvas = this.pool.pop() || this.newCanvas();
    const ctx = canvas.getContext('2d');
    const s = layer.scale;
    const r = layer.unitsRect(tx, ty);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, TILE, TILE);
    ctx.setTransform(s, 0, 0, s, -tx * TILE, -ty * TILE);
    drawPaper(ctx, page.paper, r, s);
    const strokes = this.nb.strokes(page.id) || [];
    for (const stroke of strokes) {
      if (this.hidden.size && this.hidden.has(stroke.id)) continue;
      const g = strokeGeometry(stroke);
      if (boundsIntersect(g.bounds, r)) drawStroke(ctx, stroke, g);
    }
    const t = {
      canvas, pageId: page.id, tx, ty,
      w: Math.min(TILE, Math.ceil(PAGE_WIDTH * s) - tx * TILE),
      h: Math.min(TILE, Math.ceil(PAGE_HEIGHT * s) - ty * TILE),
      used: this.frame,
    };
    layer.tiles.set(layer.key(page.id, tx, ty), t);
    return t;
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

  // 書き終えた線を、覚えているタイルに上から描き足す
  addStroke(stroke) {
    const g = strokeGeometry(stroke);
    for (const layer of [this.layer, this.oldLayer]) {
      if (!layer) continue;
      for (const t of layer.tiles.values()) {
        if (t.pageId !== stroke.pageId || !boundsIntersect(g.bounds, layer.unitsRect(t.tx, t.ty))) continue;
        const ctx = t.canvas.getContext('2d');
        ctx.setTransform(layer.scale, 0, 0, layer.scale, -t.tx * TILE, -t.ty * TILE);
        drawStroke(ctx, stroke, g);
      }
    }
  }

  // 線を消したときなど、その範囲のタイルを捨てて描き直させる
  invalidateStroke(stroke) {
    this.invalidate(stroke.pageId, strokeGeometry(stroke).bounds);
  }

  invalidatePage(pageId) {
    this.invalidate(pageId, null);
  }

  invalidate(pageId, bounds) {
    for (const layer of [this.layer, this.oldLayer]) {
      if (!layer) continue;
      for (const [key, t] of layer.tiles) {
        if (t.pageId !== pageId) continue;
        if (bounds && !boundsIntersect(bounds, layer.unitsRect(t.tx, t.ty))) continue;
        this.release(t);
        layer.tiles.delete(key);
      }
    }
    this.requestRender();
  }
}
