document.addEventListener('DOMContentLoaded', () => {
  // i18n。既定はブラウザの表示言語（chrome.i18n）
  let localeTable = null;

  function translate() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n;
      el.textContent = (localeTable && localeTable[key] != null)
        ? localeTable[key]
        : chrome.i18n.getMessage(key);
    });
  }

  // 「Xに合わせる」は設定画面からは判定できないので、ブラウザの言語のままにする
  function applyOptionsLocale(language) {
    if (language !== 'ja' && language !== 'en' && language !== 'zh_CN') {
      if (!localeTable) return;
      localeTable = null;
      translate();
      return;
    }
    fetch(chrome.runtime.getURL('_locales/' + language + '/messages.json'))
      .then(res => res.json())
      .then(json => {
        const table = {};
        for (const [key, entry] of Object.entries(json)) table[key] = entry.message;
        localeTable = table;
        translate();
      })
      .catch(() => {});
  }

  translate();

  const DEFAULT_SETTINGS = {
    showBlock: true,
    showMute: true,
    confirmBlockFollowing: true,
    reloadAfterProfileBlock: false,
    language: 'x',
  };

  const showBlockEl = document.getElementById('show-block');
  const showMuteEl = document.getElementById('show-mute');
  const confirmBlockFollowingEl = document.getElementById('confirm-block-following');
  const reloadAfterProfileBlockEl = document.getElementById('reload-after-profile-block');
  const languageEl = document.getElementById('language');
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
    languageEl.value = s.language || 'x';
    applyOptionsLocale(s.language || 'x');
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
        language: languageEl.value,
      },
    });
  }

  [showBlockEl, showMuteEl, confirmBlockFollowingEl, reloadAfterProfileBlockEl, languageEl]
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
