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
    if (!this.note) return Promise.resolve();
    return db.put('notes', this.note).catch((err) => this.onError(err));
  }
}
