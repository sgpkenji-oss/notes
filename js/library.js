// ライブラリ画面：フォルダ（3階層まで）・タグ・ノート一覧・最近使ったノート・ピン留め・いまいる場所の表示。
// ノートの作成・名前変更・移動・タグ・ピン留め・削除ができる。削除は確認画面を出してから行う。
import * as db from './db.js';
import { h, clear, formatDate } from './dom.js';
import { MAX_FOLDER_DEPTH } from './model.js';
import { actionSheet, confirmDialog, dialog, noticeDialog, promptDialog } from './dialogs.js';
import {
  addFolder, canCreateFolderIn, childFolders, collectTags, folderDepth, folderPath,
  normalizeTags, removeFolder, renameFolder,
} from './store.js';

const RECENT_LIMIT = 20;
const STRIP_LIMIT = 6;

const ICON_FOLDER = '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const ICON_NOTE = '<svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 12h7M9 16h7"/></svg>';
const ICON_PIN = '<svg viewBox="0 0 24 24"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 15v6"/></svg>';
const ICON_RECENT = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';
const ICON_ALL = '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>';
const ICON_TAG = '<svg viewBox="0 0 24 24"><path d="M4 12V5a1 1 0 0 1 1-1h7l8 8-8 8z"/><circle cx="8.5" cy="8.5" r="1.2"/></svg>';

function icon(svg, cls = '') {
  const span = h('span', { class: `lib-icon ${cls}` });
  span.innerHTML = svg;
  return span;
}

export class Library {
  // actions：app.js から渡される、開いているノートと連動する操作
  //   openNote(id) / createNote({name, folderId}) / patchNote(id, patch) / deleteNote(id)
  //   isOpen(id) / openSettings() / close()
  constructor(actions) {
    this.a = actions;
    this.el = document.getElementById('library');
    this.view = { type: 'all' };
    this.folders = [];
    this.notes = [];
    this.collapsed = new Set();
    this.busy = false;

    this.crumbs = h('nav', { class: 'crumbs', 'aria-label': 'いまいる場所' });
    this.side = h('aside', { class: 'lib-side' });
    this.main = h('div', { class: 'lib-main' });
    this.el.append(
      h('header', { class: 'screen-head' },
        h('button', { type: 'button', class: 'head-button', onclick: () => actions.close() }, '← ノートに戻る'),
        this.crumbs,
        h('button', { type: 'button', class: 'head-button', id: 'library-settings', 'aria-label': '設定', onclick: () => actions.openSettings() }, '⚙ 設定')),
      h('div', { class: 'lib-body' }, this.side, this.main));
  }

  get isOpen() {
    return !this.el.hidden;
  }

  async open() {
    this.el.hidden = false;
    await this.reload();
  }

  close() {
    this.el.hidden = true;
  }

  async reload() {
    const [folders, notes] = await Promise.all([db.getAll('folders'), db.getAll('notes')]);
    this.folders = folders;
    this.notes = notes;
    // 消えたフォルダ・タグを見ていたら、一番上に戻す
    const v = this.view;
    if (v.type === 'folder' && !folders.some((f) => f.id === v.id)) this.view = { type: 'all' };
    if (v.type === 'tag' && !notes.some((n) => n.tags.includes(v.name))) this.view = { type: 'all' };
    this.render();
  }

  setView(view) {
    this.view = view;
    this.render();
    this.main.scrollTop = 0;
  }

  // ---- 描画 ----

  render() {
    this.renderCrumbs();
    this.renderSide();
    this.renderMain();
  }

  // いまいる場所の表示
  renderCrumbs() {
    clear(this.crumbs);
    const v = this.view;
    const part = (label, view, last) => (last
      ? h('span', { class: 'crumb current', 'aria-current': 'page' }, label)
      : h('button', { type: 'button', class: 'crumb', onclick: () => this.setView(view) }, label));
    const sep = () => h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›');
    const items = [];
    if (v.type === 'folder') {
      items.push(['ライブラリ', { type: 'all' }]);
      for (const f of folderPath(this.folders, v.id)) items.push([f.name, { type: 'folder', id: f.id }]);
    } else if (v.type === 'tag') {
      items.push(['ライブラリ', { type: 'all' }], [`タグ：${v.name}`, v]);
    } else if (v.type === 'recent') {
      items.push(['ライブラリ', { type: 'all' }], ['最近使ったノート', v]);
    } else if (v.type === 'pinned') {
      items.push(['ライブラリ', { type: 'all' }], ['ピン留め', v]);
    } else {
      items.push(['ライブラリ（すべてのノート）', v]);
    }
    items.forEach(([label, view], i) => {
      if (i) this.crumbs.append(sep());
      this.crumbs.append(part(label, view, i === items.length - 1));
    });
  }

  renderSide() {
    clear(this.side);
    const v = this.view;
    const navItem = (svg, label, view, count) => h('button', {
      type: 'button',
      class: `side-item${v.type === view.type && v.id === view.id && v.name === view.name ? ' active' : ''}`,
      onclick: () => this.setView(view),
    }, icon(svg), h('span', { class: 'side-label' }, label), count != null && h('span', { class: 'side-count' }, String(count)));

    this.side.append(
      navItem(ICON_ALL, 'すべてのノート', { type: 'all' }, this.notes.length),
      navItem(ICON_RECENT, '最近使ったノート', { type: 'recent' }),
      navItem(ICON_PIN, 'ピン留め', { type: 'pinned' }, this.notes.filter((n) => n.pinned).length));

    this.side.append(h('div', { class: 'side-title' }, 'フォルダ'));
    const tree = h('div', { class: 'tree' });
    this.renderTree(tree, null, 1);
    if (!tree.children.length) tree.append(h('div', { class: 'side-empty' }, 'フォルダはまだありません'));
    this.side.append(tree);

    const tags = collectTags(this.notes);
    this.side.append(h('div', { class: 'side-title' }, 'タグ'));
    if (!tags.length) this.side.append(h('div', { class: 'side-empty' }, 'タグはまだありません'));
    for (const t of tags) this.side.append(navItem(ICON_TAG, t.name, { type: 'tag', name: t.name }, t.count));
  }

  renderTree(container, parentId, depth) {
    for (const f of childFolders(this.folders, parentId)) {
      const hasChildren = childFolders(this.folders, f.id).length > 0;
      const collapsed = this.collapsed.has(f.id);
      const active = this.view.type === 'folder' && this.view.id === f.id;
      container.append(h('div', { class: `tree-row${active ? ' active' : ''}`, style: `padding-left:${6 + (depth - 1) * 16}px` },
        h('button', {
          type: 'button', class: `twisty${hasChildren ? '' : ' none'}`, 'aria-label': collapsed ? '開く' : '閉じる',
          onclick: () => {
            if (collapsed) this.collapsed.delete(f.id); else this.collapsed.add(f.id);
            this.renderSide();
          },
        }, hasChildren ? (collapsed ? '▸' : '▾') : ''),
        h('button', { type: 'button', class: 'tree-name', onclick: () => this.setView({ type: 'folder', id: f.id }) },
          icon(ICON_FOLDER), h('span', { class: 'side-label' }, f.name))));
      if (hasChildren && !collapsed) this.renderTree(container, f.id, depth + 1);
    }
  }

  // 右側：作成ボタン・ピン留めと最近の帯・ノート一覧
  renderMain() {
    clear(this.main);
    const v = this.view;
    const folderId = v.type === 'folder' ? v.id : null;

    const bar = h('div', { class: 'lib-actions' },
      h('button', { type: 'button', class: 'primary-button', onclick: () => this.newNote(folderId) }, '＋ 新しいノート'));
    if (v.type === 'all' || v.type === 'folder') {
      const canMake = v.type === 'all' || canCreateFolderIn(this.folders, v.id);
      bar.append(h('button', {
        type: 'button', class: 'plain-button', disabled: !canMake,
        title: canMake ? '' : `フォルダは${MAX_FOLDER_DEPTH}階層までです`,
        onclick: () => this.newFolder(folderId),
      }, '＋ 新しいフォルダ'));
    }
    if (v.type === 'folder') {
      bar.append(
        h('button', { type: 'button', class: 'plain-button', onclick: () => this.renameFolderAction(v.id) }, 'フォルダ名を変更'),
        h('button', { type: 'button', class: 'plain-button danger-text', onclick: () => this.deleteFolderAction(v.id) }, 'フォルダを削除'));
    }
    this.main.append(bar);
    if (v.type === 'folder' && !canCreateFolderIn(this.folders, v.id)) {
      this.main.append(h('p', { class: 'lib-hint' }, `フォルダは${MAX_FOLDER_DEPTH}階層までなので、この中には新しいフォルダを作れません。`));
    }

    // ピン留め・最近使ったノートの帯（一覧そのものがそれのときは出さない）
    if (v.type !== 'pinned') this.renderStrip('ピン留め', ICON_PIN, this.notes.filter((n) => n.pinned).sort(byUpdated), { type: 'pinned' });
    if (v.type !== 'recent') this.renderStrip('最近使ったノート', ICON_RECENT, [...this.notes].sort(byOpened), { type: 'recent' });

    // 中のフォルダ
    if (v.type === 'all' || v.type === 'folder') {
      const subs = childFolders(this.folders, folderId);
      if (subs.length) {
        const list = h('div', { class: 'folder-grid' });
        for (const f of subs) {
          const count = this.notes.filter((n) => n.folderId === f.id).length;
          list.append(h('button', { type: 'button', class: 'folder-card', onclick: () => this.setView({ type: 'folder', id: f.id }) },
            icon(ICON_FOLDER, 'big'), h('span', { class: 'fc-name' }, f.name), h('span', { class: 'fc-count' }, `${count}冊`)));
        }
        this.main.append(h('h3', { class: 'lib-heading' }, 'フォルダ'), list);
      }
    }

    const notes = this.notesForView();
    this.main.append(h('h3', { class: 'lib-heading' }, this.headingFor(), h('span', { class: 'lib-count' }, `${notes.length}冊`)));
    if (!notes.length) {
      this.main.append(h('p', { class: 'lib-empty' }, this.emptyMessage()));
    } else {
      const list = h('ul', { class: 'note-list' });
      for (const n of notes) list.append(this.noteRow(n));
      this.main.append(list);
    }
  }

  headingFor() {
    const v = this.view;
    if (v.type === 'recent') return '最近使ったノート';
    if (v.type === 'pinned') return 'ピン留めしたノート';
    if (v.type === 'tag') return `タグ「${v.name}」のノート`;
    if (v.type === 'folder') return 'このフォルダのノート';
    return 'フォルダに入れていないノート';
  }

  emptyMessage() {
    const v = this.view;
    if (v.type === 'recent') return 'まだノートを開いていません。';
    if (v.type === 'pinned') return 'ピン留めしたノートはありません。ノートの「⋯」から、ピン留めできます。';
    if (v.type === 'tag') return 'このタグのノートはありません。';
    return 'ノートはありません。「＋ 新しいノート」で作れます。';
  }

  notesForView() {
    const v = this.view;
    if (v.type === 'recent') return [...this.notes].sort(byOpened).slice(0, RECENT_LIMIT);
    if (v.type === 'pinned') return this.notes.filter((n) => n.pinned).sort(byUpdated);
    if (v.type === 'tag') return this.notes.filter((n) => n.tags.includes(v.name)).sort(byUpdated);
    const id = v.type === 'folder' ? v.id : null;
    return this.notes.filter((n) => (n.folderId ?? null) === id).sort(byUpdated);
  }

  renderStrip(title, svg, notes, view) {
    if (!notes.length) return;
    const row = h('div', { class: 'strip-row' });
    for (const n of notes.slice(0, STRIP_LIMIT)) {
      row.append(h('button', { type: 'button', class: 'strip-card', onclick: () => this.open_(n.id) },
        icon(ICON_NOTE), h('span', { class: 'strip-name' }, n.name)));
    }
    if (notes.length > STRIP_LIMIT) {
      row.append(h('button', { type: 'button', class: 'strip-more', onclick: () => this.setView(view) }, `ほか${notes.length - STRIP_LIMIT}冊 ›`));
    }
    this.main.append(h('div', { class: 'strip' }, h('div', { class: 'strip-title' }, icon(svg), title), row));
  }

  noteRow(n) {
    const place = n.folderId ? folderPath(this.folders, n.folderId).map((f) => f.name).join(' / ') : 'フォルダなし';
    const meta = h('div', { class: 'note-meta' },
      h('span', {}, place),
      n.tags.map((t) => h('span', { class: 'tag-chip' }, t)),
      h('span', { class: 'note-date' }, `更新 ${formatDate(n.updatedAt)}`));
    return h('li', { class: 'note-row' },
      h('button', { type: 'button', class: 'note-open', onclick: () => this.open_(n.id) },
        icon(ICON_NOTE, 'big'),
        h('span', { class: 'note-text' },
          h('span', { class: 'note-name' }, n.pinned && h('span', { class: 'pin-mark', 'aria-label': 'ピン留め中' }, '📌'), n.name, this.a.isOpen(n.id) && h('span', { class: 'open-badge' }, '開いています')),
          meta)),
      h('button', { type: 'button', class: 'more-button', 'aria-label': `${n.name}のメニュー`, onclick: () => this.noteMenu(n) }, '⋯'));
  }

  // ---- 操作 ----

  async open_(noteId) {
    await this.a.openNote(noteId);
  }

  guard(fn) {
    return async (...args) => {
      if (this.busy) return;
      this.busy = true;
      try {
        await fn(...args);
      } catch (err) {
        console.error(err);
        await noticeDialog({ title: '処理できませんでした', message: String(err && err.message ? err.message : err) });
      } finally {
        this.busy = false;
      }
    };
  }

  newNote = this.guard(async (folderId) => {
    const name = await promptDialog({ title: '新しいノート', value: '新しいノート', placeholder: 'ノートの名前', okLabel: '作成' });
    if (!name) return;
    await this.a.createNote({ name, folderId });
  });

  newFolder = this.guard(async (parentId) => {
    if (!canCreateFolderIn(this.folders, parentId)) {
      await noticeDialog({ title: '作れません', message: `フォルダは${MAX_FOLDER_DEPTH}階層までです。` });
      return;
    }
    const name = await promptDialog({ title: '新しいフォルダ', placeholder: 'フォルダの名前', okLabel: '作成' });
    if (!name) return;
    const f = await addFolder(this.folders, parentId, name);
    this.collapsed.delete(parentId);
    await this.reload();
    this.setView({ type: 'folder', id: f.id });
  });

  renameFolderAction = this.guard(async (id) => {
    const f = this.folders.find((x) => x.id === id);
    if (!f) return;
    const name = await promptDialog({ title: 'フォルダ名を変更', value: f.name, okLabel: '変更' });
    if (!name || name === f.name) return;
    await renameFolder(f, name);
    await this.reload();
  });

  deleteFolderAction = this.guard(async (id) => {
    const f = this.folders.find((x) => x.id === id);
    if (!f) return;
    const nNotes = this.notes.filter((n) => n.folderId === id).length;
    const nSub = this.folders.filter((x) => x.parentId === id).length;
    const moved = [];
    if (nNotes) moved.push(`ノート${nNotes}冊`);
    if (nSub) moved.push(`フォルダ${nSub}個`);
    const ok = await confirmDialog({
      title: `フォルダ「${f.name}」を削除しますか？`,
      message: moved.length
        ? `フォルダだけを削除します。中の${moved.join('と')}は消さず、ひとつ上の場所に移します。`
        : '空のフォルダを削除します。',
      okLabel: '削除', danger: true,
    });
    if (!ok) return;
    const parent = f.parentId;
    await removeFolder(this.folders, this.notes, id);
    // 開いているノートの写しも、移した場所に合わせる
    for (const n of this.notes) if (n.folderId === id) await this.a.syncOpenNote(n.id, { folderId: parent ?? null });
    this.view = parent ? { type: 'folder', id: parent } : { type: 'all' };
    await this.reload();
  });

  noteMenu = this.guard(async (n) => {
    const choice = await actionSheet({
      title: n.name,
      actions: [
        { label: '名前を変更', value: 'rename' },
        { label: 'フォルダを移動', value: 'move' },
        { label: 'タグを編集', value: 'tags' },
        { label: n.pinned ? 'ピン留めを外す' : 'ピン留めする', value: 'pin' },
        { label: '削除', value: 'delete', danger: true },
      ],
    });
    if (!choice) return;
    if (choice === 'rename') {
      const name = await promptDialog({ title: 'ノートの名前を変更', value: n.name, okLabel: '変更' });
      if (name && name !== n.name) await this.a.patchNote(n.id, { name });
    } else if (choice === 'move') {
      const target = await this.pickFolder(n);
      if (target !== undefined && target !== (n.folderId ?? null)) await this.a.patchNote(n.id, { folderId: target });
    } else if (choice === 'tags') {
      const tags = await this.editTags(n);
      if (tags) await this.a.patchNote(n.id, { tags });
    } else if (choice === 'pin') {
      await this.a.patchNote(n.id, { pinned: !n.pinned });
    } else if (choice === 'delete') {
      const ok = await confirmDialog({
        title: `ノート「${n.name}」を削除しますか？`,
        message: 'ページに書いた内容もすべて消え、元に戻せません。',
        okLabel: '削除', danger: true,
      });
      if (!ok) return;
      await this.a.deleteNote(n.id);
    }
    await this.reload();
  });

  // 移動先のフォルダを選ぶ。選ばなかったら undefined、「フォルダなし」は null
  async pickFolder(note) {
    const rows = [];
    const add = (parentId, depth) => {
      for (const f of childFolders(this.folders, parentId)) {
        rows.push({ id: f.id, name: f.name, depth });
        add(f.id, depth + 1);
      }
    };
    add(null, 0);
    const r = await dialog({
      title: `「${note.name}」の移動先`,
      body: (finish) => {
        const make = (label, id, depth) => {
          const current = (note.folderId ?? null) === id;
          return h('button', {
            type: 'button', class: `pick-row${current ? ' current' : ''}`, style: `padding-left:${14 + depth * 18}px`,
            onclick: () => finish({ id }),
          }, icon(id ? ICON_FOLDER : ICON_ALL), label, current && h('span', { class: 'pick-now' }, '（いま）'));
        };
        return h('div', { class: 'pick-list' }, make('フォルダなし（一番上）', null, 0), rows.map((x) => make(x.name, x.id, x.depth + 1)));
      },
      buttons: [{ label: 'キャンセル', value: null }],
    });
    return r ? r.id : undefined;
  }

  // タグを編集する（いまあるタグをタップで付け外し、新しいタグは入力して追加）
  async editTags(note) {
    const chosen = new Set(note.tags);
    const all = collectTags(this.notes).map((t) => t.name);
    for (const t of note.tags) if (!all.includes(t)) all.push(t);
    const chips = h('div', { class: 'tag-pick' });
    const input = h('input', { type: 'text', class: 'dlg-input', placeholder: '新しいタグ（まとめて入れるときは「,」で区切る）', maxlength: '60' });
    const renderChips = () => {
      clear(chips);
      for (const t of all) {
        chips.append(h('button', {
          type: 'button', class: `tag-toggle${chosen.has(t) ? ' on' : ''}`,
          onclick: () => { if (chosen.has(t)) chosen.delete(t); else chosen.add(t); renderChips(); },
        }, t));
      }
      if (!all.length) chips.append(h('span', { class: 'side-empty' }, 'まだタグがありません。下に入力して追加します。'));
    };
    renderChips();
    const addFromInput = () => {
      for (const t of normalizeTags(input.value.split(/[,、，\s]+/))) {
        if (!all.includes(t)) all.push(t);
        chosen.add(t);
      }
      input.value = '';
      renderChips();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addFromInput(); }
    });
    const body = h('div', {}, chips, h('div', { class: 'tag-add' }, input,
      h('button', { type: 'button', class: 'plain-button', onclick: addFromInput }, '追加')));
    const r = await dialog({
      title: 'タグを編集', body,
      buttons: [{ label: 'キャンセル', value: null }, { label: '決定', kind: 'primary', value: () => { addFromInput(); return [...chosen]; } }],
    });
    return r ? normalizeTags(r) : null;
  }
}

function byUpdated(a, b) {
  return b.updatedAt - a.updatedAt;
}
function byOpened(a, b) {
  return (b.openedAt || 0) - (a.openedAt || 0);
}
