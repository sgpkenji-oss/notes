// フォルダとノートの作成・削除など、データベースを直接触る操作。
// 開いているノートの書き換えは app.js を通す（開いているノートの写しが古くならないように）。
import * as db from './db.js';
import { createFolder, createNote, createPage, MAX_FOLDER_DEPTH, now } from './model.js';

// フォルダの深さ（一番上のフォルダが1）。親をたどれない（壊れている）ときは上限扱い
export function folderDepth(folders, id) {
  let depth = 0;
  let cur = id;
  const seen = new Set();
  while (cur) {
    if (seen.has(cur)) return MAX_FOLDER_DEPTH + 1;
    seen.add(cur);
    const f = folders.find((x) => x.id === cur);
    if (!f) break;
    depth++;
    cur = f.parentId;
  }
  return depth;
}

// parentId の下にフォルダを作れるか（作ったフォルダの深さが上限以内か）
export function canCreateFolderIn(folders, parentId) {
  return folderDepth(folders, parentId) < MAX_FOLDER_DEPTH;
}

// 一番上から id までのフォルダの並び（いまいる場所の表示用）
export function folderPath(folders, id) {
  const path = [];
  let cur = id;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const f = folders.find((x) => x.id === cur);
    if (!f) break;
    path.unshift(f);
    cur = f.parentId;
  }
  return path;
}

export function childFolders(folders, parentId) {
  return folders
    .filter((f) => (f.parentId ?? null) === (parentId ?? null))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ja'));
}

export async function addFolder(folders, parentId, name) {
  if (!canCreateFolderIn(folders, parentId)) throw new Error('フォルダは3階層までです');
  const siblings = childFolders(folders, parentId);
  const order = siblings.length ? siblings[siblings.length - 1].order + 1 : 1;
  const folder = createFolder({ name, parentId, order });
  await db.put('folders', folder);
  return folder;
}

export async function renameFolder(folder, name) {
  const next = { ...folder, name, updatedAt: now() };
  await db.put('folders', next);
  return next;
}

// フォルダを消す。中のノートとフォルダは、ひとつ上の場所に移す（中身は消さない）
export async function removeFolder(folders, notes, folderId) {
  const folder = folders.find((f) => f.id === folderId);
  if (!folder) return;
  const parentId = folder.parentId ?? null;
  const t = now();
  const ops = [{ store: 'folders', delete: folderId }];
  for (const f of folders) {
    if (f.parentId === folderId) ops.push({ store: 'folders', put: { ...f, parentId, updatedAt: t } });
  }
  for (const n of notes) {
    if (n.folderId === folderId) ops.push({ store: 'notes', put: { ...n, folderId: parentId, updatedAt: t } });
  }
  await db.writeBatch(ops);
}

// ノートと最初のページを作る
export async function addNote({ name, folderId = null }) {
  const note = createNote({ name, folderId });
  const page = createPage({ noteId: note.id, paper: 'ruled', order: 1 });
  note.lastPageId = page.id;
  await db.writeBatch([
    { store: 'notes', put: note },
    { store: 'pages', put: page },
  ]);
  return note;
}

// ノートと、そのページ・線・付箋・コネクタ・グループ枠をすべて消す
export async function removeNoteTree(noteId) {
  const pages = await db.getAllByIndex('pages', 'noteId', noteId);
  const ops = [];
  for (const page of pages) {
    for (const store of ['strokes', 'stickies', 'connectors', 'frames']) {
      for (const id of await db.getKeysByIndex(store, 'pageId', page.id)) ops.push({ store, delete: id });
    }
    ops.push({ store: 'pages', delete: page.id });
  }
  ops.push({ store: 'notes', delete: noteId });
  await db.writeBatch(ops);
}

// タグの一覧（使われている数つき）
export function collectTags(notes) {
  const counts = new Map();
  for (const n of notes) for (const t of n.tags) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

export function normalizeTags(list) {
  const out = [];
  for (const raw of list) {
    const t = String(raw).replace(/^[#＃]+/, '').trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}
