// 元に戻す・やり直す。ノート（タブ）ごとに別々の履歴を持つ。
// 記録の形：
//   { type: 'add', strokes: [...] }              線を書いた・貼り付けた
//   { type: 'erase', strokes: [...] }            線を消した（消しゴム・なげなわの削除）
//   { type: 'replace', before: [...], after: [...] }  線を動かした・色を変えた（同じIDの線を入れ替える）
// 新しい種類を足すときは、type を増やして app.js の applyHistory に処理を足す。
const LIMIT = 200;

export class History {
  constructor() {
    this.key = null;
    this.undoStack = [];
    this.redoStack = [];
    this.saved = new Map();
    this.onChange = () => {};
  }
  // 使う履歴をノートごとに切り替える
  use(key) {
    if (this.key === key) return;
    if (this.key !== null) this.saved.set(this.key, { u: this.undoStack, r: this.redoStack });
    const s = this.saved.get(key) || { u: [], r: [] };
    this.saved.delete(key);
    this.key = key;
    this.undoStack = s.u;
    this.redoStack = s.r;
    this.onChange();
  }
  // タブを閉じたノートの履歴を手放す
  drop(key) {
    this.saved.delete(key);
  }
  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.onChange();
  }
  push(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.onChange();
  }
  undo() {
    const e = this.undoStack.pop();
    if (e) this.redoStack.push(e);
    this.onChange();
    return e;
  }
  redo() {
    const e = this.redoStack.pop();
    if (e) this.undoStack.push(e);
    this.onChange();
    return e;
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
}
