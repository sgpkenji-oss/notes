// 道具（ペン・マーカー・消しゴム）と、色・太さの選択。
// ペンとマーカーは、それぞれ別に色と太さを覚える。

export const TOOLS = [
  { key: 'pen', label: 'ペン' },
  { key: 'marker', label: 'マーカー' },
  { key: 'eraser', label: '消しゴム' },
];

export const COLORS = [
  { key: 'black', label: '黒', pen: '#1d1d1f', marker: '#a0a5ad' },
  { key: 'blue', label: '青', pen: '#1f5fd1', marker: '#7fb3ff' },
  { key: 'red', label: '赤', pen: '#d93025', marker: '#ff8f85' },
  { key: 'yellow', label: '黄', pen: '#e3a800', marker: '#ffe033' },
];

// 太さ（ページ座標の単位。1単位 ≒ 0.21mm）
export const SIZES = [
  { key: 's', label: '細', pen: 2.2, marker: 14 },
  { key: 'm', label: '中', pen: 3.6, marker: 22 },
  { key: 'l', label: '太', pen: 6, marker: 34 },
];

// 消しゴムの大きさ（画面上のCSSピクセル）
export const ERASER_RADIUS = 9;

const DEFAULT_STATE = {
  tool: 'pen',
  pen: { color: 'black', size: 'm' },
  marker: { color: 'yellow', size: 'm' },
};

export class ToolState {
  constructor(saved) {
    const s = saved || {};
    this.tool = TOOLS.some((t) => t.key === s.tool) ? s.tool : DEFAULT_STATE.tool;
    this.pen = { ...DEFAULT_STATE.pen, ...(s.pen || {}) };
    this.marker = { ...DEFAULT_STATE.marker, ...(s.marker || {}) };
    this.onChange = () => {};
  }

  // いまの道具の色・太さ（消しゴムのときは null）
  get options() {
    return this.tool === 'eraser' ? null : this[this.tool];
  }

  setTool(tool) {
    this.tool = tool;
    this.onChange();
  }
  setColor(color) {
    if (this.options) this.options.color = color;
    this.onChange();
  }
  setSize(size) {
    if (this.options) this.options.size = size;
    this.onChange();
  }

  // 線のデータに入れる道具・色・太さ
  strokeStyle() {
    const o = this[this.tool];
    const color = COLORS.find((c) => c.key === o.color) || COLORS[0];
    const size = SIZES.find((z) => z.key === o.size) || SIZES[1];
    return { tool: this.tool, color: color[this.tool], width: size[this.tool] };
  }

  toJSON() {
    return { tool: this.tool, pen: { ...this.pen }, marker: { ...this.marker } };
  }
}
