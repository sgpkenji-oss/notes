// ページの中身（グループ枠・コネクタ・線・付箋）を描くファイル。
// 下の canvas のタイル（renderer.js）、ページ一覧の縮小表示（pagelist.js）、動かしている途中の重ね描き（objects.js / lasso.js）で同じ描き方を使う。
//
// 重なりの順（下から）：グループ枠（名前の線を含む）→ コネクタ → ページに直接書いた線 → 付箋（中の線を含む）
// 座標はすべてページ座標（ボードページではボード座標）。付箋・枠の中の線は、付箋・枠の左上からの相対位置で持つ。
import { STICKY_BAND, FRAME_BAND } from './model.js';
import { drawStroke, strokeGeometry, boundsIntersect } from './geometry.js';

export const STICKY_COLORS = [
  { key: 'yellow', label: '黄', fill: '#fff3a6', band: '#f1dc6a', edge: '#e2c94c' },
  { key: 'pink', label: '桃', fill: '#ffd8e4', band: '#f4adc3', edge: '#e693ad' },
  { key: 'blue', label: '青', fill: '#d4e8ff', band: '#a6caf3', edge: '#86b1e4' },
  { key: 'green', label: '緑', fill: '#d9f3cf', band: '#acdb9c', edge: '#8ec67c' },
  { key: 'orange', label: '橙', fill: '#ffe1bf', band: '#f5bd82', edge: '#e6a361' },
];

export const FRAME_COLORS = [
  { key: 'gray', label: '灰', fill: 'rgba(110, 120, 135, 0.07)', band: 'rgba(110, 120, 135, 0.14)', line: '#8d96a3', pen: '#5b6470' },
  { key: 'blue', label: '青', fill: 'rgba(60, 120, 210, 0.07)', band: 'rgba(60, 120, 210, 0.14)', line: '#6f9ad6', pen: '#2f5d8a' },
  { key: 'green', label: '緑', fill: 'rgba(60, 160, 90, 0.07)', band: 'rgba(60, 160, 90, 0.15)', line: '#74b585', pen: '#2e6e40' },
  { key: 'red', label: '赤', fill: 'rgba(215, 70, 70, 0.06)', band: 'rgba(215, 70, 70, 0.13)', line: '#d98a8a', pen: '#9c3434' },
  { key: 'yellow', label: '黄', fill: 'rgba(225, 175, 0, 0.08)', band: 'rgba(225, 175, 0, 0.17)', line: '#d6b54a', pen: '#7d6200' },
];

export const BOARD_BACKGROUND = '#f7f7f4';
const BOARD_DOT = '#d9dbd6';
const BOARD_DOT_SPACING = 40;

export function stickyColor(key) {
  return STICKY_COLORS.find((c) => c.key === key) || STICKY_COLORS[0];
}
export function frameColor(key) {
  return FRAME_COLORS.find((c) => c.key === key) || FRAME_COLORS[0];
}

export function rectOf(o) {
  return { minX: o.x, minY: o.y, maxX: o.x + o.w, maxY: o.y + o.h };
}

export function unionBounds(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) };
}

export function padBounds(b, p) {
  return b && { minX: b.minX - p, minY: b.minY - p, maxX: b.maxX + p, maxY: b.maxY + p };
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// ---- 付箋 ----

// 付箋が描かれる範囲（影を含む）
export function stickyBounds(st) {
  return { minX: st.x - 1, minY: st.y - 1, maxX: st.x + st.w + 5, maxY: st.y + st.h + 6 };
}

export function drawSticky(ctx, st, strokes) {
  const c = stickyColor(st.color);
  const { x, y, w, h } = st;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  // 影（ぼかしは重いので、ずらした四角で表す）
  ctx.fillStyle = 'rgba(0, 0, 0, 0.07)';
  roundRectPath(ctx, x + 2, y + 3, w + 2, h + 2, 5);
  ctx.fill();
  ctx.fillStyle = c.fill;
  roundRectPath(ctx, x, y, w, h, 4);
  ctx.fill();
  ctx.save();
  ctx.clip();
  // 上の帯（つまんで動かす所）
  ctx.fillStyle = c.band;
  ctx.fillRect(x, y, w, STICKY_BAND);
  // 帯のつまみ（3本線）
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.22)';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  const cx = x + w / 2, cy = y + STICKY_BAND / 2;
  for (const dy of [-5, 0, 5]) {
    ctx.moveTo(cx - 14, cy + dy);
    ctx.lineTo(cx + 14, cy + dy);
  }
  ctx.stroke();
  // 右下の角（大きさを変える所）
  ctx.fillStyle = c.edge;
  ctx.beginPath();
  ctx.moveTo(x + w, y + h - 22);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + w - 22, y + h);
  ctx.closePath();
  ctx.fill();
  // 中の線
  if (strokes && strokes.length) {
    ctx.translate(x, y);
    for (const s of strokes) drawStroke(ctx, s, strokeGeometry(s));
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.10)';
  ctx.lineWidth = 1;
  roundRectPath(ctx, x, y, w, h, 4);
  ctx.stroke();
  ctx.restore();
}

// ---- グループ枠 ----

export function frameBounds(f) {
  return { minX: f.x - 3, minY: f.y - 3, maxX: f.x + f.w + 3, maxY: f.y + f.h + 3 };
}

export function drawFrame(ctx, f, strokes) {
  const c = frameColor(f.color);
  const { x, y, w, h } = f;
  const band = Math.min(FRAME_BAND, h);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  roundRectPath(ctx, x, y, w, h, 14);
  ctx.fillStyle = c.fill;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = c.band;
  ctx.fillRect(x, y, w, band);
  if (strokes && strokes.length) {
    ctx.translate(x, y);
    for (const s of strokes) drawStroke(ctx, s, strokeGeometry(s));
  } else {
    // 名前がまだ無いときの案内
    ctx.fillStyle = 'rgba(40, 45, 55, 0.28)';
    ctx.font = '22px -apple-system, "Hiragino Sans", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('ここに名前を書く', x + 18, y + band / 2);
  }
  ctx.restore();
  // 右下の角（大きさを変える所）
  ctx.strokeStyle = c.line;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x + w - 10, y + h - 26);
  ctx.lineTo(x + w - 10, y + h - 10);
  ctx.lineTo(x + w - 26, y + h - 10);
  ctx.stroke();
  ctx.lineWidth = 2.5;
  roundRectPath(ctx, x, y, w, h, 14);
  ctx.stroke();
  ctx.restore();
}

// ---- コネクタ ----

// 長方形 r の中心から (tx, ty) へ向かう線が、長方形の外周と交わる点
function edgePoint(r, tx, ty, gap) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const hw = r.w / 2 + gap, hh = r.h / 2 + gap;
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return { x: cx + dx * Math.min(1, t), y: cy + dy * Math.min(1, t) };
}

// コネクタの線分（付箋の縁から縁まで）。a, b はつなぐ元・先の付箋
export function connectorSegment(a, b) {
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
  const p = edgePoint(a, bcx, bcy, 4);
  const q = edgePoint(b, acx, acy, 4);
  return { x1: p.x, y1: p.y, x2: q.x, y2: q.y };
}

const ARROW_LEN = 20;
const ARROW_HALF = 9;

export function segmentBounds(g) {
  const pad = ARROW_LEN + 4;
  return { minX: Math.min(g.x1, g.x2) - pad, minY: Math.min(g.y1, g.y2) - pad, maxX: Math.max(g.x1, g.x2) + pad, maxY: Math.max(g.y1, g.y2) + pad };
}

function arrowHead(ctx, fromX, fromY, x, y) {
  const dx = x - fromX, dy = y - fromY;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ux = dx / len, uy = dy / len;
  const bx = x - ux * ARROW_LEN, by = y - uy * ARROW_LEN;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(bx - uy * ARROW_HALF, by + ux * ARROW_HALF);
  ctx.lineTo(bx + uy * ARROW_HALF, by - ux * ARROW_HALF);
  ctx.closePath();
  ctx.fill();
}

// 線分 g（connectorSegment の形）に、arrow（'none' | 'end' | 'both'）の矢印をつけて描く
export function drawConnectorSegment(ctx, g, arrow, color, width = 3.2) {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  const len = Math.hypot(g.x2 - g.x1, g.y2 - g.y1) || 1;
  const ux = (g.x2 - g.x1) / len, uy = (g.y2 - g.y1) / len;
  // 矢印の先が線の端で太って見えないよう、矢印のある側は線を少し短くする
  const s0 = arrow === 'both' ? ARROW_LEN * 0.6 : 0;
  const s1 = arrow === 'end' || arrow === 'both' ? ARROW_LEN * 0.6 : 0;
  if (len > s0 + s1) {
    ctx.beginPath();
    ctx.moveTo(g.x1 + ux * s0, g.y1 + uy * s0);
    ctx.lineTo(g.x2 - ux * s1, g.y2 - uy * s1);
    ctx.stroke();
  }
  if (arrow === 'end' || arrow === 'both') arrowHead(ctx, g.x1, g.y1, g.x2, g.y2);
  if (arrow === 'both') arrowHead(ctx, g.x2, g.y2, g.x1, g.y1);
  ctx.restore();
}

export function drawConnector(ctx, c, a, b) {
  drawConnectorSegment(ctx, connectorSegment(a, b), c.arrow, c.color || '#4a5260');
}

// 点 (px, py) から線分までの距離
export function distToSegment(px, py, g) {
  const dx = g.x2 - g.x1, dy = g.y2 - g.y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - g.x1) * dx + (py - g.y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (g.x1 + dx * t), py - (g.y1 + dy * t));
}

// ---- ページ全体 ----

// idx：notebook.buildIndex の形。rect：描く範囲（ページ座標。null なら全部）。hidden：描かない物のIDの集まり
export function drawScene(ctx, idx, rect, hidden) {
  const skip = (o) => hidden && hidden.size && hidden.has(o.id);
  const meets = (b) => !rect || boundsIntersect(b, rect);
  for (const f of idx.frames) {
    if (skip(f) || !meets(frameBounds(f))) continue;
    drawFrame(ctx, f, idx.byFrame.get(f.id));
  }
  for (const c of idx.connectors) {
    if (skip(c)) continue;
    const a = idx.stickyById.get(c.fromId), b = idx.stickyById.get(c.toId);
    if (skip(a) || skip(b)) continue;
    const g = connectorSegment(a, b);
    if (!meets(segmentBounds(g))) continue;
    drawConnectorSegment(ctx, g, c.arrow, c.color || '#4a5260');
  }
  for (const s of idx.free) {
    if (skip(s)) continue;
    const g = strokeGeometry(s);
    if (meets(g.bounds)) drawStroke(ctx, s, g);
  }
  for (const st of idx.stickies) {
    if (skip(st) || !meets(stickyBounds(st))) continue;
    drawSticky(ctx, st, idx.bySticky.get(st.id));
  }
}

// ページの中身全体の外枠（何も無ければ null）。ボードページの縮小表示に使う
export function contentBounds(idx) {
  let b = null;
  for (const f of idx.frames) b = unionBounds(b, rectOf(f));
  for (const st of idx.stickies) b = unionBounds(b, rectOf(st));
  for (const s of idx.free) b = unionBounds(b, strokeGeometry(s).bounds);
  return b;
}

// ボードページの背景（うすい点）。rect はページ座標の描く範囲、s は 1単位あたりのデバイスピクセル数
export function drawBoardBackground(ctx, rect, s) {
  ctx.fillStyle = BOARD_BACKGROUND;
  ctx.fillRect(rect.minX, rect.minY, rect.maxX - rect.minX, rect.maxY - rect.minY);
  let step = BOARD_DOT_SPACING;
  while (step * s < 14) step *= 2; // 縮小したときに点が詰まりすぎないように
  const r = 1.4 / s; // 画面上でおよそ1.4ピクセルの点
  ctx.fillStyle = BOARD_DOT;
  const x0 = Math.ceil(rect.minX / step) * step, y0 = Math.ceil(rect.minY / step) * step;
  ctx.beginPath();
  for (let y = y0; y <= rect.maxY; y += step) {
    for (let x = x0; x <= rect.maxX; x += step) {
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
  }
  ctx.fill();
}
