// 元に戻す・やり直す。
// 記録の形：{ type: 'add', strokes: [...] }（線を書いた） / { type: 'erase', strokes: [...] }（線を消した）
// 第3段階以降で「移動」などを足すときは、type を増やして app.js の applyHistory に処理を足す。
const LIMIT = 200;

export class History {
  constructor() {
    this.undoStack = [];
    this.redoStack = [];
    this.onChange = () => {};
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
