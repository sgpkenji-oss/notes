// 開いているノートのデータ（ノート・ページ・線）を持ち、読み込みと保存をする。
// 線はページごとに、表示に必要になったときだけ読み込む（遠くのページは手放す）。
import * as db from './db.js';
import { createPage, now } from './model.js';

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

  ensureLoaded(pageId) {
    if (this.strokesByPage.has(pageId)) return Promise.resolve();
    if (this.loading.has(pageId)) return this.loading.get(pageId);
    const p = db.getAllByIndex('strokes', 'pageId', pageId)
      .then((list) => {
        list.sort(byCreated);
        for (const op of this.pending.get(pageId) || []) {
          if (op.add) insertSorted(list, op.add);
          else removeById(list, op.remove);
        }
        this.pending.delete(pageId);
        this.loading.delete(pageId);
        this.strokesByPage.set(pageId, list);
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
      if (i < first - KEEP_AROUND || i > last + KEEP_AROUND) this.strokesByPage.delete(pageId);
    }
  }

  addStrokes(strokes) {
    for (const s of strokes) {
      const list = this.strokesByPage.get(s.pageId);
      if (list) insertSorted(list, s);
      else if (this.loading.has(s.pageId)) this.queue(s.pageId, { add: s });
    }
    this.touch();
    return db.putMany('strokes', strokes).catch((err) => this.onError(err));
  }

  removeStrokes(strokes) {
    for (const s of strokes) {
      const list = this.strokesByPage.get(s.pageId);
      if (list) removeById(list, s.id);
      else if (this.loading.has(s.pageId)) this.queue(s.pageId, { remove: s.id });
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
    }
    this.touch();
    return db.putMany('strokes', after).catch((err) => this.onError(err)); // 同じIDを上書きするので、保存は1回
  }

  queue(pageId, op) {
    if (!this.pending.has(pageId)) this.pending.set(pageId, []);
    this.pending.get(pageId).push(op);
  }

  // afterIndex のページのうしろに新しいページを足し、その番号を返す
  async addPage(paper, afterIndex) {
    const prev = this.pages[afterIndex];
    const next = this.pages[afterIndex + 1];
    let order;
    if (!prev) order = 1;
    else if (!next) order = prev.order + 1;
    else order = (prev.order + next.order) / 2;
    const page = createPage({ noteId: this.note.id, paper, order });
    await db.put('pages', page);
    this.pages.splice(afterIndex + 1, 0, page);
    this.strokesByPage.set(page.id, []);
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
