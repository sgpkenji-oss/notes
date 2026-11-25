// アプリの起動と、各部品のつなぎ合わせ。
//   db.js        IndexedDB への保存
//   model.js     データの形
//   migrate.js   古い形のデータを新しい形に移し替える
//   store.js     フォルダ・ノートの作成と削除
//   notebook.js  開いているノートのデータ
//   viewport.js  表示位置（スクロール・拡大率）
//   renderer.js  確定した線を描く（下の canvas）
//   ink.js       書いている途中の線を描く（上の canvas）
//   geometry.js  線の形・消しゴムの当たり判定
//   input.js     ペンと指の入力（方式B：Touch Events が標準、方式A：Pointer Events も選べる）
//   tools.js / toolbar.js  道具の選択と道具の帯
//   lasso.js     なげなわ（線・付箋・枠の選択・移動・コピー・削除・色変更）
//   objects.js   付箋・コネクタ・グループ枠の操作
//   scene.js     ページの中身（枠・コネクタ・線・付箋）の描き方
//   tabs.js      タブの帯
//   library.js   ライブラリ画面（フォルダ・タグ・ノート一覧）
//   pagelist.js  ページ一覧
//   settings.js  設定画面
//   backup.js    バックアップの書き出し・読み込み
//   dialogs.js / dom.js  確認画面などの小さな窓、DOMの組み立て
//   history.js   元に戻す・やり直す（ノートごと）
//   notices.js   お知らせ
import * as db from './db.js';
import { createAppState, PAGE_WIDTH, MAX_TABS, FRAME_BAND, now } from './model.js';
import { SCHEMA_VERSION, migrateAppState, migrateFolder, migrateNote, migratePage } from './migrate.js';
import { Notebook } from './notebook.js';
import { Viewport } from './viewport.js';
import { Renderer } from './renderer.js';
import { Ink } from './ink.js';
import { InputController } from './input.js';
import { ToolState, ERASER_RADIUS, COLORS } from './tools.js';
import { Toolbar } from './toolbar.js';
import { History } from './history.js';
import { hitStroke } from './geometry.js';
import { Lasso } from './lasso.js';
import { ObjectTools, changeRegion } from './objects.js';
import { unionBounds } from './scene.js';
import { Tabs } from './tabs.js';
import { Library } from './library.js';
import { PageList } from './pagelist.js';
import { Settings } from './settings.js';
import { addNote, removeNoteTree } from './store.js';
import { backupDue, daysSinceBackup, exportBackup, parseBackup, restoreData } from './backup.js';
import { confirmDialog, noticeDialog } from './dialogs.js';
import { formatDate } from './dom.js';
import { setupInstallBanner, requestPersistentStorage, toast, showFatal } from './notices.js';

const stage = document.getElementById('stage');
const baseCanvas = document.getElementById('base-canvas');
const inkCanvas = document.getElementById('ink-canvas');
const pageNumber = document.getElementById('page-number');

const notebook = new Notebook();
const viewport = new Viewport();
const renderer = new Renderer(baseCanvas, viewport, notebook);
const ink = new Ink(inkCanvas, viewport);
const history = new History();
const lasso = new Lasso({ viewport, notebook, renderer, ink, history });
const objects = new ObjectTools({
  viewport, notebook, renderer, ink, history, stage, toast,
  beforeEdit: () => { if (lasso.hasSelection) lasso.clear(); },
});
lasso.commit = (pageId, before, after) => objects.commit(pageId, before, after);
let appState = null;
let tools = null;
let toolbar = null;
let input = null;
let erasing = null;
let tabsView = null;
let library = null;
let pageList = null;
let settingsScreen = null;
let switching = false;       // ノートの切り替え中
let savingStopped = false;   // バックアップの読み込み中は、古い写しを書き戻さない
const tabNames = new Map();  // タブに出すノートの名前

// ---- 起動 ----

// 保存されているデータを読み、古い形なら新しい形に移し替えて、アプリの状態を返す。ノートが1冊もなければ作る
async function loadAppState() {
  let state = await db.get('appState', 'app');
  let notes = await db.getAll('notes');
  const ops = [];
  if (!state || (state.schemaVersion || 0) < SCHEMA_VERSION) {
    // 第2段階までの形 → 第3段階の形
    notes = notes.map(migrateNote);
    for (const n of notes) ops.push({ store: 'notes', put: n });
    for (const f of await db.getAll('folders')) ops.push({ store: 'folders', put: migrateFolder(f) });
    // 第3段階まで → 第4段階：ページの種類（ノート／ボード）を必ず持たせる
    for (const p of await db.getAll('pages')) ops.push({ store: 'pages', put: migratePage(p) });
  }
  if (!notes.length) {
    // 初めて起動したとき：「最初のノート」を作る
    const note = await addNote({ name: '最初のノート' });
    notes = [note];
  }
  const latest = [...notes].sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))[0];
  state = migrateAppState(state || createAppState(latest.id), notes.map((n) => n.id));
  if (!state.tabs.length) {
    state.tabs = [latest.id];
    state.activeNoteId = latest.id;
    state.tabUsedAt = { [latest.id]: now() };
  }
  ops.push({ store: 'appState', put: state });
  await db.writeBatch(ops);
  for (const id of state.tabs) tabNames.set(id, notes.find((n) => n.id === id).name);
  return state;
}

// アプリの部品の受け渡し役（sw.js）。更新を次の起動で必ず反映し、オフラインでも起動できるようにする
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service Worker を登録できませんでした', err));
}

async function boot() {
  registerServiceWorker();
  setupInstallBanner(resize);
  requestPersistentStorage();

  appState = await loadAppState();

  notebook.onError = (err) => {
    console.error(err);
    toast('保存できませんでした。空き容量を確かめてください');
  };
  notebook.onPageLoaded = (pageId) => renderer.invalidatePage(pageId);

  tools = new ToolState(appState.toolState);
  tools.onChange = onToolChange;
  objects.stickyColor = () => tools.sticky.color;
  history.onChange = () => toolbar && toolbar.update();
  toolbar = new Toolbar({ tools, history, onUndo: undo, onRedo: redo, onAddPage: (paper) => addPageAfter(paper, viewport.currentPageIndex(), true) });
  setupLassoBar();
  setupScreens();

  await loadNote(appState.activeNoteId); // 前回の続きから開く（ページ・表示位置も元どおり）

  input = new InputController(stage, viewport, {
    stylusStart, stylusMove, stylusEnd,
    fingerStart, fingerMove, fingerEnd, fingerTap,
    viewChanged,
    gestureStart: () => {
      objects.closeMenu();
      renderer.setInteracting(true);
    },
    gestureEnd: () => {
      renderer.setInteracting(false);
      viewChanged();
    },
  });
  input.setMode(appState.settings.inputMode);

  ink.resize();
  renderer.resize();
  updatePageIndicator();
  updateBoardBar();
  updateBackupBanner();
  new ResizeObserver(resize).observe(stage);
  window.addEventListener('keydown', onKeyDown);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveAll();
    else updateBackupBanner();
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
  placeLassoBar();
  if (lasso.hasSelection) lasso.redraw();
  objects.closeMenu();
}

// ---- ノートの読み込み・切り替え ----

// ノートを開き、前回のページ・表示位置に合わせる（起動時もタブの切り替えでも使う）
async function loadNote(noteId) {
  switching = true;
  try {
    if (input) input.stopInertia();
    lasso.clear();
    objects.cancel();
    objects.closeMenu();
    ink.cancel();
    erasing = null;
    penMode = null;
    viewport.board = -1;
    await notebook.saveNote(); // 前のノートの保存を済ませる
    const note = await notebook.open(noteId);
    if (!notebook.pages.length) await notebook.addPage('ruled', -1);
    renderer.reset();
    history.use(noteId);
    viewport.pageCount = notebook.pages.length;
    viewport.zoom = 1;
    measure();
    const idx = notebook.pageIndexById(note.lastPageId);
    if (idx >= 0 && note.view) viewport.setAnchor({ pageIndex: idx, ...note.view });
    else viewport.setAnchor({ pageIndex: Math.max(0, idx), offsetY: -16 / viewport.scale, x: 0, zoom: 1 });
    // ボードページを開いたまま閉じたノートは、ボードから始める
    const boardIdx = note.boardPageId ? notebook.pageIndexById(note.boardPageId) : -1;
    if (boardIdx >= 0 && notebook.pages[boardIdx].kind === 'board') showBoard(boardIdx);
    else note.boardPageId = null;

    note.openedAt = now();
    tabNames.set(noteId, note.name);
    appState.activeNoteId = noteId;
    appState.tabUsedAt[noteId] = now();
    await notebook.saveNote();
    saveAppState();
  } finally {
    switching = false;
  }
  renderTabs();
  updatePageIndicator();
  updateBoardBar();
  renderer.render();
}

// ---- タブ ----
// 切り替え・開く・閉じるは1つずつ順番に行う（途中で別の操作が割り込まないように）

let chain = Promise.resolve();
function enqueue(fn) {
  const run = chain.then(fn);
  chain = run.catch((err) => console.error(err));
  return run;
}

function report(err) {
  console.error(err);
  toast('操作できませんでした。もう一度お試しください');
}

function renderTabs() {
  if (!tabsView) return;
  tabsView.render(
    appState.tabs.map((id) => ({ id, name: tabNames.get(id) || 'ノート' })),
    notebook.note ? notebook.note.id : null,
  );
}

function touchActiveTab() {
  if (notebook.note) appState.tabUsedAt[notebook.note.id] = now();
}

function mostRecentlyUsedTab(ids) {
  let best = null;
  for (const id of ids) if (best === null || (appState.tabUsedAt[id] || 0) > (appState.tabUsedAt[best] || 0)) best = id;
  return best;
}

function removeTabEntry(id) {
  appState.tabs = appState.tabs.filter((t) => t !== id);
  delete appState.tabUsedAt[id];
  tabNames.delete(id);
  history.drop(id);
}

// ノートをタブで開く（すでに開いているタブなら、そこに切り替える）。9つ目は、いちばん長く使っていないタブを閉じる
function openNote(noteId) {
  return enqueue(async () => {
    if (!appState.tabs.includes(noteId)) {
      const n = await db.get('notes', noteId);
      if (!n) throw new Error('ノートが見つかりません');
      touchActiveTab();
      while (appState.tabs.length >= MAX_TABS) {
        let oldest = null;
        for (const id of appState.tabs) if (oldest === null || (appState.tabUsedAt[id] || 0) < (appState.tabUsedAt[oldest] || 0)) oldest = id;
        toast(`タブが${MAX_TABS}つを超えたので、いちばん長く使っていない「${tabNames.get(oldest) || 'ノート'}」を閉じました`, 4500);
        removeTabEntry(oldest);
      }
      appState.tabs.push(noteId);
      tabNames.set(noteId, n.name);
    }
    if (!notebook.note || notebook.note.id !== noteId) {
      touchActiveTab();
      await loadNote(noteId);
    }
    closeScreens();
    renderTabs();
    saveAppState();
  });
}

function closeTab(noteId) {
  return enqueue(async () => {
    if (appState.tabs.length <= 1 || !appState.tabs.includes(noteId)) return;
    const wasActive = notebook.note && notebook.note.id === noteId;
    touchActiveTab();
    removeTabEntry(noteId);
    if (wasActive) await loadNote(mostRecentlyUsedTab(appState.tabs));
    renderTabs();
    saveAppState();
  });
}

// ---- ライブラリからの操作（開いているノートの写しとそろえる） ----

function patchNote(id, patch) {
  return enqueue(async () => {
    if (notebook.note && notebook.note.id === id) {
      Object.assign(notebook.note, patch, { updatedAt: now() });
      await notebook.saveNote();
    } else {
      const n = await db.get('notes', id);
      if (!n) return;
      await db.put('notes', { ...n, ...patch, updatedAt: now() });
    }
    if (patch.name !== undefined && appState.tabs.includes(id)) tabNames.set(id, patch.name);
    renderTabs();
  });
}

// データベース側だけ書き換えたノート（フォルダの削除で移したノートなど）を、開いている写しにも反映する
function syncOpenNote(id, patch) {
  if (notebook.note && notebook.note.id === id) Object.assign(notebook.note, patch);
}

function createNoteAndOpen({ name, folderId }) {
  return addNote({ name, folderId }).then((n) => openNote(n.id));
}

function deleteNote(noteId) {
  return enqueue(async () => {
    const wasActive = notebook.note && notebook.note.id === noteId;
    touchActiveTab();
    removeTabEntry(noteId);
    if (wasActive) {
      // 開いているノートを消すので、先に別のノートに切り替える
      let next = mostRecentlyUsedTab(appState.tabs);
      if (!next) {
        const others = (await db.getAll('notes')).filter((n) => n.id !== noteId).sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
        next = others.length ? others[0].id : (await addNote({ name: '最初のノート' })).id;
        appState.tabs.push(next);
      }
      await loadNote(next);
    }
    await removeNoteTree(noteId);
    renderTabs();
    saveAppState();
  });
}

// ---- 画面（ライブラリ・ページ一覧・設定） ----

function setupScreens() {
  tabsView = new Tabs({
    onSelect: (id) => openNote(id).catch(report),
    onClose: (id) => closeTab(id).catch(report),
    onLibrary: openLibrary,
  });
  library = new Library({
    openNote: (id) => openNote(id).catch(report),
    createNote: ({ name, folderId }) => createNoteAndOpen({ name, folderId }),
    patchNote, deleteNote, syncOpenNote,
    isOpen: (id) => appState.tabs.includes(id),
    openSettings: () => settingsScreen.open(),
    close: closeScreens,
  });
  settingsScreen = new Settings({
    getSettings: () => appState.settings,
    setSetting,
    getLastBackupAt: () => appState.lastBackupAt,
    exportBackup: runBackup,
    importFile: importBackupFile,
    close: () => settingsScreen.close(),
  });
  pageList = new PageList(notebook, {
    getCurrentIndex: () => viewport.currentPageIndex(),
    select: (i) => {
      closeScreens();
      goToPage(i);
    },
    add: (paper) => addPageAfter(paper, notebook.pages.length - 1, false),
    move: movePage,
    remove: removePage,
    close: closeScreens,
  });
  document.getElementById('page-list-button').addEventListener('click', () => pageList.open());
}

async function openLibrary() {
  await notebook.saveNote();
  await library.open();
}

function closeScreens() {
  library.close();
  pageList.close();
  settingsScreen.close();
}

function screenOpen() {
  return library.isOpen || pageList.isOpen || settingsScreen.isOpen;
}

function setSetting(key, value) {
  appState.settings[key] = value;
  if (key === 'inputMode' && input) input.setMode(value);
  saveAppStateSoon();
}

// ---- 表示位置 ----

function viewChanged() {
  renderer.requestRender();
  updatePageIndicator();
  if (switching) return;
  if (viewport.board >= 0) {
    // ボードページの表示位置は、ページごとに覚える（ノートページの並びの表示位置は変えない）
    const page = notebook.pages[viewport.board];
    const v = viewport.getBoardView();
    if (page) notebook.setBoardView(page.id, { x: round(v.x), y: round(v.y), zoom: round(v.zoom, 1000) });
  } else {
    const a = viewport.getAnchor();
    const page = notebook.pages[a.pageIndex];
    if (page) notebook.setView(page.id, { offsetY: round(a.offsetY), x: round(a.x), zoom: round(a.zoom, 1000) });
  }
  const [first, last] = viewport.visiblePageRange();
  notebook.keepAround(first, last);
  if (lasso.hasSelection) lasso.redraw();
}

function round(v, k = 10) {
  return Math.round(v * k) / k;
}

function updatePageIndicator() {
  pageNumber.textContent = `${viewport.currentPageIndex() + 1} / ${notebook.pages.length}${viewport.board >= 0 ? '（ボード）' : ''}`;
}

// ---- ボードページ ----
// ボードページを開くと、画面いっぱいにそのページだけを出す（2本指で上下左右に移動・拡大縮小。広さに上限なし）。
// 「← ノートページに戻る」で、開く前に見ていたノートページの位置に戻る。

const boardBar = document.getElementById('board-bar');
document.getElementById('board-back').addEventListener('click', () => {
  closeBoard();
  updateBoardBar();
});

function updateBoardBar() {
  boardBar.hidden = viewport.board < 0;
}

// ボードページを表示する（表示位置はページごとに覚えたもの）
function showBoard(index) {
  const page = notebook.pages[index];
  if (!page || page.kind !== 'board') return;
  lasso.clear();
  objects.cancel();
  objects.closeMenu();
  if (input) input.stopInertia();
  viewport.board = index;
  const v = notebook.boardView(page.id);
  if (v) viewport.setBoardView(v);
  else viewport.setBoardView({ x: -16 / viewport.fitScale, y: -16 / viewport.fitScale, zoom: 1 });
  renderer.clearTiles();
  if (notebook.note.boardPageId !== page.id) notebook.setBoardPage(page.id);
}

function openBoard(index) {
  showBoard(index);
  updateBoardBar();
  viewChanged();
  renderer.render();
}

// ノートページの並びに戻す（ボードを開く前に見ていた位置。無ければボードページの縮小表示の所）
function closeBoard() {
  if (viewport.board < 0) return;
  const boardIndex = viewport.board;
  lasso.clear();
  objects.cancel();
  objects.closeMenu();
  if (input) input.stopInertia();
  viewport.board = -1;
  viewport.zoom = 1;
  const note = notebook.note;
  const idx = notebook.pageIndexById(note.lastPageId);
  if (idx >= 0 && note.view) viewport.setAnchor({ pageIndex: idx, ...note.view });
  else viewport.setAnchor({ pageIndex: Math.min(boardIndex, notebook.pages.length - 1), offsetY: -16 / viewport.scale, x: 0, zoom: 1 });
  renderer.clearTiles();
  notebook.setBoardPage(null);
  viewChanged();
  renderer.render();
}

// ページ一覧などから、そのページを表示する（ボードページなら開く）
function goToPage(i) {
  const page = notebook.pages[i];
  if (!page) return;
  if (page.kind === 'board') {
    openBoard(i);
    return;
  }
  closeBoard();
  updateBoardBar();
  viewport.scrollToPage(i);
  viewChanged();
}

// ノートページの並びの中で、(sx, sy) がボードページの縮小表示の上なら、その番号
function boardPreviewAt(sx, sy) {
  if (viewport.board >= 0) return -1;
  const doc = viewport.toDoc(sx, sy);
  const i = viewport.pageIndexAt(doc.y);
  return i >= 0 && notebook.pages[i].kind === 'board' && doc.x >= 0 && doc.x <= PAGE_WIDTH ? i : -1;
}

// ---- 道具 ----

const TOOL_HINTS = {
  sticky: '付箋：置きたい所をタップ。付箋の上はそのまま書けます。上の帯をつまんで移動、右下の角で大きさを変えます',
  connector: 'コネクタ：付箋から付箋へなぞると、つながります。線をタップすると矢印と削除を選べます',
  frame: '枠：付箋をぐるっと囲むと、グループ枠になります。上辺に名前を書けます（上辺をつまんで移動）',
};
const hintShown = new Set();

let lastTool = null;
function onToolChange() {
  if (lastTool !== null && lastTool !== tools.tool) {
    lasso.clear();
    objects.cancel();
    objects.closeMenu();
    if (!ink.active) ink.clear();
    if (TOOL_HINTS[tools.tool] && !hintShown.has(tools.tool)) {
      hintShown.add(tools.tool);
      toast(TOOL_HINTS[tools.tool], 5000);
    }
  }
  lastTool = tools.tool;
  toolbar.update();
  updateLassoBar();
  appState.toolState = tools.toJSON();
  saveAppStateSoon();
}

// なげなわの帯（コピー・貼り付け・削除・色変更）
const lassoBar = document.getElementById('lasso-bar');

function setupLassoBar() {
  lastTool = tools.tool;
  const colors = lassoBar.querySelector('.lasso-colors');
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.color = c.key;
    b.setAttribute('aria-label', `${c.label}にする`);
    b.innerHTML = `<i style="background:${c.pen}"></i>`;
    colors.append(b);
  }
  lassoBar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.color) lasso.recolor(b.dataset.color);
    else if (b.dataset.act === 'copy') {
      if (lasso.copy()) toast('コピーしました。貼り付けで、見ているページに置けます');
    } else if (b.dataset.act === 'paste') lasso.paste();
    else if (b.dataset.act === 'delete') lasso.remove();
  });
  lasso.onChange = updateLassoBar;
  updateLassoBar();
}

function placeLassoBar() {
  lassoBar.style.top = `${Math.round(stage.getBoundingClientRect().top) + 10}px`;
}

function updateLassoBar() {
  lassoBar.hidden = tools.tool !== 'lasso';
  placeLassoBar();
  const has = lasso.hasSelection;
  for (const b of lassoBar.querySelectorAll('button')) {
    if (b.dataset.act === 'paste') b.disabled = !lasso.hasClipboard;
    else b.disabled = !has;
  }
}

// ---- ペン（書く・消す・なげなわ・付箋など） ----

let penMode = null;      // いまのペンの操作：'board-tap'（ボードページの縮小表示をタップ）など
let boardTap = null;

function stylusStart(sx, sy, force) {
  objects.closeMenu();
  penMode = null;
  const preview = boardPreviewAt(sx, sy);
  if (preview >= 0) {
    // ノートページの並びの中のボードページ：タップで開く
    penMode = 'board-tap';
    boardTap = { index: preview, sx, sy, moved: false };
    return;
  }
  if (tools.tool === 'lasso') {
    lasso.begin(sx, sy);
    return;
  }
  if (objects.penStart(sx, sy, tools.tool)) return; // 付箋の帯・角、コネクタ、枠など
  const doc = viewport.toDoc(sx, sy);
  if (tools.tool === 'eraser') {
    erasing = { removed: [], last: doc };
    eraseAlong(doc, doc);
    ink.drawEraser(sx, sy, ERASER_RADIUS);
    return;
  }
  const idx = viewport.pageIndexAt(doc.y);
  if (idx < 0) return;
  if (viewport.board < 0 && (doc.x < 0 || doc.x > PAGE_WIDTH)) return; // ページの外では書かない
  const page = notebook.pages[idx];
  const y = doc.y - viewport.pageTop(idx);
  // 付箋の上・枠の上辺なら、その中に書く（付箋・枠からの相対位置で持つ）
  const target = objects.writeTarget(page.id, doc.x, y);
  const style = { ...tools.strokeStyle(), stickyId: (target && target.stickyId) || null, frameId: (target && target.frameId) || null };
  ink.begin(page.id, idx, style, target ? target.origin : null);
  const o = ink.origin;
  ink.add(doc.x - (o ? o.x : 0), y - (o ? o.y : 0), force);
  ink.draw();
}

function stylusMove(sx, sy, force) {
  if (penMode === 'board-tap') {
    if (Math.hypot(sx - boardTap.sx, sy - boardTap.sy) > 12) boardTap.moved = true;
    return;
  }
  if (objects.active) {
    objects.move(sx, sy);
    return;
  }
  if (lasso.active) {
    lasso.move(sx, sy);
    return;
  }
  if (erasing) {
    const doc = viewport.toDoc(sx, sy);
    eraseAlong(erasing.last, doc);
    erasing.last = doc;
    ink.drawEraser(sx, sy, ERASER_RADIUS);
    return;
  }
  if (!ink.active) return;
  const doc = viewport.toDoc(sx, sy);
  const o = ink.origin;
  ink.add(doc.x - (o ? o.x : 0), doc.y - viewport.pageTop(ink.pageIndex) - (o ? o.y : 0), force);
  ink.draw(appState.settings.prediction);
}

function stylusEnd() {
  if (penMode === 'board-tap') {
    penMode = null;
    if (!boardTap.moved) openBoard(boardTap.index);
    boardTap = null;
    return;
  }
  if (objects.active) {
    objects.end();
    return;
  }
  if (lasso.active) {
    lasso.end();
    return;
  }
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

// ---- 指（付箋の帯・枠の上辺をつまむ、コネクタ・ボードページの縮小表示をタップ） ----

function fingerStart(sx, sy) {
  if (screenOpen() || ink.active || erasing || lasso.active || objects.active) return false;
  return objects.fingerStart(sx, sy);
}

function fingerMove(sx, sy) {
  objects.move(sx, sy);
}

function fingerEnd(cancelled) {
  if (cancelled) objects.cancel();
  else objects.end();
}

function fingerTap(sx, sy) {
  if (screenOpen()) return;
  if (objects.fingerTap(sx, sy)) return;
  const preview = boardPreviewAt(sx, sy);
  if (preview >= 0) openBoard(preview);
}

// 消しゴム：a→b の間で触れた線を、1本まるごと消す。
// 付箋の上では、その付箋の中の線だけを消す（下に隠れているページの線は消さない）。枠の上辺では、枠の名前の線も消す
function eraseAlong(a, b) {
  const r = ERASER_RADIUS / viewport.scale;
  const [first, last] = viewport.visiblePageRange();
  let changed = false;
  for (let i = first; i <= last; i++) {
    const page = notebook.pages[i];
    if (page.kind === 'board' && viewport.board < 0) continue; // ボードページの縮小表示
    const index = notebook.index(page.id);
    if (!index) continue;
    const top = viewport.pageTop(i);
    const ax = a.x, ay = a.y - top, bx = b.x, by = b.y - top;
    const hitIn = (list, o) => (list || []).filter((s) => hitStroke(s, ax - o.x, ay - o.y, bx - o.x, by - o.y, r));
    let over = null;
    for (let k = index.stickies.length - 1; k >= 0; k--) {
      const st = index.stickies[k];
      if (bx >= st.x && bx <= st.x + st.w && by >= st.y && by <= st.y + st.h) { over = st; break; }
    }
    let hits;
    if (over) {
      hits = hitIn(index.bySticky.get(over.id), over);
    } else {
      hits = hitIn(index.free, { x: 0, y: 0 });
      for (const f of index.frames) {
        if (bx >= f.x && bx <= f.x + f.w && by >= f.y && by <= f.y + Math.min(f.h, FRAME_BAND)) hits.push(...hitIn(index.byFrame.get(f.id), f));
      }
    }
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
  if (ink.active || erasing || lasso.active || objects.active) return;
  const e = history.undo();
  if (e) applyHistory(e, true);
}

function redo() {
  if (ink.active || erasing || lasso.active || objects.active) return;
  const e = history.redo();
  if (e) applyHistory(e, false);
}

function applyHistory(entry, isUndo) {
  lasso.clear(); // 選択はやめる（線が入れ替わるため）
  objects.closeMenu();
  if (entry.type === 'change') {
    // 付箋・コネクタ・枠・線をまとめて入れ替える
    const from = isUndo ? entry.after : entry.before;
    const to = isUndo ? entry.before : entry.after;
    const r0 = changeRegion(notebook.index(entry.pageId), [from, to]);
    notebook.applyChange(from, to);
    const r1 = changeRegion(notebook.index(entry.pageId), [from, to]);
    renderer.refresh(entry.pageId, r0 || r1 ? unionBounds(r0, r1) : null);
    return;
  }
  if (entry.type === 'replace') {
    const from = isUndo ? entry.after : entry.before;
    const to = isUndo ? entry.before : entry.after;
    notebook.replaceStrokes(from, to);
    for (const s of [...from, ...to]) renderer.invalidateStroke(s);
    return;
  }
  const add = (entry.type === 'add') !== isUndo;
  if (add) notebook.addStrokes(entry.strokes);
  else notebook.removeStrokes(entry.strokes);
  for (const s of entry.strokes) renderer.invalidateStroke(s);
}

function onKeyDown(e) {
  if (screenOpen() || document.querySelector('.dlg-overlay')) return;
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

// afterIndex のページのうしろに追加する。goTo が true なら、そのページを表示する
async function addPageAfter(paper, afterIndex, goTo) {
  try {
    const idx = await notebook.addPage(paper, afterIndex);
    viewport.pageCount = notebook.pages.length;
    if (viewport.board >= 0 && idx <= viewport.board) viewport.board++; // 開いているボードより前に足した
    if (goTo) goToPage(idx);
    viewChanged();
  } catch (err) {
    notebook.onError(err);
  }
}

// 見ているページを覚えておき、並べ替え・削除のあとも同じページを見続ける
function keepAnchorAround(change) {
  if (viewport.board >= 0) {
    // ボードページを開いているとき：そのボードを開いたままにする（消したときはノートページの並びに戻る）
    const boardId = notebook.pages[viewport.board].id;
    return change().then((result) => {
      viewport.pageCount = notebook.pages.length;
      const i = notebook.pageIndexById(boardId);
      if (i >= 0) viewport.board = i;
      else {
        viewport.board = Math.min(viewport.board, notebook.pages.length - 1);
        notebook.note.boardPageId = null;
        closeBoard();
        updateBoardBar();
      }
      viewChanged();
      return result;
    });
  }
  const anchor = viewport.getAnchor();
  const page = notebook.pages[anchor.pageIndex];
  return change().then((result) => {
    viewport.pageCount = notebook.pages.length;
    const idx = page ? notebook.pageIndexById(page.id) : -1;
    if (idx >= 0) viewport.setAnchor({ ...anchor, pageIndex: idx });
    else viewport.setAnchor({ pageIndex: Math.min(anchor.pageIndex, notebook.pages.length - 1), offsetY: -16 / viewport.scale, x: 0, zoom: viewport.zoom });
    viewChanged();
    return result;
  });
}

async function movePage(from, to) {
  lasso.clear();
  try {
    await keepAnchorAround(() => notebook.movePage(from, to));
  } catch (err) {
    notebook.onError(err);
  }
}

async function removePage(index) {
  lasso.clear();
  try {
    history.clear(); // 消したページの線を元に戻せないようにするため、このノートの履歴をまとめて手放す
    await keepAnchorAround(() => notebook.deletePage(index));
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
  if (savingStopped) return Promise.resolve();
  appState.updatedAt = Date.now();
  return db.put('appState', appState).catch((err) => notebook.onError(err));
}
function saveAll() {
  notebook.saveNote();
  if (appState) saveAppState();
}

// ---- バックアップ ----

const backupBanner = document.getElementById('backup-banner');
let backupSnoozed = false;
try {
  backupSnoozed = sessionStorage.getItem('backup-banner-later') === '1';
} catch {}

function updateBackupBanner() {
  if (!appState) return;
  const due = backupDue(appState) && !backupSnoozed;
  backupBanner.hidden = !due;
  if (due) {
    const days = daysSinceBackup(appState);
    document.getElementById('backup-banner-text').textContent = appState.lastBackupAt
      ? `最後のバックアップから${days}日たっています。`
      : `まだ一度もバックアップしていません（使い始めて${days}日）。`;
  }
}

document.getElementById('backup-banner-go').addEventListener('click', () => runBackup().catch(report));
document.getElementById('backup-banner-later').addEventListener('click', () => {
  backupSnoozed = true;
  try {
    sessionStorage.setItem('backup-banner-later', '1');
  } catch {}
  updateBackupBanner();
});

async function runBackup() {
  await notebook.saveNote();
  await saveAppState();
  const r = await exportBackup();
  if (!r) return null;
  appState.lastBackupAt = r.exportedAt;
  await saveAppState();
  updateBackupBanner();
  const extra = r.counts.stickies ? `・付箋${r.counts.stickies}枚` : '';
  toast(`バックアップを書き出しました（ノート${r.counts.notes}冊・ページ${r.counts.pages}枚${extra}）`, 4000);
  return r;
}

async function importBackupFile(file) {
  let parsed;
  try {
    parsed = parseBackup(await file.text());
  } catch (err) {
    await noticeDialog({ title: '読み込めません', message: err.message });
    return;
  }
  const nowNotes = (await db.getAll('notes')).length;
  const when = parsed.exportedAt ? `${formatDate(parsed.exportedAt)}に書き出した` : '日時不明の';
  const ok = await confirmDialog({
    title: 'バックアップを読み込みますか？',
    message:
      `いまのデータ（ノート${nowNotes}冊）はすべて消え、${when}バックアップ（ノート${parsed.counts.notes}冊・ページ${parsed.counts.pages}枚${parsed.counts.stickies ? `・付箋${parsed.counts.stickies}枚` : ''}）の内容に入れ替わります。元に戻せません。\n` +
      'いまのデータを残したいときは、先に「バックアップを書き出す」を行ってください。',
    okLabel: '入れ替える', danger: true,
  });
  if (!ok) return;
  // 入れ替えの途中で、メモリ上の古い写しが書き戻されないようにする
  savingStopped = true;
  notebook.disabled = true;
  clearTimeout(appStateTimer);
  clearTimeout(notebook.saveTimer);
  try {
    await restoreData(parsed.data);
  } catch (err) {
    console.error(err);
    savingStopped = false;
    notebook.disabled = false;
    await noticeDialog({ title: '読み込めませんでした', message: 'データはそのままです。空き容量を確かめて、もう一度お試しください。' });
    return;
  }
  location.reload();
}

boot().catch((err) => {
  console.error(err);
  showFatal(`ノートを開けませんでした。\n${err && err.message ? err.message : err}`);
});

// 確認用（ブラウザの開発ツールから中身を見られるように）
window.__notes = {
  notebook, viewport, renderer, history, lasso, objects,
  get appState() { return appState; },
};
