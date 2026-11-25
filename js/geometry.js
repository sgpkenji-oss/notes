// 線の形を作るファイル。
// 点と点の間は「中点を使う2次ベジェ曲線」でなめらかにつなぐ。
// ペンは筆圧で太さが変わるので、線のまわりの輪郭（塗りつぶす形）を作って描く。
// マーカーは同じ太さなので、中心線をそのままなぞって描く。

export const MARKER_ALPHA = 0.4;
const SAMPLE_STEP = 1; // 曲線を細かく区切る間隔（ページ座標の単位）

// 筆圧（0〜1）→ 太さの倍率
export function pressureFactor(p) {
  return 0.3 + 1.4 * Math.min(1, Math.max(0, p));
}

// 線の形（Path2D と外枠）を、線のデータごとに一度だけ作って覚えておく
const cache = new WeakMap();

export function strokeGeometry(stroke) {
  let g = cache.get(stroke);
  if (!g) {
    g = buildGeometry(stroke);
    cache.set(stroke, g);
  }
  return g;
}

// 書いている途中の線は点が増え続けるので、覚えずに毎回作る
export function buildGeometry(stroke) {
  const pts = stroke.points;
  if (stroke.tool === 'marker') {
    return { path: markerPath(pts), bounds: pointsBounds(pts, stroke.width / 2) };
  }
  const samples = sampleCenterline(pts, (p) => stroke.width * pressureFactor(p));
  return penOutline(samples);
}

export function drawStroke(ctx, stroke, geo = strokeGeometry(stroke)) {
  if (stroke.tool === 'marker') {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = MARKER_ALPHA;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(geo.path);
    ctx.restore();
  } else {
    ctx.fillStyle = stroke.color;
    ctx.fill(geo.path);
  }
}

// 中心線を細かい点の並び [x, y, 太さ, ...] にする（中点を使う2次ベジェ曲線）
function sampleCenterline(pts, widthOf) {
  const n = pts.length / 3;
  const out = [];
  if (n === 0) return out;
  const X = (i) => pts[i * 3];
  const Y = (i) => pts[i * 3 + 1];
  const W = (i) => widthOf(pts[i * 3 + 2]);
  out.push(X(0), Y(0), W(0));
  if (n === 1) return out;

  let sx = X(0), sy = Y(0), sw = W(0);
  for (let i = 1; i < n - 1; i++) {
    const cx = X(i), cy = Y(i), cw = W(i);
    const ex = (cx + X(i + 1)) / 2, ey = (cy + Y(i + 1)) / 2, ew = (cw + W(i + 1)) / 2;
    const len = Math.hypot(cx - sx, cy - sy) + Math.hypot(ex - cx, ey - cy);
    const steps = Math.min(24, Math.max(1, Math.ceil(len / SAMPLE_STEP)));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
      out.push(a * sx + b * cx + c * ex, a * sy + b * cy + c * ey, a * sw + b * cw + c * ew);
    }
    sx = ex; sy = ey; sw = ew;
  }
  // 最後の点までは直線
  const lx = X(n - 1), ly = Y(n - 1), lw = W(n - 1);
  const steps = Math.min(24, Math.max(1, Math.ceil(Math.hypot(lx - sx, ly - sy) / SAMPLE_STEP)));
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    out.push(sx + (lx - sx) * t, sy + (ly - sy) * t, sw + (lw - sw) * t);
  }
  return out;
}

// ペンの輪郭。左側を行き、右側を戻る多角形＋両端と急な曲がり角に円。
// 円は多角形と同じ向き（反時計回り）で描くので、重なっても穴があかない（nonzero で塗る）。
function penOutline(samples) {
  const xs = [], ys = [], rs = [];
  for (let i = 0; i < samples.length; i += 3) {
    const x = samples[i], y = samples[i + 1], r = samples[i + 2] / 2;
    const m = xs.length - 1;
    if (m >= 0 && Math.hypot(x - xs[m], y - ys[m]) < 0.05) {
      rs[m] = Math.max(rs[m], r);
      continue;
    }
    xs.push(x); ys.push(y); rs.push(r);
  }
  const n = xs.length;
  const path = new Path2D();
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let i = 0; i < n; i++) {
    bounds.minX = Math.min(bounds.minX, xs[i] - rs[i]);
    bounds.minY = Math.min(bounds.minY, ys[i] - rs[i]);
    bounds.maxX = Math.max(bounds.maxX, xs[i] + rs[i]);
    bounds.maxY = Math.max(bounds.maxY, ys[i] + rs[i]);
  }
  const circle = (i) => {
    path.moveTo(xs[i] + rs[i], ys[i]);
    path.arc(xs[i], ys[i], rs[i], 0, Math.PI * 2, true);
  };
  if (n === 0) return { path, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };
  if (n === 1) {
    circle(0);
    return { path, bounds };
  }

  const nx = new Float64Array(n), ny = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    const tx = xs[b] - xs[a], ty = ys[b] - ys[a];
    const len = Math.hypot(tx, ty) || 1;
    nx[i] = -ty / len;
    ny[i] = tx / len;
  }
  path.moveTo(xs[0] + nx[0] * rs[0], ys[0] + ny[0] * rs[0]);
  for (let i = 1; i < n; i++) path.lineTo(xs[i] + nx[i] * rs[i], ys[i] + ny[i] * rs[i]);
  for (let i = n - 1; i >= 0; i--) path.lineTo(xs[i] - nx[i] * rs[i], ys[i] - ny[i] * rs[i]);
  path.closePath();
  circle(0);
  circle(n - 1);
  // 急な曲がり角は輪郭が折り返して欠けるので、円で埋める
  for (let i = 1; i < n - 1; i++) {
    const ax = xs[i] - xs[i - 1], ay = ys[i] - ys[i - 1];
    const bx = xs[i + 1] - xs[i], by = ys[i + 1] - ys[i];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    const dot = (ax * bx + ay * by) / (la * lb);
    const angle = Math.acos(Math.min(1, Math.max(-1, dot)));
    if (angle * rs[i] > Math.min(la, lb) * 0.5) circle(i);
  }
  return { path, bounds };
}

function markerPath(pts) {
  const n = pts.length / 3;
  const path = new Path2D();
  if (n === 0) return path;
  path.moveTo(pts[0], pts[1]);
  if (n === 1) {
    path.lineTo(pts[0] + 0.01, pts[1]); // 1点だけのときも丸い点が出るように
    return path;
  }
  for (let i = 1; i < n - 1; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1];
    path.quadraticCurveTo(x, y, (x + pts[i * 3 + 3]) / 2, (y + pts[i * 3 + 4]) / 2);
  }
  path.lineTo(pts[(n - 1) * 3], pts[(n - 1) * 3 + 1]);
  return path;
}

function pointsBounds(pts, pad) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    minX = Math.min(minX, pts[i]); maxX = Math.max(maxX, pts[i]);
    minY = Math.min(minY, pts[i + 1]); maxY = Math.max(maxY, pts[i + 1]);
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

export function boundsIntersect(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

// 消しゴム：線分 a→b（半径 r）が線に触れたか
export function hitStroke(stroke, ax, ay, bx, by, r) {
  const bb = strokeGeometry(stroke).bounds;
  if (Math.max(ax, bx) + r < bb.minX || Math.min(ax, bx) - r > bb.maxX ||
      Math.max(ay, by) + r < bb.minY || Math.min(ay, by) - r > bb.maxY) return false;
  const p = stroke.points;
  const n = p.length / 3;
  const half = (i) => (stroke.tool === 'marker' ? stroke.width : stroke.width * pressureFactor(p[i * 3 + 2])) / 2;
  if (n === 1) return pointSegDist(p[0], p[1], ax, ay, bx, by) <= r + half(0);
  for (let i = 0; i < n - 1; i++) {
    const d = segSegDist(p[i * 3], p[i * 3 + 1], p[i * 3 + 3], p[i * 3 + 4], ax, ay, bx, by);
    if (d <= r + Math.max(half(i), half(i + 1))) return true;
  }
  return false;
}

function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function segSegDist(ax, ay, bx, by, cx, cy, dx, dy) {
  const cross = (ux, uy, vx, vy) => ux * vy - uy * vx;
  const d1 = cross(bx - ax, by - ay, cx - ax, cy - ay);
  const d2 = cross(bx - ax, by - ay, dx - ax, dy - ay);
  const d3 = cross(dx - cx, dy - cy, ax - cx, ay - cy);
  const d4 = cross(dx - cx, dy - cy, bx - cx, by - cy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(
    pointSegDist(ax, ay, cx, cy, dx, dy),
    pointSegDist(bx, by, cx, cy, dx, dy),
    pointSegDist(cx, cy, ax, ay, bx, by),
    pointSegDist(dx, dy, ax, ay, bx, by),
  );
}
