// 書いている途中の線を、上に重ねた canvas に描く。
// 書き終えたら線のデータを返し、下の canvas（renderer.js）に確定してから、ここを消す。
import { createStroke } from './model.js';
import { buildGeometry, drawStroke } from './geometry.js';

const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;

export class Ink {
  constructor(canvas, viewport) {
    this.canvas = canvas;
    this.vp = viewport;
    this.ctx = canvas.getContext('2d', { desynchronized: true });
    this.stroke = null;
    this.pageIndex = -1;
    this.pressure = null;
    this.dirty = null;
  }

  resize() {
    const vp = this.vp;
    this.canvas.width = Math.round(vp.width * vp.dpr);
    this.canvas.height = Math.round(vp.height * vp.dpr);
    this.dirty = null;
  }

  get active() {
    return !!this.stroke;
  }

  begin(pageId, pageIndex, style) {
    this.clear();
    this.stroke = createStroke({ pageId, ...style });
    this.pageIndex = pageIndex;
    this.pressure = null;
    // マーカーは下の線と色が重なって見えるように（確定後の見た目とそろえる）
    this.canvas.style.mixBlendMode = style.tool === 'marker' ? 'multiply' : 'normal';
  }

  // x, y はページ座標、force は touch.force（0〜1）
  add(x, y, force) {
    if (!this.stroke) return;
    const pts = this.stroke.points;
    const f = force > 0 ? force : this.pressure ?? 0.5;
    // 筆圧の急な変化をならす
    this.pressure = this.pressure == null ? f : this.pressure + (f - this.pressure) * 0.5;
    const n = pts.length;
    if (n >= 3) {
      const minMove = 0.25 / this.vp.scale; // 画面上で0.25px未満の動きは無視
      if (Math.hypot(x - pts[n - 3], y - pts[n - 2]) < minMove) {
        pts[n - 1] = round3(Math.max(pts[n - 1], this.pressure));
        return;
      }
    }
    pts.push(round2(x), round2(y), round3(this.pressure));
  }

  // 先読み表示：最後の動きの向きに、少しだけ先まで線を描き足して見せる（保存はしない）
  predicted() {
    const pts = this.stroke.points;
    const n = pts.length;
    if (n < 6) return null;
    let dx = pts[n - 3] - pts[n - 6], dy = pts[n - 2] - pts[n - 5];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return null;
    const max = 14 / this.vp.scale; // 画面上で14pxまで
    const k = Math.min(1, max / len);
    dx *= k;
    dy *= k;
    return [pts[n - 3] + dx, pts[n - 2] + dy, pts[n - 1]];
  }

  draw(predict = false) {
    if (!this.stroke) return;
    const vp = this.vp, ctx = this.ctx;
    this.clearDirty();
    const S = vp.deviceScale;
    // 下の canvas と同じ丸め方で位置を合わせる
    const X0 = Math.round(vp.ox * vp.dpr);
    const Y0 = Math.round((vp.oy + vp.pageTop(this.pageIndex) * vp.scale) * vp.dpr);
    let shown = this.stroke;
    const extra = predict ? this.predicted() : null;
    if (extra) shown = { ...shown, points: shown.points.concat(extra) };
    const g = buildGeometry(shown);
    ctx.setTransform(S, 0, 0, S, X0, Y0);
    drawStroke(ctx, shown, g);
    const b = g.bounds;
    this.dirty = {
      x: Math.floor(X0 + b.minX * S) - 2,
      y: Math.floor(Y0 + b.minY * S) - 2,
      x1: Math.ceil(X0 + b.maxX * S) + 2,
      y1: Math.ceil(Y0 + b.maxY * S) + 2,
    };
  }

  finish() {
    const s = this.stroke;
    this.stroke = null;
    return s && s.points.length ? s : null;
  }

  cancel() {
    this.stroke = null;
    this.clear();
  }

  clearDirty() {
    if (!this.dirty) return;
    const d = this.dirty;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(d.x, d.y, d.x1 - d.x, d.y1 - d.y);
    this.dirty = null;
  }

  clear() {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.dirty = null;
  }

  // 画面全体を使う重ね描き（なげなわの輪・選択の枠など）。fn(ctx, dpr) には画面座標で描ける ctx を渡す
  overlay(fn) {
    const ctx = this.ctx, d = this.vp.dpr;
    this.canvas.style.mixBlendMode = 'normal';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    fn(ctx, d);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.dirty = { x: 0, y: 0, x1: this.canvas.width, y1: this.canvas.height };
  }

  // 消しゴムの位置を丸で示す（sx, sy は画面座標）
  drawEraser(sx, sy, r) {
    this.clearDirty();
    this.canvas.style.mixBlendMode = 'normal';
    const d = this.vp.dpr, ctx = this.ctx;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(60,60,60,0.8)';
    ctx.stroke();
    this.dirty = {
      x: Math.floor((sx - r - 3) * d), y: Math.floor((sy - r - 3) * d),
      x1: Math.ceil((sx + r + 3) * d), y1: Math.ceil((sy + r + 3) * d),
    };
  }
}
