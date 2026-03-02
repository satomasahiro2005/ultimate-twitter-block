(function () {
  'use strict';

  const PROCESSED = 'data-twblock';
  const RESERVED_PATHS = new Set([
    'home', 'explore', 'search', 'notifications', 'messages',
    'settings', 'i', 'compose', 'login', 'logout', 'signup',
    'tos', 'privacy', 'about', 'help', 'jobs', 'download',
  ]);

  // ---- SVGアイコン（ストレージ or パッシブ取得で動的設定） ----
  let BLOCK_ICON = '';
  let MUTE_ICON = '';

  const CHECK_ICON =
    '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" fill="currentColor"/></svg>';

  function escapeAttr(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function getIcon(action) {
    return action === 'block' ? BLOCK_ICON : MUTE_ICON;
  }

  // ---- i18n ヘルパー（init時にキャッシュ、処理中はchrome.*不使用） ----
  const _msg = chrome.i18n.getMessage.bind(chrome.i18n);
  const i18n = {};
  function cacheI18n() {
    const keys = [
      'blockLabel', 'muteLabel', 'blockedStatus', 'mutedStatus',
      'unblockLabel', 'unmuteLabel', 'errorTimeout', 'errorOccurred',
    ];
    for (const k of keys) i18n[k] = _msg(k);
  }
  function msg(key, sub) {
    if (sub != null) return _msg(key, [sub]);
    return i18n[key] || _msg(key) || key;
  }

  // ---- 設定 ----
  let showBlock = true;
  let showMute = true;
  let confirmBlockFollowing = false;

  // ---- アイコン更新（ストレージ or パッシブ監視） ----
  let iconsExtracted = false;

  // ストレージから保存済みアイコンを読み込み
  function loadStoredIcons() {
    return new Promise((resolve) => {
      chrome.storage.local.get('icons', (data) => {
        if (data.icons) {
          if (data.icons.block) BLOCK_ICON = data.icons.block;
          if (data.icons.mute) MUTE_ICON = data.icons.mute;
          iconsExtracted = true;
        }
        resolve();
      });
    });
  }

  // 設定を読み込み
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get('settings', (data) => {
        if (data.settings) {
          showBlock = data.settings.showBlock !== false;
          showMute = data.settings.showMute !== false;
          confirmBlockFollowing = data.settings.confirmBlockFollowing === true;
        }
        resolve();
      });
    });
  }

  // 既存ボタンのアイコンを一括差し替え
  function replaceAllButtonIcons() {
    document.querySelectorAll('.twblock-block:not(.twblock-success)').forEach(btn => {
      btn.innerHTML = BLOCK_ICON;
    });
    document.querySelectorAll('.twblock-mute:not(.twblock-success)').forEach(btn => {
      btn.innerHTML = MUTE_ICON;
    });
  }

  // メニューアイテムからBlock/MuteのSVGを抽出する共通ロジック
  function extractIconsFromMenuItems(menuItems) {
    let foundBlock = false, foundMute = false;

    for (const item of menuItems) {
      const text = item.textContent || '';
      const pathEl = item.querySelector('svg path');
      if (!pathEl) continue;
      const d = pathEl.getAttribute('d');
      if (!d) continue;

      if (!foundBlock && /\bBlock\b|ブロック/.test(text) && !/Unblock|ブロック解除/.test(text)) {
        BLOCK_ICON = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="' + escapeAttr(d) + '" fill="currentColor"/></svg>';
        foundBlock = true;
      }
      if (!foundMute && /\bMute\b|ミュート/.test(text) && !/Unmute|ミュート解除|conversation|会話/.test(text)) {
        MUTE_ICON = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="' + escapeAttr(d) + '" fill="currentColor"/></svg>';
        foundMute = true;
      }
    }

    if (foundBlock || foundMute) {
      iconsExtracted = true;
      chrome.storage.local.set({ icons: { block: BLOCK_ICON, mute: MUTE_ICON } });
      replaceAllButtonIcons();
    }
  }

  // アクティブ取得: layersを非表示にしてメニューを開き、アイコン抽出後にメニュー要素をdisplay:noneで隠す
  let extractRetries = 0;
  function extractIconsOnce() {
    if (iconsExtracted) return;

    const caret = document.querySelector('[data-testid="caret"]');
    const layers = document.getElementById('layers');
    if (!caret || !layers) {
      if (++extractRetries <= 5) {
        setTimeout(extractIconsOnce, 2000);
      }
      return;
    }

    // メニュー展開前の#layers子要素を記録
    const childrenBefore = new Set(layers.children);

    // メニューを見えなくする
    layers.style.visibility = 'hidden';

    // MutationObserverでメニュー出現を即検知
    const mo = new MutationObserver(() => {
      const menuItems = document.querySelectorAll('[role="menuitem"]');
      if (menuItems.length === 0) return;

      mo.disconnect();
      extractIconsFromMenuItems(menuItems);

      // layersのvisibilityを復元
      layers.style.visibility = '';

      // メニューで追加された要素をdisplay:noneで隠す
      // DOM削除するとReactのfiber treeが壊れるため、非表示にするだけ
      for (const child of layers.children) {
        if (!childrenBefore.has(child)) {
          child.style.display = 'none';
        }
      }
    });

    mo.observe(layers, { childList: true, subtree: true });
    caret.click();

    // タイムアウト: 3秒以内に完了しなければ中止
    setTimeout(() => {
      mo.disconnect();
      layers.style.visibility = '';
    }, 3000);
  }

  // パッシブ監視: ユーザーが⋯メニューを開いた時にアイコンを抽出・更新
  function observeLayers() {
    const layers = document.getElementById('layers');
    if (!layers) {
      setTimeout(observeLayers, 1000);
      return;
    }

    const layersObserver = new MutationObserver(() => {
      if (!iconsExtracted) {
        setTimeout(() => {
          const menuItems = document.querySelectorAll('[role="menuitem"]');
          if (menuItems.length > 0) extractIconsFromMenuItems(menuItems);
        }, 300);
      }
    });

    layersObserver.observe(layers, { childList: true, subtree: true });
  }

  // ---- ページスクリプト注入 ----
  function injectPageScript() {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('pageScript.js');
    s.onload = function () { this.remove(); };
    (document.head || document.documentElement).appendChild(s);
  }

  // ---- メッセージブリッジ ----
  const pending = new Map();
  let reqId = 0;

  function sendAction(action, screenName) {
    return new Promise((resolve) => {
      const id = '__twb_' + ++reqId;
      pending.set(id, resolve);
      window.postMessage(
        { type: '__TWBLOCK_ACTION', action, screenName, requestId: id },
        '*'
      );
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ success: false, error: 'TIMEOUT', message: msg('errorTimeout') });
        }
      }, 15000);
    });
  }

  function checkFollowing(screenName) {
    return new Promise((resolve) => {
      const id = '__twb_' + ++reqId;
      pending.set(id, resolve);
      window.postMessage(
        { type: '__TWBLOCK_CHECK_FOLLOWING', screenName, requestId: id },
        '*'
      );
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ following: false });
        }
      }, 5000);
    });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.type !== '__TWBLOCK_RESULT') return;
    const cb = pending.get(e.data.requestId);
    if (cb) {
      pending.delete(e.data.requestId);
      cb(e.data);
    }
  });

  // ---- screen_name 抽出 ----
  function extractScreenName(el) {
    const links = el.querySelectorAll('a[role="link"]');
    for (const link of links) {
      const href = link.getAttribute('href');
      if (href && /^\/[A-Za-z0-9_]{1,15}$/.test(href)) {
        return href.substring(1);
      }
    }
    const spans = el.querySelectorAll('span');
    for (const span of spans) {
      const m = span.textContent.match(/^@([A-Za-z0-9_]{1,15})$/);
      if (m) return m[1];
    }
    const allLinks = el.querySelectorAll('a[href]');
    for (const link of allLinks) {
      const m = link.getAttribute('href')?.match(/^\/([A-Za-z0-9_]{1,15})\/status\//);
      if (m) return m[1];
    }
    return null;
  }

  function getProfileScreenName() {
    const m = window.location.pathname.match(/^\/([A-Za-z0-9_]{1,15})$/);
    if (m && !RESERVED_PATHS.has(m[1].toLowerCase())) return m[1];
    return null;
  }

  let myScreenName = null;
  function getMyScreenName() {
    if (myScreenName) return myScreenName;
    const navLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (navLink) {
      const href = navLink.getAttribute('href');
      if (href) { myScreenName = href.replace('/', ''); return myScreenName; }
    }
    return null;
  }

  // ---- トースト通知 ----
  // ---- Twitterアクセントカラー取得 ----
  const ACCENT_COLORS = new Set([
    'rgb(29, 155, 240)',   // Blue
    'rgb(255, 212, 0)',    // Yellow
    'rgb(249, 24, 128)',   // Pink
    'rgb(120, 86, 255)',   // Purple
    'rgb(255, 122, 0)',    // Orange
    'rgb(0, 186, 124)',    // Green
  ]);
  const DEFAULT_ACCENT = 'rgb(29, 155, 240)';
  let cachedAccentColor = null;

  function loadStoredAccentColor() {
    return new Promise((resolve) => {
      chrome.storage.local.get('accentColor', (data) => {
        if (data.accentColor && ACCENT_COLORS.has(data.accentColor)) {
          cachedAccentColor = data.accentColor;
        }
        resolve();
      });
    });
  }

  function getAccentColor() {
    const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
    if (activeTab) {
      for (const div of activeTab.querySelectorAll('div')) {
        const bg = getComputedStyle(div).backgroundColor;
        if (ACCENT_COLORS.has(bg)) {
          if (bg !== cachedAccentColor) {
            cachedAccentColor = bg;
            chrome.storage.local.set({ accentColor: bg });
          }
          return bg;
        }
      }
    }
    return cachedAccentColor || DEFAULT_ACCENT;
  }

  function showToast(message) {
    const existing = document.querySelector('.twblock-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'twblock-toast';
    toast.textContent = message;
    toast.style.backgroundColor = getAccentColor();
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('twblock-toast-hide');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ---- ツイート非表示（共通ロジック） ----
  function createHiddenBar(screenName, action, onUndo) {
    const bar = document.createElement('div');
    bar.className = 'twblock-hidden-bar';
    const statusLabel = action === 'block' ? msg('blockedStatus') : msg('mutedStatus');
    const undoLabel = action === 'block' ? msg('unblockLabel') : msg('unmuteLabel');
    const undoAction = action === 'block' ? 'unblock' : 'unmute';
    const undoToastKey = action === 'block' ? 'toastUnblocked' : 'toastUnmuted';
    bar.innerHTML =
      '<span class="twblock-hidden-label">' + statusLabel + ' @' + screenName + '</span>' +
      '<button class="twblock-show-btn">' + undoLabel + '</button>';

    bar.querySelector('.twblock-show-btn').addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '…';

      const result = await sendAction(undoAction, screenName);
      if (result.success) {
        onUndo(action);
        bar.remove();
        showToast(msg(undoToastKey, screenName));
      } else {
        btn.disabled = false;
        btn.textContent = undoLabel;
      }
    });

    return bar;
  }

  function hideTweet(tweet, screenName, action) {
    if (tweet.querySelector(':scope > .twblock-hidden-bar')) return;

    const contentWrapper = tweet.querySelector(':scope > div');
    if (!contentWrapper) return;
    contentWrapper.style.display = 'none';

    const bar = createHiddenBar(screenName, action, (act) => {
      contentWrapper.style.display = '';
      const twblockBtn = tweet.querySelector('.twblock-' + act + '.twblock-success');
      if (twblockBtn) {
        twblockBtn.classList.remove('twblock-success');
        twblockBtn.innerHTML = getIcon(act);
        twblockBtn._isActive = false;
      }
    });

    tweet.insertBefore(bar, tweet.firstChild);
  }

  // ---- 引用ツイート非表示 ----
  function hideQuotedTweet(quotedBlock, screenName, action) {
    if (quotedBlock.querySelector('.twblock-hidden-bar')) return;

    const hiddenChildren = [];
    for (const child of quotedBlock.children) {
      child.style.display = 'none';
      hiddenChildren.push(child);
    }

    const bar = createHiddenBar(screenName, action, (act) => {
      hiddenChildren.forEach(child => { child.style.display = ''; });
      const twblockBtn = quotedBlock.querySelector('.twblock-' + act + '.twblock-success');
      if (twblockBtn) {
        twblockBtn.classList.remove('twblock-success');
        twblockBtn.innerHTML = getIcon(act);
        twblockBtn._isActive = false;
      }
    });

    quotedBlock.insertBefore(bar, quotedBlock.firstChild);
  }

  // ---- ボタン作成 ----
  function createButtons(screenName, tweet) {
    if (!showBlock && !showMute) return null;

    const container = document.createElement('div');
    container.className = 'twblock-btn-container';
    container.setAttribute('data-screen-name', screenName);

    if (showBlock) {
      container.appendChild(createButton(screenName, 'block', msg('blockLabel'), tweet));
    }
    if (showMute) {
      container.appendChild(createButton(screenName, 'mute', msg('muteLabel'), tweet));
    }

    return container;
  }

  function createButton(screenName, action, label, tweet) {
    const btn = document.createElement('button');
    btn.className = 'twblock-btn twblock-' + action;
    btn.setAttribute('aria-label', label + ' @' + screenName);
    btn.title = label + ' @' + screenName;
    btn.innerHTML = getIcon(action);

    btn._isActive = false;
    const undoAction = action === 'block' ? 'unblock' : 'unmute';

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;

      btn.disabled = true;
      btn.classList.add('twblock-loading');

      const currentAction = btn._isActive ? undoAction : action;

      // フォロー中ユーザーのブロック確認
      if (confirmBlockFollowing && action === 'block' && !btn._isActive) {
        const followResult = await checkFollowing(screenName);
        if (followResult.following) {
          btn.classList.remove('twblock-loading');
          btn.disabled = false;
          if (!confirm(msg('confirmBlockFollowing', screenName))) return;
          btn.disabled = true;
          btn.classList.add('twblock-loading');
        }
      }

      const result = await sendAction(currentAction, screenName);
      btn.classList.remove('twblock-loading');

      if (result.success) {
        if (!btn._isActive) {
          btn._isActive = true;
          btn.classList.add('twblock-success');
          btn.innerHTML = CHECK_ICON;
          btn.title = (action === 'block' ? msg('blockedStatus') : msg('mutedStatus')) + ' @' + screenName;
          btn.disabled = false;
          chrome.runtime.sendMessage({ type: 'ACTION_COMPLETED', action }).catch(() => {});
          showToast(msg(action === 'block' ? 'toastBlocked' : 'toastMuted', screenName));

          // 引用ツイート内のボタンなら引用部分にバー表示
          const btnContainer = btn.closest('.twblock-btn-container');
          if (btnContainer && btnContainer._quotedBlock) {
            setTimeout(() => hideQuotedTweet(btnContainer._quotedBlock, screenName, action), 300);
          } else {
            const parentTweet = btn.closest('article[data-testid="tweet"]');
            if (parentTweet) {
              setTimeout(() => hideTweet(parentTweet, screenName, action), 300);
            }
          }
        } else {
          btn._isActive = false;
          btn.classList.remove('twblock-success');
          btn.innerHTML = getIcon(action);
          btn.title = label + ' @' + screenName;
          btn.disabled = false;
        }
      } else {
        btn.classList.add('twblock-error');
        btn.title = result.message || msg('errorOccurred');
        btn.disabled = false;
        setTimeout(() => btn.classList.remove('twblock-error'), 3000);
      }
    });

    return btn;
  }

  // ---- Grok/caretの行を見つけて、その中にボタンを挿入 ----
  function findGrokRow(tweet) {
    const caret = tweet.querySelector('[data-testid="caret"]');
    if (!caret) return null;

    let fallbackRow = null;
    let node = caret.parentElement;
    for (let i = 0; i < 8; i++) {
      if (!node || node === tweet) break;
      const cs = getComputedStyle(node);
      if (cs.display === 'flex' && cs.flexDirection === 'row') {
        const grokBtn = node.querySelector('[aria-label^="Grok"]');
        if (grokBtn) return { row: node, grokBtn, caret };
        // caretの直近の狭い行(67px)ではなく、アクションバー全体の広い行(>200px)を使う
        if (node.contains(caret) && node.offsetWidth > 200) {
          fallbackRow = node;
          break;
        }
      }
      node = node.parentElement;
    }
    return fallbackRow ? { row: fallbackRow, grokBtn: null, caret } : null;
  }

  // ---- RT: リツイーターと元投稿者を分離抽出 ----
  function extractRetweetInfo(tweet) {
    const sc = tweet.querySelector('[data-testid="socialContext"]');
    if (!sc) return null;
    const link = sc.closest('a[href]');
    if (!link) return null;
    const href = link.getAttribute('href');
    if (!href || !/^\/[A-Za-z0-9_]{1,15}$/.test(href)) return null;
    // "reposted"リンクの親flex-row と リンク要素自体
    let scRow = link.parentElement;
    for (let i = 0; i < 3; i++) {
      if (!scRow) break;
      const cs = getComputedStyle(scRow);
      if (cs.display === 'flex' && cs.flexDirection === 'row') break;
      scRow = scRow.parentElement;
    }
    // リンクの直接の親(flex-column) — ここをflex-rowにしてボタンを横並びにする
    const scLinkParent = link.parentElement;
    return { retweeter: href.substring(1), scRow, scLinkParent };
  }

  // ツイート本文エリアからscreen_nameを抽出（socialContext内のリンクを除外）
  function extractAuthorScreenName(tweet) {
    const userName = tweet.querySelector('[data-testid="User-Name"]');
    if (userName) {
      const result = extractScreenName(userName);
      if (result) return result;
    }
    return null;
  }

  // ---- ボタン挿入: タイムラインツイート ----
  function processTweets() {
    const me = getMyScreenName();
    const tweets = document.querySelectorAll(
      'article[data-testid="tweet"]:not([' + PROCESSED + '])'
    );

    tweets.forEach((tweet) => {
      // 内部DOMが未レンダリングならスキップ（次回再試行）
      if (!tweet.querySelector('[data-testid="User-Name"]') ||
          !tweet.querySelector('[data-testid="caret"]')) return;

      try {
        tweet.setAttribute(PROCESSED, '1');

        const rtInfo = extractRetweetInfo(tweet);

        // RT者のボタンを"reposted"行に挿入
        if (rtInfo && rtInfo.retweeter !== me && rtInfo.scLinkParent) {
          const rtButtons = createButtons(rtInfo.retweeter, tweet);
          if (rtButtons) {
            rtButtons.classList.add('twblock-tweet');
            rtButtons.classList.add('twblock-repost');
            rtInfo.scLinkParent.classList.add('twblock-repost-row');
            rtInfo.scLinkParent.appendChild(rtButtons);
          }
        }

        // 元投稿者のボタンをgrok/caret行に挿入
        const authorName = rtInfo ? extractAuthorScreenName(tweet) : extractScreenName(tweet);
        if (!authorName || authorName === me) {
          processQuotedTweet(tweet, me);
          return;
        }

        const grokInfo = findGrokRow(tweet);
        if (grokInfo) {
          const { row, grokBtn } = grokInfo;
          const buttons = createButtons(authorName, tweet);
          if (!buttons) return;
          buttons.classList.add('twblock-tweet');
          buttons.style.marginLeft = 'auto';
          buttons.style.paddingLeft = '4px';
          if (grokBtn) {
            let grokChild = null;
            for (const child of row.children) {
              if (child.contains(grokBtn)) { grokChild = child; break; }
            }
            if (grokChild) {
              row.insertBefore(buttons, grokChild);
            } else {
              row.insertBefore(buttons, row.firstChild);
            }
          } else {
            // caretを含む子要素の直前に挿入（⋯の左側に配置）
            let caretChild = null;
            for (const child of row.children) {
              if (child.contains(grokInfo.caret)) { caretChild = child; break; }
            }
            if (caretChild) {
              row.insertBefore(buttons, caretChild);
            } else {
              row.appendChild(buttons);
            }
          }
        }

        processQuotedTweet(tweet, me);
      } catch (e) {
        tweet.removeAttribute(PROCESSED);
      }
    });
  }

  // ---- ボタン挿入: 引用ツイート ----
  function processQuotedTweet(parentTweet, me) {
    const candidates = parentTweet.querySelectorAll(
      'div[role="link"], div[tabindex="0"]'
    );

    candidates.forEach((block) => {
      if (block.hasAttribute(PROCESSED)) return;
      if (block.closest('article') !== parentTweet) return;

      const userName = block.querySelector('[data-testid="User-Name"]');
      if (!userName) return;

      const parentUserName = parentTweet.querySelector('[data-testid="User-Name"]');
      if (userName === parentUserName) return;

      const qtScreenName = extractScreenName(block);
      if (!qtScreenName || qtScreenName === me) return;

      block.setAttribute(PROCESSED, '1');

      const buttons = createButtons(qtScreenName, null);
      if (!buttons) return;
      buttons._quotedBlock = block;

      // User-Nameの親flex-rowを探してインラインに挿入
      let targetRow = null;
      let node = userName.parentElement;
      for (let i = 0; i < 5; i++) {
        if (!node || node === block) break;
        const cs = getComputedStyle(node);
        if (cs.display === 'flex' && cs.flexDirection === 'row') {
          targetRow = node;
          break;
        }
        node = node.parentElement;
      }
      if (!targetRow) return;

      // targetRow〜block間の祖先コンテナを広げて全幅にする
      let ancestor = targetRow;
      while (ancestor && ancestor !== block) {
        ancestor.style.flexGrow = '1';
        ancestor.style.minWidth = '0';
        ancestor = ancestor.parentElement;
      }

      buttons.classList.add('twblock-tweet');
      buttons.style.marginLeft = 'auto';
      buttons.style.paddingLeft = '8px';
      targetRow.appendChild(buttons);
    });
  }

  // ---- ボタン挿入: 全Followボタン共通処理 ----
  function processFollowButtons() {
    const me = getMyScreenName();

    const followBtns = document.querySelectorAll(
      '[data-testid$="-follow"]:not([' + PROCESSED + ']), [data-testid$="-unfollow"]:not([' + PROCESSED + '])'
    );

    followBtns.forEach((btn) => {
      if (btn.closest('article[data-testid="tweet"]')) return;

      btn.setAttribute(PROCESSED, '1');

      const hoverCard = btn.closest('[data-testid="HoverCard"]');
      const userCell = btn.closest('[data-testid="UserCell"]');
      const placement = btn.closest('[data-testid="placementTracking"]');
      const isProfile = placement && !userCell && !hoverCard;

      let screenName;
      if (isProfile) {
        screenName = getProfileScreenName();
      } else {
        const container = userCell || hoverCard || btn.parentElement;
        screenName = extractScreenName(container);
      }
      if (!screenName || screenName === me) return;

      let targetRow = null;
      let startNode = isProfile ? placement.parentElement : btn.parentElement;
      for (let i = 0; i < 4; i++) {
        if (!startNode) break;
        const cs = getComputedStyle(startNode);
        if (cs.display === 'flex' && cs.flexDirection === 'row') {
          targetRow = startNode;
          break;
        }
        startNode = startNode.parentElement;
      }
      if (!targetRow || targetRow.querySelector('.twblock-btn-container')) return;

      const cssClass = isProfile ? 'twblock-profile' : 'twblock-sidebar';
      const buttons = createButtons(screenName, null);
      if (!buttons) return;
      buttons.classList.add(cssClass);

      let followChild = isProfile ? placement : null;
      if (!followChild) {
        for (const child of targetRow.children) {
          if (child.contains(btn)) { followChild = child; break; }
        }
      }
      if (!followChild) return;

      // React管理下のFollowボタンをreparentすると
      // プロフィールで「Something went wrong」が出る場合があるため、
      // FollowボタンのDOMは動かさず twblock ボタンのみを挿入する。
      targetRow.insertBefore(buttons, followChild);

      if (isProfile) {
        // ボタンコンテナを上揃えにして⋯/Followと縦位置を合わせる
        buttons.style.alignSelf = 'flex-start';
        // gapを⋯のmargin-right(8px)に揃える
        buttons.style.gap = '8px';
        buttons.style.marginRight = '8px';
      }
    });
  }

  // ---- 設定変更のリアルタイム反映 ----
  function applyButtonVisibility() {
    document.querySelectorAll('.twblock-block').forEach(btn => {
      btn.style.display = showBlock ? '' : 'none';
    });
    document.querySelectorAll('.twblock-mute').forEach(btn => {
      btn.style.display = showMute ? '' : 'none';
    });
    document.querySelectorAll('.twblock-btn-container').forEach(container => {
      const hasVisible = container.querySelector('.twblock-btn:not([style*="display: none"])');
      container.style.display = hasVisible ? '' : 'none';
    });
  }

  // ---- ボタン挿入: 検索候補(typeahead)のユーザー ----
  function processTypeahead() {
    const me = getMyScreenName();
    const items = document.querySelectorAll(
      '[data-testid="typeaheadRecentSearchesItem"]:not([' + PROCESSED + ']), [data-testid="typeaheadResult"]:not([' + PROCESSED + '])'
    );

    items.forEach((item) => {
      if (!item.querySelector('img')) return; // ユーザー項目のみ（検索クエリは除外）
      item.setAttribute(PROCESSED, '1');

      const screenName = extractScreenName(item);
      if (!screenName || screenName === me) return;

      // item > div > div(flex/row) > div(textArea) > div(flex/row): [名前] [Xボタン]
      const container = item.children[0]?.children[0];
      if (!container) return;
      const textArea = container.children[1];
      if (!textArea) return;
      const row = textArea.children[0];
      if (!row || row.querySelector('.twblock-btn-container')) return;

      const buttons = createButtons(screenName, null);
      if (!buttons) return;
      buttons.classList.add('twblock-typeahead');

      // Xボタン(最後の子)の前に挿入
      const xBtn = row.querySelector('button');
      if (xBtn) {
        row.insertBefore(buttons, xBtn);
      } else {
        row.appendChild(buttons);
      }
    });
  }

  // ---- メイン処理 ----
  function processAll() {
    processTweets();
    processFollowButtons();
    processTypeahead();
  }

  let rafScheduled = false;
  let trailingTimer = null;
  const observer = new MutationObserver(() => {
    // 次の描画フレームで即処理（ツイートと同フレームにボタン表示）
    if (!rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(() => {
        rafScheduled = false;
        processAll();
      });
    }
    // rAF時点で未完成だった要素を拾うフォールバック
    if (trailingTimer) clearTimeout(trailingTimer);
    trailingTimer = setTimeout(processAll, 200);
  });

  let lastUrl = location.href;
  function checkUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(processAll, 500);
    }
  }

  // ---- chrome.storage.onChanged: 設定変更をリアルタイム反映 ----
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.settings) {
      const newSettings = changes.settings.newValue || {};
      showBlock = newSettings.showBlock !== false;
      showMute = newSettings.showMute !== false;
      confirmBlockFollowing = newSettings.confirmBlockFollowing === true;
      applyButtonVisibility();
    }
    if (changes.icons) {
      const newIcons = changes.icons.newValue || {};
      if (newIcons.block) BLOCK_ICON = newIcons.block;
      if (newIcons.mute) MUTE_ICON = newIcons.mute;
      iconsExtracted = true;
      replaceAllButtonIcons();
    }
  });

  // ---- 初期化 ----
  async function init() {
    cacheI18n();
    injectPageScript();
    await loadStoredIcons();
    await loadSettings();
    await loadStoredAccentColor();
    setTimeout(processAll, 300);
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(checkUrlChange, 1000);
    observeLayers();

    // ストレージに未保存ならアクティブ取得（非表示で一瞬）
    if (!iconsExtracted) {
      setTimeout(extractIconsOnce, 2000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
