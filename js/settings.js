// 設定画面（ライブラリの歯車から開く）：入力方式、先読み表示、バックアップの書き出し・読み込み。
import { h, clear, formatDate } from './dom.js';
import { toast } from './notices.js';

export class Settings {
  // actions：getSettings() / setSetting(key, value) / getLastBackupAt() / exportBackup() / importFile(file) / close()
  constructor(actions) {
    this.a = actions;
    this.el = document.getElementById('settings');
    this.body = h('div', { class: 'settings-body' });
    this.fileInput = h('input', {
      type: 'file', accept: 'application/json,.json', hidden: true,
      onchange: async () => {
        const file = this.fileInput.files && this.fileInput.files[0];
        this.fileInput.value = '';
        if (file) await actions.importFile(file);
      },
    });
    this.el.append(
      h('header', { class: 'screen-head' },
        h('button', { type: 'button', class: 'head-button', onclick: () => actions.close() }, '← 戻る'),
        h('h2', { class: 'screen-title' }, '設定'),
        h('span', { class: 'head-spacer' })),
      this.body, this.fileInput);
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open() {
    this.el.hidden = false;
    this.render();
  }

  close() {
    this.el.hidden = true;
  }

  render() {
    const s = this.a.getSettings();
    clear(this.body);

    const radio = (name, value, label, desc, current, onPick) => h('label', { class: `choice${current === value ? ' on' : ''}` },
      h('input', { type: 'radio', name, value, checked: current === value, onchange: () => onPick(value) }),
      h('span', { class: 'choice-text' }, h('span', { class: 'choice-label' }, label), h('span', { class: 'choice-desc' }, desc)));

    this.body.append(
      h('section', { class: 'card' },
        h('h3', {}, '入力方式'),
        h('p', { class: 'card-note' }, 'ペンで書くときの入力の受け取り方です。書き心地テストの結果、標準は方式Bです。'),
        radio('input-mode', 'touch', '方式B（Touch Events）', '標準。書き心地テストで安定して書けた方式です。', s.inputMode, (v) => this.set('inputMode', v)),
        radio('input-mode', 'pointer', '方式A（Pointer Events）', '書けないことが多いときは使わないでください。iPadの「スクリブル」をオフにすると改善することがあります。', s.inputMode, (v) => this.set('inputMode', v))),

      h('section', { class: 'card' },
        h('h3', {}, '先読み表示'),
        h('p', { class: 'card-note' }, 'ペン先の少し先まで線を描き足して見せ、遅れを感じにくくします。線はきれいになりますが、補正されている違和感があります。標準はオフです。'),
        h('label', { class: 'switch-row' },
          h('span', {}, '先読み表示を使う'),
          h('input', { type: 'checkbox', class: 'switch', checked: !!s.prediction, onchange: (e) => this.set('prediction', e.target.checked) }))),

      h('section', { class: 'card' },
        h('h3', {}, 'バックアップ'),
        h('p', { class: 'card-note' }, '全部のノートを1つのファイルに書き出します。共有メニューから「ファイルに保存」を選ぶと、ファイルアプリ（iCloud Drive など）に保存できます。7日たつと、ノート画面の上にお知らせが出ます。'),
        h('p', { class: 'backup-last', id: 'backup-last' }, this.lastBackupText()),
        h('div', { class: 'card-buttons' },
          h('button', { type: 'button', class: 'primary-button', id: 'export-button', onclick: async (e) => {
            const button = e.currentTarget; // await のあとでは currentTarget が空になるので、先に取っておく
            button.disabled = true;
            try {
              await this.a.exportBackup();
            } catch (err) {
              console.error(err);
              toast('書き出せませんでした。もう一度お試しください');
            } finally {
              button.disabled = false;
              if (this.isOpen) this.render();
            }
          } }, 'バックアップを書き出す'),
          h('button', { type: 'button', class: 'plain-button', id: 'import-button', onclick: () => this.fileInput.click() }, 'バックアップを読み込む…')),
        h('p', { class: 'card-note small' }, '読み込むと、いまのデータはすべてバックアップの内容に入れ替わります（先に確認画面が出ます）。')));
  }

  lastBackupText() {
    const t = this.a.getLastBackupAt();
    return t ? `最後のバックアップ：${formatDate(t)}` : '最後のバックアップ：まだありません';
  }

  set(key, value) {
    this.a.setSetting(key, value);
    this.render();
  }
}
