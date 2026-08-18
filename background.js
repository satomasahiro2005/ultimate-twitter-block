// 統計の加算は content.js が直接ストレージに書く（Firefox の MV3 でも動くように）。
// ここは初回インストール時の既定値だけを受け持つ。
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== 'install') return;
  chrome.storage.local.set({
    stats: { blocked: 0, muted: 0 },
    settings: {
      showBlock: true,
      showMute: true,
      confirmBlockFollowing: true,
      reloadAfterProfileBlock: false,
    },
  });
});
