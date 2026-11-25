// ノートページの紙（無地・罫線・方眼）を描く。
import { PAGE_WIDTH, PAGE_HEIGHT } from './model.js';

const RULE_SPACING = 34;   // 罫線の間隔（約7mm）
const RULE_TOP = 102;      // 1本目の罫線の位置
const RULE_COLOR = '#c4d4e7';
const GRID_SPACING = 24;   // 方眼の間隔（約5mm）
const GRID_COLOR = '#dde3eb';

// rect はページ座標の描く範囲、s は 1単位あたりの画面ピクセル数（ctx はすでに s 倍されている）
export function drawPaper(ctx, paper, rect, s) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(rect.minX, rect.minY, rect.maxX - rect.minX, rect.maxY - rect.minY);
  if (paper !== 'ruled' && paper !== 'grid') return;

  const px = Math.max(1, Math.round(s * 0.8)); // 線の太さ（画面ピクセル）
  const lw = px / s;
  const snap = (v) => (Math.floor(v * s) + px / 2) / s; // 線をピクセルにそろえてにじませない
  ctx.lineWidth = lw;
  ctx.beginPath();
  if (paper === 'ruled') {
    ctx.strokeStyle = RULE_COLOR;
    for (let y = RULE_TOP; y <= PAGE_HEIGHT - RULE_SPACING; y += RULE_SPACING) {
      if (y < rect.minY - lw || y > rect.maxY + lw) continue;
      const yy = snap(y);
      ctx.moveTo(rect.minX, yy);
      ctx.lineTo(rect.maxX, yy);
    }
  } else {
    ctx.strokeStyle = GRID_COLOR;
    const ox = (PAGE_WIDTH % GRID_SPACING) / 2;
    const oy = (PAGE_HEIGHT % GRID_SPACING) / 2;
    for (let x = ox; x <= PAGE_WIDTH; x += GRID_SPACING) {
      if (x < rect.minX - lw || x > rect.maxX + lw) continue;
      const xx = snap(x);
      ctx.moveTo(xx, rect.minY);
      ctx.lineTo(xx, rect.maxY);
    }
    for (let y = oy; y <= PAGE_HEIGHT; y += GRID_SPACING) {
      if (y < rect.minY - lw || y > rect.maxY + lw) continue;
      const yy = snap(y);
      ctx.moveTo(rect.minX, yy);
      ctx.lineTo(rect.maxX, yy);
    }
  }
  ctx.stroke();
}
