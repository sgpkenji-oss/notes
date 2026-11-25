// 表示位置（スクロールと拡大率）を持ち、画面の座標とページの座標を変換する。
// ノートページは縦に並べ、続けてスクロールできる。
//
// 座標の呼び方
//   画面座標：ノート表示領域の左上を0とするCSSピクセル
//   文書座標：1ページ目の左上を0とするページ座標（ページを縦に積んだもの）
//   ページ座標：各ページの左上を0とする座標（線のデータはこれで持つ）
//
// ボードページを開いているとき（board に、そのページの番号が入る）は、画面いっぱいにそのページだけを出す。
// このときは「文書座標＝ボード座標（ページ座標）」で、広さの上限はなく、拡大率だけを制限する。
import { PAGE_WIDTH, PAGE_HEIGHT, PAGE_GAP } from './model.js';

export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 5;
export const BOARD_MIN_ZOOM = 0.12;
const SIDE_MARGIN = 16;
export const TOP_MARGIN = 16;
const BOTTOM_MARGIN = 96;
const PITCH = PAGE_HEIGHT + PAGE_GAP;

export class Viewport {
  constructor() {
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.zoom = 1;   // 画面幅に合わせた大きさを1とする
    this.ox = 0;     // 文書座標の原点が画面のどこにあるか（CSSピクセル）
    this.oy = TOP_MARGIN;
    this.pageCount = 1;
    this.board = -1; // 開いているボードページの番号（-1 ならノートページの並びを表示中）
  }

  get minZoom() {
    return this.board >= 0 ? BOARD_MIN_ZOOM : MIN_ZOOM;
  }

  setSize(width, height, dpr) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = dpr;
  }

  // 拡大率1のときの、1単位あたりのCSSピクセル数
  get fitScale() {
    return Math.max(0.05, (this.width - SIDE_MARGIN * 2) / PAGE_WIDTH);
  }
  get scale() {
    return this.fitScale * this.zoom;
  }
  get deviceScale() {
    return this.scale * this.dpr;
  }

  pageTop(index) {
    if (this.board >= 0) return 0;
    return index * PITCH;
  }
  docHeight() {
    return this.pageCount * PAGE_HEIGHT + (this.pageCount - 1) * PAGE_GAP;
  }

  toDoc(sx, sy) {
    const s = this.scale;
    return { x: (sx - this.ox) / s, y: (sy - this.oy) / s };
  }

  // 文書座標の y がどのページの上か（すきまなら -1）
  pageIndexAt(docY) {
    if (this.board >= 0) return this.board;
    const i = Math.floor(docY / PITCH);
    if (i < 0 || i >= this.pageCount) return -1;
    return docY - i * PITCH <= PAGE_HEIGHT ? i : -1;
  }
  nearestPageIndex(docY) {
    if (this.board >= 0) return this.board;
    return Math.min(this.pageCount - 1, Math.max(0, Math.floor((docY + PAGE_GAP / 2) / PITCH)));
  }
  currentPageIndex() {
    return this.nearestPageIndex(this.toDoc(0, this.height / 2).y);
  }

  visiblePageRange() {
    if (this.board >= 0) return [this.board, this.board];
    const top = this.toDoc(0, 0).y;
    const bottom = this.toDoc(0, this.height).y;
    const first = Math.max(0, Math.floor(top / PITCH));
    const last = Math.min(this.pageCount - 1, Math.floor(bottom / PITCH));
    return [first, last];
  }

  // はみ出さないように位置を直す
  clamp() {
    this.zoom = Math.min(MAX_ZOOM, Math.max(this.minZoom, this.zoom));
    if (this.board >= 0) return; // ボードは上下左右どこまでも動かせる
    const s = this.scale;
    const cw = PAGE_WIDTH * s;
    if (cw <= this.width - SIDE_MARGIN * 2 + 0.5) {
      this.ox = (this.width - cw) / 2;
    } else {
      this.ox = Math.min(SIDE_MARGIN, Math.max(this.width - cw - SIDE_MARGIN, this.ox));
    }
    const ch = this.docHeight() * s;
    const minOy = this.height - ch - BOTTOM_MARGIN;
    this.oy = minOy > TOP_MARGIN ? TOP_MARGIN : Math.min(TOP_MARGIN, Math.max(minOy, this.oy));
  }

  panBy(dx, dy) {
    this.ox += dx;
    this.oy += dy;
    this.clamp();
  }

  // 文書座標 doc の点が画面の (sx, sy) に来るように拡大率を変える
  zoomAround(zoom, doc, sx, sy) {
    this.zoom = Math.min(MAX_ZOOM, Math.max(this.minZoom, zoom));
    const s = this.scale;
    this.ox = sx - doc.x * s;
    this.oy = sy - doc.y * s;
    this.clamp();
  }

  // 表示位置を「どのページの、どこを見ているか」で表す（ページが増えても位置がずれない）
  getAnchor() {
    const top = this.toDoc(0, 0);
    if (this.board >= 0) return { pageIndex: this.board, offsetY: top.y, x: top.x, zoom: this.zoom };
    const pageIndex = Math.min(this.pageCount - 1, Math.max(0, Math.floor(top.y / PITCH)));
    return { pageIndex, offsetY: top.y - this.pageTop(pageIndex), x: top.x, zoom: this.zoom };
  }

  setAnchor({ pageIndex, offsetY, x, zoom }) {
    this.zoom = Math.min(MAX_ZOOM, Math.max(this.minZoom, zoom || 1));
    const s = this.scale;
    this.oy = -(this.pageTop(pageIndex) + (offsetY || 0)) * s;
    this.ox = -(x || 0) * s;
    this.clamp();
  }

  // ボードページの表示位置（画面左上のボード座標と拡大率）
  getBoardView() {
    const top = this.toDoc(0, 0);
    return { x: top.x, y: top.y, zoom: this.zoom };
  }

  setBoardView({ x, y, zoom }) {
    this.zoom = Math.min(MAX_ZOOM, Math.max(BOARD_MIN_ZOOM, zoom || 1));
    const s = this.scale;
    this.ox = -(x || 0) * s;
    this.oy = -(y || 0) * s;
  }

  scrollToPage(pageIndex) {
    this.oy = TOP_MARGIN - this.pageTop(pageIndex) * this.scale;
    this.clamp();
  }
}
