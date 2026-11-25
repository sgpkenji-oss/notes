// お知らせの表示：ホーム画面に追加していないときの案内、保存の失敗など。
// あわせて、データを消されにくくする許可（navigator.storage.persist）を求める。

export function isStandalone() {
  return navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

export async function requestPersistentStorage() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch (err) {
    console.warn('persist の要求に失敗しました', err);
    return false;
  }
}

// ホーム画面から開いていないときだけ、案内を出す（閉じると、次に開くまで出さない）
export function setupInstallBanner(onResize) {
  const banner = document.getElementById('install-banner');
  if (isStandalone()) return;
  let dismissed = false;
  try {
    dismissed = sessionStorage.getItem('install-banner-dismissed') === '1';
  } catch {}
  if (dismissed) return;
  banner.hidden = false;
  banner.querySelector('button').addEventListener('click', () => {
    banner.hidden = true;
    try {
      sessionStorage.setItem('install-banner-dismissed', '1');
    } catch {}
    onResize();
  });
}

let toastTimer = null;
export function toast(message, ms = 3000) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function showFatal(message) {
  const el = document.getElementById('fatal');
  el.textContent = message;
  el.hidden = false;
}
