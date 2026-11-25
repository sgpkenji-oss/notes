// バックアップ：全データを1つのJSONファイルに書き出す／読み込んで全部入れ替える。
// 書き出しは共有メニュー（「ファイルに保存」でファイルアプリ・iCloud Driveに保存）。使えない環境ではダウンロード。
// ファイルの形：{ format, version, exportedAt, data: { folders, notes, pages, strokes, stickies, connectors, frames, appState } }
import * as db from './db.js';
import { dateStamp } from './dom.js';
import { SCHEMA_VERSION, migrateData } from './migrate.js';
import { dialog } from './dialogs.js';

export const BACKUP_FORMAT = 'handwritten-notes-backup';
export const BACKUP_INTERVAL_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

// 最後のバックアップ（なければアプリを使い始めた日）から何日たったか
export function daysSinceBackup(appState, nowMs = Date.now()) {
  const base = appState.lastBackupAt ?? appState.createdAt ?? nowMs;
  return Math.floor((nowMs - base) / DAY);
}

export function backupDue(appState, nowMs = Date.now()) {
  const base = appState.lastBackupAt ?? appState.createdAt ?? nowMs;
  return nowMs - base >= BACKUP_INTERVAL_DAYS * DAY;
}

export async function buildBackup() {
  const exportedAt = Date.now();
  const data = await db.dumpAll();
  // ファイルの中のアプリの状態には「このバックアップを取った日時」を入れておく
  data.appState = data.appState.map((a) => ({ ...a, lastBackupAt: exportedAt }));
  const json = JSON.stringify({ format: BACKUP_FORMAT, version: SCHEMA_VERSION, exportedAt, data });
  const blob = new Blob([json], { type: 'application/json' });
  return { blob, filename: `notes-backup-${dateStamp(exportedAt)}.json`, exportedAt, counts: summarize(data) };
}

function summarize(data) {
  const n = (name) => (data[name] || []).length;
  return {
    notes: n('notes'), pages: n('pages'), strokes: n('strokes'), folders: n('folders'),
    stickies: n('stickies'), connectors: n('connectors'), frames: n('frames'),
  };
}

function makeFile(blob, filename) {
  try {
    return new File([blob], filename, { type: 'application/json' });
  } catch {
    return null;
  }
}

function canShareFile(file) {
  return !!(file && navigator.canShare && navigator.share && navigator.canShare({ files: [file] }));
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// 'shared' | 'downloaded' | 'cancelled' | 'blocked'（ボタンを押した直後でないため共有を開けなかった）
async function send(blob, filename) {
  const file = makeFile(blob, filename);
  if (!canShareFile(file)) {
    download(blob, filename);
    return 'downloaded';
  }
  try {
    await navigator.share({ files: [file], title: filename });
    return 'shared';
  } catch (err) {
    if (err && err.name === 'AbortError') return 'cancelled';
    if (err && err.name === 'NotAllowedError') return 'blocked';
    throw err;
  }
}

// バックアップを書き出す。成功したら { exportedAt, counts }、取りやめなら null
export async function exportBackup() {
  const { blob, filename, exportedAt, counts } = await buildBackup();
  let status = await send(blob, filename);
  if (status === 'blocked') {
    // 準備に時間がかかって、ボタンを押した直後ではなくなった。もう1回押してもらう（共有はボタンの中で開く）
    let pending = null;
    const choice = await dialog({
      title: '書き出しの準備ができました',
      message: `「共有メニューを開く」を押して、「ファイルに保存」を選んでください。（${filename}）`,
      buttons: [
        { label: 'やめる', value: null },
        { label: 'ダウンロードにする', value: 'download' },
        { label: '共有メニューを開く', kind: 'primary', value: () => { pending = send(blob, filename); return 'share'; } },
      ],
    });
    if (choice === 'share') status = await pending;
    else if (choice === 'download') { download(blob, filename); status = 'downloaded'; }
    else status = 'cancelled';
  }
  if (status === 'cancelled' || status === 'blocked') return null;
  return { exportedAt, counts };
}

// ファイルの中身を調べて、新しい形にそろえたデータと概要を返す。読めないときは Error（日本語の説明つき）
export function parseBackup(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('このファイルはバックアップとして読めません（JSONの形ではありません）。');
  }
  if (!obj || obj.format !== BACKUP_FORMAT || typeof obj.data !== 'object' || !obj.data) {
    throw new Error('このファイルは、このアプリのバックアップではありません。');
  }
  if (typeof obj.version !== 'number' || obj.version > SCHEMA_VERSION) {
    throw new Error('このバックアップは、より新しい版のアプリで作られたため読み込めません。アプリを更新してください。');
  }
  for (const name of db.STORE_NAMES) {
    const list = obj.data[name];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((r) => !r || typeof r.id !== 'string')) {
      throw new Error(`バックアップの中身が壊れています（${name}）。`);
    }
  }
  if (!Array.isArray(obj.data.notes) || !obj.data.notes.length) {
    throw new Error('このバックアップにはノートが入っていません。');
  }
  const data = migrateData(obj.data);
  return { data, exportedAt: obj.exportedAt, counts: summarize(data) };
}

// 全部入れ替える（確認画面を出したあとに呼ぶ）
export async function restoreData(data) {
  await db.replaceAll(data);
}
