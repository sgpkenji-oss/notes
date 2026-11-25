// データの形をまとめたファイル（SPEC.md「データ構造」に対応）。
// すべてのデータは id（ランダムな文字列）、createdAt、updatedAt（ミリ秒）を持つ。

// ページの大きさ（ページ座標の単位。A4縦の比率。1単位 ≒ 0.21mm）
export const PAGE_WIDTH = 1000;
export const PAGE_HEIGHT = 1414;
// ページとページのすきま（ページ座標の単位）
export const PAGE_GAP = 28;

export const PAPER_TYPES = [
  { key: 'plain', label: '無地' },
  { key: 'ruled', label: '罫線' },
  { key: 'grid', label: '方眼' },
];

export function newId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function now() {
  return Date.now();
}

function base(fields) {
  const t = now();
  return { id: newId(), createdAt: t, updatedAt: t, ...fields };
}

// フォルダ（第3段階で使う）
export function createFolder({ name, parentId = null, order = 0 }) {
  return base({ name, parentId, order });
}

// ノート。lastPageId と view で「前回の続き」を開く。
// view = { offsetY: ページ上端から画面上端までの距離, x: 画面左端のページ座標, zoom: 画面幅に合わせた大きさを1とした拡大率 }
export function createNote({ name, folderId = null }) {
  return base({ name, folderId, tags: [], pinned: false, lastPageId: null, view: null });
}

// ページ。kind は 'note'（ノートページ）か 'board'（ボードページ、第4段階）。
// paper は 'plain' | 'ruled' | 'grid'（ボードページは null）。order は並び順（小数も可）。
export function createPage({ noteId, paper = 'ruled', order = 1, kind = 'note' }) {
  return base({ noteId, kind, paper: kind === 'board' ? null : paper, order });
}

// 線。points は [x, y, 筆圧, x, y, 筆圧, ...] の平らな配列（ページ座標。筆圧は 0〜1）。
// stickyId は付箋の中の線のとき付箋のID（第4段階。そのとき座標は付箋からの相対位置）。
// tool は 'pen' | 'marker'、width は基準の太さ（ページ座標の単位）。
export function createStroke({ pageId, stickyId = null, tool, color, width, points = [] }) {
  return base({ pageId, stickyId, tool, color, width, points });
}

// アプリの状態（1件だけ。id は 'app' に固定）
export function createAppState(noteId) {
  const t = now();
  return {
    id: 'app',
    createdAt: t,
    updatedAt: t,
    tabs: [noteId],
    activeNoteId: noteId,
    settings: { inputMode: 'touch', prediction: false },
    toolState: null,
    lastBackupAt: null,
  };
}
