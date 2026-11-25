// アプリの起動と、各部品のつなぎ合わせ。
//   db.js        IndexedDB への保存
//   model.js     データの形
//   notebook.js  開いているノートのデータ
//   viewport.js  表示位置（スクロール・拡大率）
//   renderer.js  確定した線を描く（下の canvas）
//   ink.js       書いている途中の線を描く（上の canvas）
//   geometry.js  線の形・消しゴムの当たり判定
//   input.js     ペンと指の入力
//   tools.js / toolbar.js  道具の選択と道具の帯
//   history.js   元に戻す・やり直す
//   notices.js   お知らせ
import * as db from './db.js';
import { createNote, createPage, createAppState, PAGE_WIDTH } from './model.js';
import { Notebook } from './notebook.js';
import { Viewport } from './viewport.js';
import { Renderer } from './renderer.js';
import { Ink } from './ink.js';
import { InputController } from './input.js';
import { ToolState, ERASER_RADIUS } from './tools.js';
import { Toolbar } from './toolbar.js';
import { History } from './history.js';
import { hitStroke } from './geometry.js';
import { setupInstallBanner, requestPersistentStorage, toast, showFatal } from './notices.js';

const stage = document.getElementById('stage');
const baseCanvas = document.getElementById('base-canvas');
const inkCanvas = document.getElementById('ink-canvas');
const pageIndicator = document.getElementById('page-indicator');

const notebook = new Notebook();
const viewport = new Viewport();
const renderer = new Renderer(baseCanvas, viewport, notebook);
const ink = new Ink(inkCanvas, viewport);
const history = new History();
let appState = null;
let tools = null;
let toolbar = null;
let input = null;
let erasing = null;

// ---- 起動 ----

async function boot() {
  setupInstallBanner(resize);
  requestPersistentStorage();

  appState = await db.get('appState', 'app');
  let note = appState ? await db.get('notes', appState.activeNoteId) : null;
  if (!note) {
    // 初めて起動したとき：「最初のノート」を作る
    note = createNote({ name: '最初のノート' });
    const page = createPage({ noteId: note.id, paper: 'ruled', order: 1 });
    note.lastPageId = page.id;
    appState = appState || createAppState(note.id);
    appState.tabs = [note.id];
    appState.activeNoteId = note.id;
    await db.writeBatch([
      { store: 'notes', put: note },
      { store: 'pages', put: page },
      { store: 'appState', put: appState },
    ]);
  }

  notebook.onError = (err) => {
    console.error(err);
    toast('保存できませんでした。空き容量を確かめてください');
  };
  notebook.onPageLoaded = (pageId) => renderer.invalidatePage(pageId);
  await notebook.open(note.id);
  if (!notebook.pages.length) await notebook.addPage('ruled', -1);
  viewport.pageCount = notebook.pages.length;

  tools = new ToolState(appState.toolState);
  tools.onChange = () => {
    toolbar.update();
    appState.toolState = tools.toJSON();
    saveAppStateSoon();
  };
  history.onChange = () => toolbar && toolbar.update();
  toolbar = new Toolbar({ tools, history, onUndo: undo, onRedo: redo, onAddPage: addPage });

  // 前回の続きから開く
  measure();
  const idx = notebook.pageIndexById(note.lastPageId);
  if (idx >= 0 && note.view) viewport.setAnchor({ pageIndex: idx, ...note.view });
  else viewport.setAnchor({ pageIndex: Math.max(0, idx), offsetY: -16 / viewport.scale, x: 0, zoom: 1 });

  input = new InputController(stage, viewport, {
    stylusStart, stylusMove, stylusEnd,
    viewChanged,
    gestureStart: () => renderer.setInteracting(true),
    gestureEnd: () => {
      renderer.setInteracting(false);
      viewChanged();
    },
  });

  ink.resize();
  renderer.resize();
  updatePageIndicator();
  new ResizeObserver(resize).observe(stage);
  window.addEventListener('keydown', onKeyDown);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveAll();
  });
  window.addEventListener('pagehide', saveAll);
  // iPadのSafariで、道具の帯などを2本指でつまんで画面全体が拡大されないように
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
}

function measure() {
  const r = stage.getBoundingClientRect();
  viewport.setSize(r.width, r.height, window.devicePixelRatio || 1);
}

function resize() {
  const anchor = viewport.getAnchor();
  measure();
  viewport.setAnchor(anchor);
  if (input) input.updateRect();
  ink.resize();
  renderer.resize();
  updatePageIndicator();
}

// ---- 表示位置 ----

function viewChanged() {
  renderer.requestRender();
  updatePageIndicator();
  const a = viewport.getAnchor();
  const page = notebook.pages[a.pageIndex];
  if (page) notebook.setView(page.id, { offsetY: round(a.offsetY), x: round(a.x), zoom: round(a.zoom, 1000) });
  const [first, last] = viewport.visiblePageRange();
  notebook.keepAround(first, last);
}

function round(v, k = 10) {
  return Math.round(v * k) / k;
}

function updatePageIndicator() {
  pageIndicator.textContent = `${viewport.currentPageIndex() + 1} / ${notebook.pages.length}`;
}

// ---- ペン（書く・消す） ----

function stylusStart(sx, sy, force) {
  const doc = viewport.toDoc(sx, sy);
  if (tools.tool === 'eraser') {
    erasing = { removed: [], last: doc };
    eraseAlong(doc, doc);
    ink.drawEraser(sx, sy, ERASER_RADIUS);
    return;
  }
  const idx = viewport.pageIndexAt(doc.y);
  if (idx < 0 || doc.x < 0 || doc.x > PAGE_WIDTH) return; // ページの外では書かない
  const page = notebook.pages[idx];
  ink.begin(page.id, idx, tools.strokeStyle());
  ink.add(doc.x, doc.y - viewport.pageTop(idx), force);
  ink.draw();
}

function stylusMove(sx, sy, force) {
  if (erasing) {
    const doc = viewport.toDoc(sx, sy);
    eraseAlong(erasing.last, doc);
    erasing.last = doc;
    ink.drawEraser(sx, sy, ERASER_RADIUS);
    return;
  }
  if (!ink.active) return;
  const doc = viewport.toDoc(sx, sy);
  ink.add(doc.x, doc.y - viewport.pageTop(ink.pageIndex), force);
  ink.draw();
}

function stylusEnd() {
  if (erasing) {
    if (erasing.removed.length) history.push({ type: 'erase', strokes: erasing.removed });
    erasing = null;
    ink.clear();
    return;
  }
  const stroke = ink.finish();
  if (!stroke) return;
  notebook.addStrokes([stroke]); // 線を1本書き終えるたびに保存
  renderer.addStroke(stroke);
  renderer.render(); // 下に確定してから…
  requestAnimationFrame(() => {
    if (!ink.active) ink.clear(); // …上を消す（ちらつき防止）
  });
  history.push({ type: 'add', strokes: [stroke] });
}

// 消しゴム：a→b の間で触れた線を、1本まるごと消す
function eraseAlong(a, b) {
  const r = ERASER_RADIUS / viewport.scale;
  const [first, last] = viewport.visiblePageRange();
  let changed = false;
  for (let i = first; i <= last; i++) {
    const page = notebook.pages[i];
    const list = notebook.strokes(page.id);
    if (!list) continue;
    const top = viewport.pageTop(i);
    const hits = list.filter((s) => hitStroke(s, a.x, a.y - top, b.x, b.y - top, r));
    if (!hits.length) continue;
    notebook.removeStrokes(hits);
    for (const s of hits) renderer.invalidateStroke(s);
    erasing.removed.push(...hits);
    changed = true;
  }
  if (changed) renderer.requestRender();
}

// ---- 元に戻す・やり直す ----

function undo() {
  if (ink.active || erasing) return;
  const e = history.undo();
  if (e) applyHistory(e, true);
}

function redo() {
  if (ink.active || erasing) return;
  const e = history.redo();
  if (e) applyHistory(e, false);
}

function applyHistory(entry, isUndo) {
  const add = (entry.type === 'add') !== isUndo;
  if (add) notebook.addStrokes(entry.strokes);
  else notebook.removeStrokes(entry.strokes);
  for (const s of entry.strokes) renderer.invalidateStroke(s);
}

function onKeyDown(e) {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  } else if (mod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
  }
}

// ---- ページ ----

async function addPage(paper) {
  try {
    const idx = await notebook.addPage(paper, viewport.currentPageIndex());
    viewport.pageCount = notebook.pages.length;
    viewport.scrollToPage(idx);
    viewChanged();
  } catch (err) {
    notebook.onError(err);
  }
}

// ---- 保存 ----

let appStateTimer = null;
function saveAppStateSoon() {
  clearTimeout(appStateTimer);
  appStateTimer = setTimeout(saveAppState, 500);
}
function saveAppState() {
  clearTimeout(appStateTimer);
  appState.updatedAt = Date.now();
  return db.put('appState', appState).catch((err) => notebook.onError(err));
}
function saveAll() {
  notebook.saveNote();
  if (appState) saveAppState();
}

boot().catch((err) => {
  console.error(err);
  showFatal(`ノートを開けませんでした。\n${err && err.message ? err.message : err}`);
});

// 確認用（ブラウザの開発ツールから中身を見られるように）
window.__notes = { notebook, viewport, renderer, history };
