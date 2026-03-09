chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({
      stats: { blocked: 0, muted: 0 },
      settings: { showBlock: true, showMute: true },
    });
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'ACTION_COMPLETED') {
    chrome.storage.local.get('stats', (data) => {
      const stats = data.stats || { blocked: 0, muted: 0 };
      if (message.action === 'block') stats.blocked++;
      if (message.action === 'mute') stats.muted++;
      chrome.storage.local.set({ stats });
    });
  }
});
