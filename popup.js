document.addEventListener('DOMContentLoaded', () => {
  // i18n
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = chrome.i18n.getMessage(el.dataset.i18n);
  });

  const blockedEl = document.getElementById('blocked-count');
  const mutedEl = document.getElementById('muted-count');

  function render(stats) {
    const s = stats || { blocked: 0, muted: 0 };
    blockedEl.textContent = s.blocked || 0;
    mutedEl.textContent = s.muted || 0;
  }

  chrome.storage.local.get('stats', (data) => render(data.stats));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area && area !== 'local') return;
    if (changes.stats) render(changes.stats.newValue);
  });

  document.getElementById('open-settings').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
});
