// データの形の「古い形 → 新しい形」の移し替え。
// 第2段階までに保存したデータ（試し書きのノート）も、バックアップの読み込みでも、ここを通して新しい形にそろえる。
// 何度通しても同じ結果になる（すでに新しい形のデータは変えない）。
//
// 形の履歴
//   第2段階まで：schemaVersion なし。ノートに openedAt なし、アプリの状態に tabUsedAt なし。
//   第3段階    ：schemaVersion 3。ノートに openedAt（最後に開いた日時）、アプリの状態に tabUsedAt（タブごとの最後に使った日時）を追加。
// 次に形を変えるときは SCHEMA_VERSION を上げ、下の関数に足りない項目を補う処理を足す。
import { MAX_TABS } from './model.js';

export const SCHEMA_VERSION = 3;

export const DEFAULT_SETTINGS = { inputMode: 'touch', prediction: false };

export function migrateFolder(f) {
  return { ...f, parentId: f.parentId ?? null, order: f.order ?? 0 };
}

export function migrateNote(n) {
  return {
    ...n,
    folderId: n.folderId ?? null,
    tags: Array.isArray(n.tags) ? n.tags.filter((t) => typeof t === 'string' && t) : [],
    pinned: !!n.pinned,
    lastPageId: n.lastPageId ?? null,
    view: n.view ?? null,
    openedAt: n.openedAt ?? n.updatedAt ?? n.createdAt ?? 0,
  };
}

// noteIds：実在するノートのID（タブに残っている消えたノートを外すために使う）
export function migrateAppState(s, noteIds) {
  const exists = new Set(noteIds);
  const t = Date.now();
  const tabs = (Array.isArray(s.tabs) ? s.tabs : []).filter((id, i, a) => exists.has(id) && a.indexOf(id) === i).slice(0, MAX_TABS);
  const used = s.tabUsedAt && typeof s.tabUsedAt === 'object' ? s.tabUsedAt : {};
  const tabUsedAt = {};
  for (const id of tabs) tabUsedAt[id] = Number(used[id]) || 0;
  let active = s.activeNoteId;
  if (!tabs.includes(active)) active = tabs[0] ?? null;
  return {
    ...s,
    id: 'app',
    createdAt: s.createdAt ?? t,
    updatedAt: s.updatedAt ?? t,
    tabs,
    tabUsedAt,
    activeNoteId: active,
    settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
    toolState: s.toolState ?? null,
    lastBackupAt: s.lastBackupAt ?? null,
    schemaVersion: SCHEMA_VERSION,
  };
}

// バックアップの中身（7つの入れ物＋アプリの状態）をまとめて新しい形にする。読み込み前の確認にも使う
export function migrateData(data) {
  const list = (name) => (Array.isArray(data[name]) ? data[name] : []);
  const notes = list('notes').map(migrateNote);
  const out = {
    folders: list('folders').map(migrateFolder),
    notes,
    pages: list('pages'),
    strokes: list('strokes'),
    stickies: list('stickies'),
    connectors: list('connectors'),
    frames: list('frames'),
    appState: [],
  };
  const app = list('appState').find((a) => a && a.id === 'app');
  if (app) out.appState = [migrateAppState(app, notes.map((n) => n.id))];
  return out;
}
