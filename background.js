const TARGET_URLS = [
  'https://x.com/*',
  'https://twitter.com/*',
];

async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: TARGET_URLS });

  for (const tab of tabs) {
    if (!tab.id) continue;

    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ['styles.css'],
      });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
    } catch (error) {
      // Ignore tabs that are unloading or otherwise unavailable.
    }
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({
      stats: { blocked: 0, muted: 0 },
      settings: { showBlock: true, showMute: true },
    });
  }

  injectIntoOpenTabs().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  injectIntoOpenTabs().catch(() => {});
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
