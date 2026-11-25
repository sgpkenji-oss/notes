// 確認画面・入力画面・選択画面（画面の中央に出る小さな窓）。
// すべて Promise を返す。外側をタップする・キャンセルを押すと null（確認画面は false）。
import { h } from './dom.js';

export function dialog({ title, message, body, buttons }) {
  return new Promise((resolve) => {
    const root = document.getElementById('dialog-root');
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(null);
      }
    };
    const btns = buttons.map((b) =>
      h('button', {
        type: 'button',
        class: `dlg-btn ${b.kind || ''}`,
        disabled: b.disabled,
        onclick: () => finish(b.value === undefined ? null : typeof b.value === 'function' ? b.value() : b.value),
      }, b.label));
    // body は、要素そのものか、結果を返す関数 finish を受け取って要素を返す関数
    const content = typeof body === 'function' ? body(finish) : body;
    const box = h('div', { class: 'dlg', role: 'dialog', 'aria-modal': 'true' },
      title && h('h2', { class: 'dlg-title' }, title),
      message && h('p', { class: 'dlg-message' }, message),
      content,
      h('div', { class: 'dlg-buttons' }, btns));
    const overlay = h('div', {
      class: 'dlg-overlay',
      onclick: (e) => { if (e.target === overlay) finish(null); },
    }, box);
    root.append(overlay);
    document.addEventListener('keydown', onKey, true);
    const first = box.querySelector('input, textarea');
    if (first) setTimeout(() => { first.focus(); first.select && first.select(); }, 30);
  });
}

export async function confirmDialog({ title, message, okLabel = 'OK', danger = false, cancelLabel = 'キャンセル' }) {
  const r = await dialog({
    title, message,
    buttons: [
      { label: cancelLabel, value: false },
      { label: okLabel, value: true, kind: danger ? 'danger' : 'primary' },
    ],
  });
  return r === true;
}

export function noticeDialog({ title, message, okLabel = '閉じる' }) {
  return dialog({ title, message, buttons: [{ label: okLabel, value: true, kind: 'primary' }] });
}

// 文字を入力してもらう。空のままでは決定できない
export function promptDialog({ title, message, value = '', placeholder = '', okLabel = '決定' }) {
  const input = h('input', { type: 'text', class: 'dlg-input', value, placeholder, maxlength: '80', autocomplete: 'off' });
  const result = dialog({
    title, message, body: input,
    buttons: [
      { label: 'キャンセル', value: null },
      { label: okLabel, kind: 'primary', value: () => input.value.trim() || null },
    ],
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      const v = input.value.trim();
      if (v) input.closest('.dlg').querySelector('.dlg-btn.primary').click();
    }
  });
  return result;
}

// 選択肢から1つ選ぶ。actions = [{ label, value, danger }]
export function actionSheet({ title, actions }) {
  return dialog({
    title,
    buttons: [
      ...actions.map((a) => ({ label: a.label, value: a.value, kind: a.danger ? 'danger' : 'sheet' })),
      { label: 'キャンセル', value: null },
    ],
  });
}
