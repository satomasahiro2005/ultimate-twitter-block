document.addEventListener('DOMContentLoaded', () => {
  // i18n
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = chrome.i18n.getMessage(el.dataset.i18n);
  });

  const DEFAULT_SETTINGS = {
    showBlock: true,
    showMute: true,
    confirmBlockFollowing: true,
    reloadAfterProfileBlock: false,
  };

  const showBlockEl = document.getElementById('show-block');
  const showMuteEl = document.getElementById('show-mute');
  const confirmBlockFollowingEl = document.getElementById('confirm-block-following');
  const reloadAfterProfileBlockEl = document.getElementById('reload-after-profile-block');
  const resetStatsBtn = document.getElementById('reset-stats');
  const statBlockedEl = document.getElementById('stat-blocked');
  const statMutedEl = document.getElementById('stat-muted');
  const appVersionEl = document.getElementById('app-version');

  if (appVersionEl) {
    appVersionEl.textContent = 'v' + chrome.runtime.getManifest().version;
  }

  function renderSettings(settings) {
    const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    showBlockEl.checked = s.showBlock !== false;
    showMuteEl.checked = s.showMute !== false;
    confirmBlockFollowingEl.checked = s.confirmBlockFollowing !== false;
    reloadAfterProfileBlockEl.checked = s.reloadAfterProfileBlock === true;
  }

  function renderStats(stats) {
    const s = stats || { blocked: 0, muted: 0 };
    statBlockedEl.textContent = s.blocked || 0;
    statMutedEl.textContent = s.muted || 0;
  }

  // 設定読み込み
  chrome.storage.local.get(['settings', 'stats'], (data) => {
    renderSettings(data.settings);
    renderStats(data.stats);
  });

  // チェックボックス変更 → 即保存
  function saveSettings() {
    chrome.storage.local.set({
      settings: {
        showBlock: showBlockEl.checked,
        showMute: showMuteEl.checked,
        confirmBlockFollowing: confirmBlockFollowingEl.checked,
        reloadAfterProfileBlock: reloadAfterProfileBlockEl.checked,
      },
    });
  }

  [showBlockEl, showMuteEl, confirmBlockFollowingEl, reloadAfterProfileBlockEl]
    .forEach(el => el.addEventListener('change', saveSettings));

  // 統計リセット
  resetStatsBtn.addEventListener('click', () => {
    chrome.storage.local.set({ stats: { blocked: 0, muted: 0 } });
    renderStats({ blocked: 0, muted: 0 });
  });

  // 完全リセット
  document.getElementById('full-reset').addEventListener('click', () => {
    if (!confirm(chrome.i18n.getMessage('confirmReset'))) return;
    chrome.storage.local.clear(() => {
      chrome.storage.local.set({
        stats: { blocked: 0, muted: 0 },
        settings: Object.assign({}, DEFAULT_SETTINGS),
      }, () => location.reload());
    });
  });

  // ストレージ変更をリアルタイム反映
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area && area !== 'local') return;
    if (changes.stats) renderStats(changes.stats.newValue);
    if (changes.settings) renderSettings(changes.settings.newValue);
  });
});
