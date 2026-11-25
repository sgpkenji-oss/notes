// データの形をまとめたファイル（SPEC.md「データ構造」に対応）。
// すべてのデータは id（ランダムな文字列）、createdAt、updatedAt（ミリ秒）を持つ。

// ページの大きさ（ページ座標の単位。A4縦の比率。1単位 ≒ 0.21mm）
export const PAGE_WIDTH = 1000;
export const PAGE_HEIGHT = 1414;
// ページとページのすきま（ページ座標の単位）
export const PAGE_GAP = 28;

// タブの数の上限、フォルダの深さの上限
export const MAX_TABS = 8;
export const MAX_FOLDER_DEPTH = 3;

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

// フォルダ（3階層まで。親フォルダが null なら一番上）
export function createFolder({ name, parentId = null, order = 0 }) {
  return base({ name, parentId, order });
}

// ノート。lastPageId と view で「前回の続き」を開く。
// view = { offsetY: ページ上端から画面上端までの距離, x: 画面左端のページ座標, zoom: 画面幅に合わせた大きさを1とした拡大率 }
// boardPageId は、ボードページを開いたまま閉じたときのそのページのID（次に開いたときにボードから始める）。
// boardViews は、ボードページごとの表示位置 { [ページID]: { x, y, zoom } }（x, y は画面左上のボード座標）。
export function createNote({ name, folderId = null }) {
  return base({ name, folderId, tags: [], pinned: false, lastPageId: null, view: null, openedAt: now(), boardPageId: null, boardViews: {} });
}

// ページ。kind は 'note'（ノートページ）か 'board'（ボードページ。上下左右に広がる）。
// paper は 'plain' | 'ruled' | 'grid'（ボードページは null）。order は並び順（小数も可）。
export function createPage({ noteId, paper = 'ruled', order = 1, kind = 'note' }) {
  return base({ noteId, kind, paper: kind === 'board' ? null : paper, order });
}

// 線。points は [x, y, 筆圧, x, y, 筆圧, ...] の平らな配列（ページ座標。筆圧は 0〜1）。
// stickyId は付箋の中の線のとき付箋のID（そのとき座標は付箋の左上からの相対位置）。
// frameId はグループ枠の名前（上辺に手書き）の線のとき枠のID（そのとき座標は枠の左上からの相対位置）。
// どちらも無い線（第3段階までの線）は、ページに直接書いた線。
// tool は 'pen' | 'marker'、width は基準の太さ（ページ座標の単位）。
export function createStroke({ pageId, stickyId = null, frameId = null, tool, color, width, points = [] }) {
  return base({ pageId, stickyId, frameId, tool, color, width, points });
}

// ---- 付箋・コネクタ・グループ枠（第4段階） ----
// 位置と大きさはページ座標（ボードページではボード座標。原点は最初に開いたときの左上）。

export const STICKY_SIZE = 180;      // 新しい付箋の大きさ
export const STICKY_MIN = 90;        // 付箋の最小の大きさ
export const STICKY_BAND = 30;       // 付箋の上の帯（つまんで動かす所）の高さ
export const FRAME_BAND = 64;        // 枠の上辺（名前を書く所）の高さ
export const FRAME_MIN = 160;        // 枠の最小の大きさ
export const FRAME_PAD = 28;         // 付箋を囲んで枠を作るときの余白

// 付箋。color は色の名前（scene.js の STICKY_COLORS）。frameId は所属するグループ枠。z は重なりの順（大きいほど上）
export function createSticky({ pageId, x, y, w = STICKY_SIZE, h = STICKY_SIZE, color = 'yellow', frameId = null, z = 0 }) {
  return base({ pageId, x, y, w, h, color, frameId, z });
}

// コネクタ。fromId → toId の付箋をつなぐ。arrow は 'none' | 'end'（先だけ）| 'both'
export function createConnector({ pageId, fromId, toId, arrow = 'end', color = '#4a5260' }) {
  return base({ pageId, fromId, toId, arrow, color });
}

// グループ枠。名前は手書き（frameId を持つ線）。color は色の名前（scene.js の FRAME_COLORS）
export function createFrame({ pageId, x, y, w, h, color = 'gray' }) {
  return base({ pageId, x, y, w, h, color });
}

// アプリの状態（1件だけ。id は 'app' に固定）
export function createAppState(noteId) {
  const t = now();
  return {
    id: 'app',
    createdAt: t,
    updatedAt: t,
    schemaVersion: 4,
    tabs: [noteId],
    tabUsedAt: { [noteId]: t },
    activeNoteId: noteId,
    settings: { inputMode: 'touch', prediction: false },
    toolState: null,
    lastBackupAt: null,
  };
}
