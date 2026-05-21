document.addEventListener('DOMContentLoaded', () => {
  // i18n
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = chrome.i18n.getMessage(el.dataset.i18n);
  });

  const showBlockEl = document.getElementById('show-block');
  const showMuteEl = document.getElementById('show-mute');
  const confirmBlockFollowingEl = document.getElementById('confirm-block-following');
  const resetStatsBtn = document.getElementById('reset-stats');
  const statBlockedEl = document.getElementById('stat-blocked');
  const statMutedEl = document.getElementById('stat-muted');
  const appVersionEl = document.getElementById('app-version');

  if (appVersionEl) {
    appVersionEl.textContent = 'v' + chrome.runtime.getManifest().version;
  }

  // 設定読み込み
  chrome.storage.local.get(['settings', 'stats'], (data) => {
    const settings = data.settings || { showBlock: true, showMute: true };
    showBlockEl.checked = settings.showBlock !== false;
    showMuteEl.checked = settings.showMute !== false;
    confirmBlockFollowingEl.checked = settings.confirmBlockFollowing === true;

    const stats = data.stats || { blocked: 0, muted: 0 };
    statBlockedEl.textContent = stats.blocked;
    statMutedEl.textContent = stats.muted;
  });

  // チェックボックス変更 → 即保存
  function saveSettings() {
    chrome.storage.local.set({
      settings: {
        showBlock: showBlockEl.checked,
        showMute: showMuteEl.checked,
        confirmBlockFollowing: confirmBlockFollowingEl.checked,
      },
    });
  }

  showBlockEl.addEventListener('change', saveSettings);
  showMuteEl.addEventListener('change', saveSettings);
  confirmBlockFollowingEl.addEventListener('change', saveSettings);

  // 統計リセット
  resetStatsBtn.addEventListener('click', () => {
    chrome.storage.local.set({ stats: { blocked: 0, muted: 0 } });
    statBlockedEl.textContent = '0';
    statMutedEl.textContent = '0';
  });

  // 完全リセット
  document.getElementById('full-reset').addEventListener('click', () => {
    if (!confirm(chrome.i18n.getMessage('confirmReset'))) return;
    chrome.storage.local.clear(() => {
      chrome.storage.local.set({
        stats: { blocked: 0, muted: 0 },
        settings: { showBlock: true, showMute: true },
      }, () => location.reload());
    });
  });

  // ストレージ変更をリアルタイム反映
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.stats) {
      const stats = changes.stats.newValue || { blocked: 0, muted: 0 };
      statBlockedEl.textContent = stats.blocked;
      statMutedEl.textContent = stats.muted;
    }
  });
});
