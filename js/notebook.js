// 開いているノートのデータ（ノート・ページ・線・付箋・コネクタ・グループ枠）を持ち、読み込みと保存をする。
// 線と付箋などはページごとに、表示に必要になったときだけ読み込む（遠くのページは手放す）。
// 描くときに使う「ページの索引」（index）は、ページの中身が変わったときだけ作り直す。
import * as db from './db.js';
import { createPage, now } from './model.js';

// 付箋・コネクタ・グループ枠（線とは別に持つ）
export const OBJECT_KINDS = ['stickies', 'connectors', 'frames'];
const ALL_KINDS = ['strokes', ...OBJECT_KINDS];

function emptyObjects() {
  return { stickies: [], connectors: [], frames: [] };
}

function pushTo(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// ページの中身を、描く・当たり判定に使いやすい形にまとめる
//   free：ページに直接書いた線、bySticky / byFrame：付箋・枠ごとの線（相対位置）
//   stickies は重なりの順（下から上）。つなぐ先が無いコネクタ、持ち主の無い線は外す
export function buildIndex(strokes, objects) {
  const stickies = objects.stickies.slice().sort((a, b) => (a.z || 0) - (b.z || 0) || byCreated(a, b));
  const frames = objects.frames.slice().sort(byCreated);
  const stickyById = new Map(stickies.map((x) => [x.id, x]));
  const frameById = new Map(frames.map((x) => [x.id, x]));
  const free = [], bySticky = new Map(), byFrame = new Map();
  for (const s of strokes) {
    if (s.stickyId) {
      if (stickyById.has(s.stickyId)) pushTo(bySticky, s.stickyId, s);
    } else if (s.frameId) {
      if (frameById.has(s.frameId)) pushTo(byFrame, s.frameId, s);
    } else {
      free.push(s);
    }
  }
  const connectors = objects.connectors
    .filter((c) => c.fromId !== c.toId && stickyById.has(c.fromId) && stickyById.has(c.toId))
    .sort(byCreated);
  let maxZ = 0;
  for (const x of stickies) maxZ = Math.max(maxZ, x.z || 0);
  return { strokes, free, bySticky, byFrame, stickies, stickyById, frames, frameById, connectors, maxZ };
}

const KEEP_AROUND = 3; // 表示中のページの前後いくつまで線を持っておくか

function byCreated(a, b) {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function insertSorted(list, stroke) {
  if (list.some((s) => s.id === stroke.id)) return;
  let i = list.length;
  while (i > 0 && byCreated(list[i - 1], stroke) > 0) i--;
  list.splice(i, 0, stroke);
}

function removeById(list, id) {
  const i = list.findIndex((s) => s.id === id);
  if (i >= 0) list.splice(i, 1);
}

export class Notebook {
  constructor() {
    this.note = null;
    this.pages = [];
    this.strokesByPage = new Map();
    this.objectsByPage = new Map(); // ページID → { stickies, connectors, frames }
    this.versions = new Map();      // ページID → 中身が変わった回数（索引を作り直すかどうかの判定用）
    this.indexCache = new Map();
    this.loading = new Map();
    this.pending = new Map(); // 読み込み中のページに対する追加・削除
    this.onPageLoaded = () => {};
    this.onError = (err) => console.error(err);
    this.saveTimer = null;
    this.disabled = false; // バックアップの読み込み中は、古い写しを書き戻さないように保存をやめる
  }

  async open(noteId) {
    this.note = await db.get('notes', noteId);
    if (!this.note) throw new Error('ノートが見つかりません');
    const pages = await db.getAllByIndex('pages', 'noteId', noteId);
    pages.sort((a, b) => a.order - b.order);
    this.pages = pages;
    this.strokesByPage.clear();
    this.objectsByPage.clear();
    this.indexCache.clear();
    return this.note;
  }

  pageIndexById(pageId) {
    return this.pages.findIndex((p) => p.id === pageId);
  }

  isLoaded(pageId) {
    return this.strokesByPage.has(pageId);
  }

  strokes(pageId) {
    return this.strokesByPage.get(pageId) || null;
  }

  objects(pageId) {
    return this.objectsByPage.get(pageId) || null;
  }

  list(kind, pageId) {
    return kind === 'strokes' ? this.strokesByPage.get(pageId) : (this.objectsByPage.get(pageId) || {})[kind];
  }

  // ページの中身が変わったことを記録する（索引を作り直させる）
  bump(pageId) {
    this.versions.set(pageId, (this.versions.get(pageId) || 0) + 1);
  }

  // 読み込み済みのページの索引（buildIndex）。読み込み前は null
  index(pageId) {
    const strokes = this.strokesByPage.get(pageId);
    const objects = this.objectsByPage.get(pageId);
    if (!strokes || !objects) return null;
    const v = this.versions.get(pageId) || 0;
    const c = this.indexCache.get(pageId);
    if (c && c.v === v) return c.idx;
    const idx = buildIndex(strokes, objects);
    this.indexCache.set(pageId, { v, idx });
    return idx;
  }

  // 読み込んでいないページも含めて索引を作る（ページ一覧の縮小表示用。覚えておかない）
  async fetchIndex(pageId) {
    const idx = this.index(pageId);
    if (idx) return idx;
    const [strokes, stickies, connectors, frames] = await Promise.all(ALL_KINDS.map((k) => db.getAllByIndex(k, 'pageId', pageId)));
    strokes.sort(byCreated);
    return buildIndex(strokes, { stickies, connectors, frames });
  }

  ensureLoaded(pageId) {
    if (this.strokesByPage.has(pageId)) return Promise.resolve();
    if (this.loading.has(pageId)) return this.loading.get(pageId);
    const p = Promise.all(ALL_KINDS.map((k) => db.getAllByIndex(k, 'pageId', pageId)))
      .then(([list, stickies, connectors, frames]) => {
        list.sort(byCreated);
        const objects = { stickies, connectors, frames };
        for (const op of this.pending.get(pageId) || []) {
          const target = !op.kind || op.kind === 'strokes' ? list : objects[op.kind];
          if (op.add) {
            if (target === list) insertSorted(list, op.add);
            else { removeById(target, op.add.id); target.push(op.add); }
          } else {
            removeById(target, op.remove);
          }
        }
        this.pending.delete(pageId);
        this.loading.delete(pageId);
        this.strokesByPage.set(pageId, list);
        this.objectsByPage.set(pageId, objects);
        this.bump(pageId);
        this.onPageLoaded(pageId);
      })
      .catch((err) => {
        this.loading.delete(pageId);
        this.onError(err);
      });
    this.loading.set(pageId, p);
    return p;
  }

  // 表示しているページのまわり以外の線を手放す（メモリを節約）
  keepAround(first, last) {
    for (const pageId of [...this.strokesByPage.keys()]) {
      const i = this.pageIndexById(pageId);
      if (i < first - KEEP_AROUND || i > last + KEEP_AROUND) {
        this.strokesByPage.delete(pageId);
        this.objectsByPage.delete(pageId);
        this.indexCache.delete(pageId);
      }
    }
  }

  addStrokes(strokes) {
    for (const s of strokes) {
      const list = this.strokesByPage.get(s.pageId);
      if (list) insertSorted(list, s);
      else if (this.loading.has(s.pageId)) this.queue(s.pageId, { add: s });
      this.bump(s.pageId);
    }
    this.touch();
    return db.putMany('strokes', strokes).catch((err) => this.onError(err));
  }

  removeStrokes(strokes) {
    for (const s of strokes) {
      const list = this.strokesByPage.get(s.pageId);
      if (list) removeById(list, s.id);
      else if (this.loading.has(s.pageId)) this.queue(s.pageId, { remove: s.id });
      this.bump(s.pageId);
    }
    this.touch();
    return db.deleteMany('strokes', strokes.map((s) => s.id)).catch((err) => this.onError(err));
  }

  // 同じIDの線を新しい中身に入れ替える（動かす・色を変える）。before と after は同じ順で同じ数
  replaceStrokes(before, after) {
    for (const s of before) {
      const list = this.strokesByPage.get(s.pageId);
      if (list) removeById(list, s.id);
      else if (this.loading.has(s.pageId)) this.queue(s.pageId, { remove: s.id });
    }
    for (const s of after) {
      const list = this.strokesByPage.get(s.pageId);
      if (list) insertSorted(list, s);
      else if (this.loading.has(s.pageId)) this.queue(s.pageId, { add: s });
      this.bump(s.pageId);
    }
    this.touch();
    return db.putMany('strokes', after).catch((err) => this.onError(err)); // 同じIDを上書きするので、保存は1回
  }

  // 線・付箋・コネクタ・枠をまとめて入れ替える（元に戻す・やり直すの1回分）。
  // before / after は { strokes, stickies, connectors, frames }（どれも省略可）。
  // before の物を外し、after の物を入れる。同じIDが両方にあれば中身の入れ替えになる。保存は1回のまとめ書き
  applyChange(before = {}, after = {}) {
    const ops = [];
    const afterIds = new Set();
    for (const kind of ALL_KINDS) for (const x of after[kind] || []) afterIds.add(x.id);
    for (const kind of ALL_KINDS) {
      for (const x of before[kind] || []) {
        this.removeLocal(kind, x);
        if (!afterIds.has(x.id)) ops.push({ store: kind, delete: x.id });
      }
    }
    for (const kind of ALL_KINDS) {
      for (const x of after[kind] || []) {
        this.putLocal(kind, x);
        ops.push({ store: kind, put: x });
      }
    }
    if (!ops.length) return Promise.resolve();
    this.touch();
    return db.writeBatch(ops).catch((err) => this.onError(err));
  }

  removeLocal(kind, x) {
    const list = this.list(kind, x.pageId);
    if (list) removeById(list, x.id);
    else if (this.loading.has(x.pageId)) this.queue(x.pageId, { kind, remove: x.id });
    this.bump(x.pageId);
  }

  putLocal(kind, x) {
    const list = this.list(kind, x.pageId);
    if (list) {
      removeById(list, x.id);
      if (kind === 'strokes') insertSorted(list, x);
      else list.push(x);
    } else if (this.loading.has(x.pageId)) {
      this.queue(x.pageId, { kind, add: x });
    }
    this.bump(x.pageId);
  }

  queue(pageId, op) {
    if (!this.pending.has(pageId)) this.pending.set(pageId, []);
    this.pending.get(pageId).push(op);
  }

  // afterIndex のページのうしろに新しいページを足し、その番号を返す。paper に 'board' を渡すとボードページ
  async addPage(paper, afterIndex) {
    const prev = this.pages[afterIndex];
    const next = this.pages[afterIndex + 1];
    let order;
    if (!prev) order = 1;
    else if (!next) order = prev.order + 1;
    else order = (prev.order + next.order) / 2;
    const kind = paper === 'board' ? 'board' : 'note';
    const page = createPage({ noteId: this.note.id, paper: kind === 'board' ? null : paper, order, kind });
    await db.put('pages', page);
    this.pages.splice(afterIndex + 1, 0, page);
    this.strokesByPage.set(page.id, []);
    this.objectsByPage.set(page.id, emptyObjects());
    this.bump(page.id);
    this.touch();
    return afterIndex + 1;
  }

  // ページの並べ替え。from の番号のページを to の番号に動かす
  async movePage(from, to) {
    if (from === to || from < 0 || to < 0 || from >= this.pages.length || to >= this.pages.length) return;
    const [page] = this.pages.splice(from, 1);
    this.pages.splice(to, 0, page);
    const prev = this.pages[to - 1];
    const next = this.pages[to + 1];
    let order;
    if (!prev) order = next.order - 1;
    else if (!next) order = prev.order + 1;
    else order = (prev.order + next.order) / 2;
    const t = now();
    if (prev && next && next.order - prev.order < 1e-6) {
      // 並び順の数が近づきすぎたので、全部を振り直す
      this.pages.forEach((p, i) => { p.order = i + 1; p.updatedAt = t; });
      await db.putMany('pages', this.pages);
    } else {
      page.order = order;
      page.updatedAt = t;
      await db.put('pages', page);
    }
    this.touch();
  }

  // ページを消す（そのページの線・付箋なども一緒に）。最後の1枚は消せない
  async deletePage(index) {
    const page = this.pages[index];
    if (!page || this.pages.length <= 1) return false;
    const ops = [{ store: 'pages', delete: page.id }];
    for (const store of ['strokes', 'stickies', 'connectors', 'frames']) {
      for (const id of await db.getKeysByIndex(store, 'pageId', page.id)) ops.push({ store, delete: id });
    }
    await db.writeBatch(ops);
    this.pages.splice(index, 1);
    this.strokesByPage.delete(page.id);
    this.objectsByPage.delete(page.id);
    this.indexCache.delete(page.id);
    this.pending.delete(page.id);
    if (this.note.lastPageId === page.id) {
      this.note.lastPageId = this.pages[Math.min(index, this.pages.length - 1)].id;
      this.note.view = null;
    }
    this.touch();
    return true;
  }

  // 「前回の続き」用に、見ているページと表示位置を覚える（少し待ってまとめて保存）
  setView(pageId, view) {
    this.note.lastPageId = pageId;
    this.note.view = view;
    this.saveSoon();
  }

  // ボードページの表示位置を覚える（ページごと）
  setBoardView(pageId, view) {
    if (!this.note.boardViews || typeof this.note.boardViews !== 'object') this.note.boardViews = {};
    this.note.boardViews[pageId] = view;
    this.saveSoon();
  }

  boardView(pageId) {
    return (this.note.boardViews && this.note.boardViews[pageId]) || null;
  }

  // ボードページを開いているかどうか（次に開いたときにボードから始めるため）
  setBoardPage(pageId) {
    this.note.boardPageId = pageId;
    this.saveSoon();
  }

  touch() {
    this.note.updatedAt = now();
    this.saveSoon();
  }

  saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNote(), 500);
  }

  saveNote() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.note || this.disabled) return Promise.resolve();
    return db.put('notes', this.note).catch((err) => this.onError(err));
  }
}
