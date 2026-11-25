// IndexedDB への保存と読み込み。
// 7種類のデータ（フォルダ・ノート・ページ・線・付箋・コネクタ・グループ枠）とアプリの状態を持つ。
// 第3段階以降で使う入れ物も最初から作っておく。

export const STORE_NAMES = ['folders', 'notes', 'pages', 'strokes', 'stickies', 'connectors', 'frames', 'appState'];

const DB_NAME = 'handwritten-notes';
const DB_VERSION = 1;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => upgrade(req.result, e.oldVersion);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('データベースを開けませんでした（別の画面で開いたままの可能性があります）'));
  });
  return dbPromise;
}

function upgrade(db, oldVersion) {
  if (oldVersion < 1) {
    const make = (name, indexes = []) => {
      const store = db.createObjectStore(name, { keyPath: 'id' });
      for (const key of indexes) store.createIndex(key, key);
    };
    make('folders', ['parentId']);
    make('notes', ['folderId']);
    make('pages', ['noteId']);
    make('strokes', ['pageId']);
    make('stickies', ['pageId']);
    make('connectors', ['pageId']);
    make('frames', ['pageId']);
    make('appState');
  }
  // 次に入れ物を変えるときは DB_VERSION を上げて、ここに if (oldVersion < 2) {...} を足す。
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('保存が中断されました'));
  });
}

export async function get(store, id) {
  const db = await openDB();
  return request(db.transaction(store).objectStore(store).get(id));
}

export async function getAllByIndex(store, index, key) {
  const db = await openDB();
  return request(db.transaction(store).objectStore(store).index(index).getAll(key));
}

export async function put(store, value) {
  return putMany(store, [value]);
}

export async function putMany(store, values) {
  if (!values.length) return;
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const v of values) os.put(v);
  return done(tx);
}

export async function deleteMany(store, ids) {
  if (!ids.length) return;
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const id of ids) os.delete(id);
  return done(tx);
}

// 複数の入れ物にまとめて書く（全部成功するか、全部取り消されるか）。
// ops = [{ store, put: 値 } または { store, delete: id }]
export async function writeBatch(ops) {
  if (!ops.length) return;
  const db = await openDB();
  const stores = [...new Set(ops.map((o) => o.store))];
  const tx = db.transaction(stores, 'readwrite');
  for (const op of ops) {
    const os = tx.objectStore(op.store);
    if ('put' in op) os.put(op.put);
    else os.delete(op.delete);
  }
  return done(tx);
}

export async function getAll(store) {
  const db = await openDB();
  return request(db.transaction(store).objectStore(store).getAll());
}

// 索引で絞った、主キーの一覧（消すときに使う）
export async function getKeysByIndex(store, index, key) {
  const db = await openDB();
  return request(db.transaction(store).objectStore(store).index(index).getAllKeys(key));
}

// 全データを1つのまとまりで読む（バックアップの書き出し用。途中で書き換わらないよう1つの読み取りで行う）
export async function dumpAll() {
  const db = await openDB();
  const tx = db.transaction(STORE_NAMES);
  const reqs = STORE_NAMES.map((name) => request(tx.objectStore(name).getAll()));
  const lists = await Promise.all(reqs);
  const out = {};
  STORE_NAMES.forEach((name, i) => { out[name] = lists[i]; });
  return out;
}

// 全データを入れ替える（バックアップの読み込み用）。全部成功するか、全部取り消される
export async function replaceAll(data) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAMES, 'readwrite');
  for (const name of STORE_NAMES) {
    const os = tx.objectStore(name);
    os.clear();
    for (const v of data[name] || []) os.put(v);
  }
  return done(tx);
}
