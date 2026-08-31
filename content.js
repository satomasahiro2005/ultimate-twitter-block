(function () {
  'use strict';

  if (window.__twblockInjected) return;
  window.__twblockInjected = true;

  const PROCESSED = 'data-twblock';
  const AUTHOR_ATTR = 'data-twblock-author';
  const QUOTED_ATTR = 'data-twblock-quoted';
  const RETWEETER_ATTR = 'data-twblock-retweeter';
  const RETRY_ATTR = 'data-twblock-retry';
  const HIDDEN_LAYER_ATTR = 'data-twblock-hidden-layer';
  const COLLAPSED_ATTR = 'data-twblock-collapsed';
  const MAX_TWEET_RETRIES = 5;
  const RESERVED_PATHS = new Set([
    'home', 'explore', 'search', 'notifications', 'messages',
    'settings', 'i', 'compose', 'login', 'logout', 'signup',
    'tos', 'privacy', 'about', 'help', 'jobs', 'download',
    'bookmarks', 'lists', 'topics', 'communities', 'connect_people',
    'intent', 'hashtag', 'account', 'notifications_timeline',
  ]);
  const PROFILE_SUBPATHS = new Set([
    'with_replies', 'media', 'likes', 'highlights', 'articles',
    'followers', 'following', 'verified_followers',
  ]);
  const ICON_CACHE_VERSION = 4;
  const BLOCK_MENU_LABEL_RE = /\bBlock\b|ブロック|屏蔽/;
  const UNBLOCK_MENU_LABEL_RE = /\bUnblock\b|ブロック解除|取消屏蔽/;
  const MUTE_MENU_LABEL_RE = /\bMute\b|ミュート|隐藏/;
  const UNMUTE_MENU_LABEL_RE = /\bUnmute\b|ミュート解除|取消隐藏/;
  const CONVERSATION_MENU_LABEL_RE = /\bconversation\b|会話|对话|此对话/;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICON_DEBUG_STORAGE_KEY = 'twblock:debug-icons';
  const MAX_ICON_DEBUG_HISTORY = 20;
  const MAX_ICON_SIGNATURES = 8;
  const BLOCK_ICON_SIGNATURES = new Set(['498278e7']);
  const MUTE_ICON_SIGNATURES = new Set(['d3853445', 'f46a0eeb']);
  const ICON_SHAPE_ATTRS = {
    path: ['d', 'transform', 'fill-rule', 'clip-rule', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit'],
    circle: ['cx', 'cy', 'r', 'transform', 'stroke-width'],
    ellipse: ['cx', 'cy', 'rx', 'ry', 'transform', 'stroke-width'],
    rect: ['x', 'y', 'width', 'height', 'rx', 'ry', 'transform', 'stroke-width'],
    line: ['x1', 'y1', 'x2', 'y2', 'transform', 'stroke-width', 'stroke-linecap'],
    polyline: ['points', 'transform', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'],
    polygon: ['points', 'transform', 'stroke-width', 'stroke-linejoin', 'fill-rule', 'clip-rule'],
  };
  const ICON_GROUP_ATTRS = ['transform'];
  const FALLBACK_BLOCK_ICON =
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.8" fill="none"/>' +
    '<path d="M7.5 7.5l9 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
    '</svg>';
  const FALLBACK_MUTE_ICON =
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
    '<path d="M0 0h24v24H0z" fill="none"/>' +
    '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" fill="currentColor"/>' +
    '</svg>';

  // ---- SVGアイコン（ストレージ or パッシブ取得で動的設定） ----
  let BLOCK_ICON = '';
  let MUTE_ICON = '';
  let iconDebugEnabled = false;
  const iconDebugHistory = [];

  const CHECK_ICON =
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" fill="currentColor"/></svg>';

  /* @twblock:store-start */
  // ---- ストレージ抽象（build.js がユーザースクリプト版で localStorage 実装に差し替える） ----
  const store = {
    get(keys) {
      return new Promise((resolve) => {
        try {
          chrome.storage.local.get(keys, (data) => resolve(data || {}));
        } catch (err) {
          resolve({});
        }
      });
    },
    set(obj) {
      return new Promise((resolve) => {
        try {
          chrome.storage.local.set(obj, () => resolve());
        } catch (err) {
          resolve();
        }
      });
    },
    remove(keys) {
      return new Promise((resolve) => {
        try {
          chrome.storage.local.remove(keys, () => resolve());
        } catch (err) {
          resolve();
        }
      });
    },
    onChanged(callback) {
      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area && area !== 'local') return;
          callback(changes);
        });
      } catch (err) {
        // ストレージイベントを購読できない環境では何もしない
      }
    },
    getPageScriptUrl() {
      return chrome.runtime.getURL('pageScript.js');
    },
  };
  /* @twblock:store-end */

  // ---- i18n（init時にキャッシュして、処理中は chrome.* を触らない） ----
  /* @twblock:i18n-start */
  // 既定の文言解決。拡張版は chrome.i18n（＝ブラウザの表示言語）を使う
  const _fallbackMsg = chrome.i18n.getMessage.bind(chrome.i18n);

  // 指定した言語の messages.json を読んで、キー→文字列の平坦な表にする。
  // $USER$ のようなプレースホルダは $1 に畳んでおく
  function fetchLocaleTable(locale) {
    return fetch(chrome.runtime.getURL('_locales/' + locale + '/messages.json'))
      .then((res) => res.json())
      .then((json) => {
        const table = {};
        for (const [key, entry] of Object.entries(json)) {
          let text = entry.message;
          if (entry.placeholders) {
            for (const [name, ph] of Object.entries(entry.placeholders)) {
              text = text.replace(new RegExp('\\$' + name + '\\$', 'gi'), ph.content);
            }
          }
          table[key] = text;
        }
        return table;
      })
      .catch(() => null);
  }
  /* @twblock:i18n-end */

  // 「Xの表示言語に合わせる」を選んだときだけ、ここに表が入る
  let localeTable = null;

  function applySubstitutions(text, subs) {
    if (!subs || !subs.length) return text;
    return text.replace(/\$(\d)/g, (whole, digit) => {
      const value = subs[Number(digit) - 1];
      return value === undefined ? whole : value;
    });
  }

  function _msg(key, subs) {
    if (localeTable && localeTable[key] != null) {
      return applySubstitutions(localeTable[key], subs);
    }
    return _fallbackMsg(key, subs);
  }

  const i18n = {};
  // 拡張の更新直後は古いコンテンツスクリプトが残り、chrome.* が
  // "Extension context invalidated" を投げる。文言が出ないだけで済ませる。
  function cacheI18n() {
    for (const k of I18N_CACHE_KEYS) {
      try { i18n[k] = _msg(k); } catch (err) { i18n[k] = ''; }
    }
  }
  function msg(key, sub) {
    try {
      if (sub != null) return _msg(key, [String(sub)]);
      return i18n[key] || _msg(key) || key;
    } catch (err) {
      return i18n[key] || key;
    }
  }

  // ---- 表示言語 ----
  // 'x' = Xの表示言語に合わせる / 'browser' = ブラウザに任せる / それ以外は固定
  const SUPPORTED_LOCALES = ['en', 'ja', 'zh_CN'];

  function normalizeLocale(tag) {
    const t = String(tag || '').toLowerCase();
    if (t.indexOf('ja') === 0) return 'ja';
    if (t.indexOf('zh') === 0) return 'zh_CN';
    if (t.indexOf('en') === 0) return 'en';
    return null;
  }

  // X の表示言語。<html lang> が本命で、取れなければ lang cookie
  function getSiteLocale() {
    const fromHtml = normalizeLocale(document.documentElement.lang);
    if (fromHtml) return fromHtml;
    const cookie = document.cookie.match(/(?:^|;\s*)lang=([^;]*)/);
    return cookie ? normalizeLocale(decodeURIComponent(cookie[1])) : null;
  }

  function resolveLocale() {
    if (language === 'browser') return null;
    if (SUPPORTED_LOCALES.indexOf(language) !== -1) return language;
    return getSiteLocale();
  }

  // 表を読み直して、表示中の文言も差し替える
  let appliedLocale = '(初期)';
  async function applyLocale() {
    const locale = resolveLocale();
    const key = locale || '(既定)';
    if (key === appliedLocale) return;
    appliedLocale = key;
    localeTable = locale ? await fetchLocaleTable(locale) : null;
    cacheI18n();
  }

  const I18N_CACHE_KEYS = [
    'blockLabel', 'muteLabel', 'blockedStatus', 'mutedStatus',
    'unblockLabel', 'unmuteLabel', 'switchToBlockLabel', 'forceShowLabel',
    'reloadLabel',
    'errorTimeout', 'errorOccurred', 'errorNoAuth', 'errorForbidden',
    'errorRateLimited', 'errorNetwork', 'errorHttp',
    'toastBlocked', 'toastMuted', 'toastUnblocked', 'toastUnmuted',
    'toastStateSynced', 'confirmBlockFollowing', 'confirmBlockUnknown',
  ];

  /* @twblock:css-start */
  // 拡張機能版は manifest の content_scripts.css で読み込むため何もしない
  function injectCSS() {}
  /* @twblock:css-end */

  function normalizeSpace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function getIconSignatureSet(action) {
    return action === 'block' ? BLOCK_ICON_SIGNATURES : MUTE_ICON_SIGNATURES;
  }

  function rememberIconSignature(action, signature) {
    if (!signature) return;
    const set = getIconSignatureSet(action);
    if (set.has(signature)) return;
    // 誤マッチした署名が無限に溜まらないよう上限を設ける
    if (set.size >= MAX_ICON_SIGNATURES) {
      const oldest = set.values().next().value;
      set.delete(oldest);
    }
    set.add(signature);
  }

  function loadStoredIconSignatures(signatures) {
    if (!signatures || typeof signatures !== 'object') return;
    ['block', 'mute'].forEach((action) => {
      const values = Array.isArray(signatures[action]) ? signatures[action] : [];
      values.forEach((value) => {
        if (typeof value === 'string' && value) rememberIconSignature(action, value);
      });
    });
  }

  function getStoredIconSignatures() {
    return {
      block: Array.from(BLOCK_ICON_SIGNATURES),
      mute: Array.from(MUTE_ICON_SIGNATURES),
    };
  }

  function persistIcons() {
    store.set({
      icons: {
        version: ICON_CACHE_VERSION,
        block: BLOCK_ICON,
        mute: MUTE_ICON,
        signatures: getStoredIconSignatures(),
      },
    });
  }

  function getPaintState(node, attrName) {
    const tag = node.tagName.toLowerCase();
    const value = normalizeSpace(node.getAttribute(attrName));
    if (attrName === 'fill') {
      const strokeValue = normalizeSpace(node.getAttribute('stroke'));
      const hasVisibleStroke = strokeValue && strokeValue !== 'none';
      if (node.hasAttribute('fill')) return value === 'none' ? 'none' : 'paint';
      return (tag === 'line' || hasVisibleStroke) ? 'none' : 'paint';
    }
    if (!node.hasAttribute('stroke')) return 'none';
    return value === 'none' ? 'none' : 'paint';
  }

  function appendIconSignatureParts(node, parts) {
    Array.from(node.children).forEach((child) => {
      const tag = child.tagName.toLowerCase();
      if (tag === 'g') {
        const transform = normalizeSpace(child.getAttribute('transform'));
        if (transform) parts.push('g:transform=' + transform);
        appendIconSignatureParts(child, parts);
        if (transform) parts.push('/g');
        return;
      }

      const attrs = ICON_SHAPE_ATTRS[tag];
      if (!attrs) return;

      const attrParts = [];
      attrs.forEach((attr) => {
        const value = normalizeSpace(child.getAttribute(attr));
        if (value) attrParts.push(attr + '=' + value);
      });
      attrParts.push('fill=' + getPaintState(child, 'fill'));
      attrParts.push('stroke=' + getPaintState(child, 'stroke'));
      parts.push(tag + ':' + attrParts.join(','));
    });
  }

  function getIconSignature(svgEl) {
    if (!svgEl) return '';
    const parts = ['viewBox=' + (normalizeSpace(svgEl.getAttribute('viewBox')) || '0 0 24 24')];
    appendIconSignatureParts(svgEl, parts);
    return hashString(parts.join('|'));
  }

  function copySvgAttributes(source, target, attrs) {
    attrs.forEach((attr) => {
      const value = normalizeSpace(source.getAttribute(attr));
      if (value) target.setAttribute(attr, value);
    });
  }

  function applySanitizedPaint(source, target) {
    const tag = source.tagName.toLowerCase();
    const fillValue = normalizeSpace(source.getAttribute('fill'));
    const strokeValue = normalizeSpace(source.getAttribute('stroke'));
    const hasVisibleStroke = strokeValue && strokeValue !== 'none';

    if (source.hasAttribute('fill')) {
      target.setAttribute('fill', fillValue === 'none' ? 'none' : 'currentColor');
    } else if (tag === 'line' || hasVisibleStroke) {
      target.setAttribute('fill', 'none');
    } else {
      target.setAttribute('fill', 'currentColor');
    }

    if (source.hasAttribute('stroke')) {
      target.setAttribute('stroke', strokeValue === 'none' ? 'none' : 'currentColor');
    }
  }

  function sanitizeSvgNode(node) {
    const tag = node.tagName.toLowerCase();

    if (tag === 'g') {
      const group = document.createElementNS(SVG_NS, 'g');
      copySvgAttributes(node, group, ICON_GROUP_ATTRS);
      Array.from(node.children).forEach((child) => {
        const sanitizedChild = sanitizeSvgNode(child);
        if (sanitizedChild) group.appendChild(sanitizedChild);
      });
      return (group.childNodes.length || group.attributes.length) ? group : null;
    }

    const attrs = ICON_SHAPE_ATTRS[tag];
    if (!attrs) return null;

    const sanitized = document.createElementNS(SVG_NS, tag);
    copySvgAttributes(node, sanitized, attrs);
    applySanitizedPaint(node, sanitized);
    return sanitized;
  }

  function buildInlineIconSvg(svgEl) {
    if (!svgEl) return '';
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', normalizeSpace(svgEl.getAttribute('viewBox')) || '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('aria-hidden', 'true');
    Array.from(svgEl.children).forEach((child) => {
      const sanitizedChild = sanitizeSvgNode(child);
      if (sanitizedChild) svg.appendChild(sanitizedChild);
    });
    return svg.childNodes.length ? svg.outerHTML : '';
  }

  function getMenuItemLabelMatch(text) {
    if (BLOCK_MENU_LABEL_RE.test(text) && !UNBLOCK_MENU_LABEL_RE.test(text)) return 'block';
    if (MUTE_MENU_LABEL_RE.test(text) &&
        !UNMUTE_MENU_LABEL_RE.test(text) &&
        !CONVERSATION_MENU_LABEL_RE.test(text)) return 'mute';
    return '';
  }

  function describeMenuItem(item) {
    const text = normalizeSpace(item.textContent || '');
    const svgEl = item.querySelector('svg');
    const signature = getIconSignature(svgEl);
    let signatureMatch = '';
    if (signature) {
      if (BLOCK_ICON_SIGNATURES.has(signature)) signatureMatch = 'block';
      else if (MUTE_ICON_SIGNATURES.has(signature)) signatureMatch = 'mute';
    }

    return {
      text,
      signature,
      signatureMatch,
      labelMatch: getMenuItemLabelMatch(text),
      matchedBy: '',
      iconMarkup: buildInlineIconSvg(svgEl),
    };
  }

  function buildMenuIconSnapshot(menuItems, reason) {
    return {
      reason,
      timestamp: new Date().toISOString(),
      entries: Array.from(menuItems).map(describeMenuItem),
    };
  }

  function loadIconDebugFlag() {
    try {
      iconDebugEnabled = window.localStorage.getItem(ICON_DEBUG_STORAGE_KEY) === '1';
    } catch (err) {
      iconDebugEnabled = false;
    }
  }

  function setIconDebugEnabled(enabled) {
    iconDebugEnabled = Boolean(enabled);
    try {
      if (iconDebugEnabled) window.localStorage.setItem(ICON_DEBUG_STORAGE_KEY, '1');
      else window.localStorage.removeItem(ICON_DEBUG_STORAGE_KEY);
    } catch (err) {
      // Ignore storage access errors.
    }
    console.info('[twblock] icon debug ' + (iconDebugEnabled ? 'enabled' : 'disabled'));
  }

  function logIconDebugSnapshot(snapshot) {
    const rows = snapshot.entries.map((entry) => ({
      text: entry.text,
      signature: entry.signature,
      signatureMatch: entry.signatureMatch,
      labelMatch: entry.labelMatch,
      matchedBy: entry.matchedBy,
    }));
    console.groupCollapsed('[twblock] icon debug: ' + snapshot.reason);
    if (rows.length) console.table(rows);
    else console.info('[twblock] no menu items found');
    console.log(snapshot);
    console.groupEnd();
  }

  // 履歴を読めるのはデバッグイベント経由だけなので、切っている間は溜めない。
  // 有効化: localStorage.twblock_icon_debug = '1' → リロード、
  // その後 window.dispatchEvent(new CustomEvent('twblock:debug-icons', { detail: { action: 'history' } }))
  function recordIconDebugSnapshot(snapshot) {
    if (!iconDebugEnabled) return;
    iconDebugHistory.push(snapshot);
    if (iconDebugHistory.length > MAX_ICON_DEBUG_HISTORY) {
      iconDebugHistory.shift();
    }
    logIconDebugSnapshot(snapshot);
  }

  function dumpCurrentMenuIcons(reason) {
    const snapshot = buildMenuIconSnapshot(document.querySelectorAll('[role="menuitem"]'), reason || 'manual-dump');
    recordIconDebugSnapshot(snapshot);
    return snapshot;
  }

  function installIconDebugHooks() {
    if (window.__twblockIconDebugHooksInstalled) return;
    window.__twblockIconDebugHooksInstalled = true;

    window.addEventListener('twblock:debug-icons', (event) => {
      const action = event.detail && typeof event.detail.action === 'string'
        ? event.detail.action
        : 'dump';

      if (action === 'on') {
        setIconDebugEnabled(true);
        return;
      }
      if (action === 'off') {
        setIconDebugEnabled(false);
        return;
      }
      if (action === 'history') {
        console.log(iconDebugHistory.slice());
        return;
      }

      dumpCurrentMenuIcons('manual-' + action);
    });
  }

  function getIcon(action) {
    if (action === 'block') return BLOCK_ICON || FALLBACK_BLOCK_ICON;
    return MUTE_ICON || FALLBACK_MUTE_ICON;
  }

  // ---- エラーメッセージ（pageScript はコードだけ返し、文言はここで解決する） ----
  const ERROR_MESSAGE_KEYS = {
    TIMEOUT: 'errorTimeout',
    NO_AUTH: 'errorNoAuth',
    FORBIDDEN: 'errorForbidden',
    RATE_LIMITED: 'errorRateLimited',
    NETWORK: 'errorNetwork',
  };

  function errorMessage(result) {
    if (!result) return msg('errorOccurred');
    const key = ERROR_MESSAGE_KEYS[result.error];
    if (key) return msg(key);
    if (typeof result.error === 'string' && result.error.indexOf('HTTP_') === 0) {
      return msg('errorHttp', result.error.slice(5));
    }
    return msg('errorOccurred');
  }

  // 「もうその状態ではない」= 解除操作としては達成済みとみなすAPIエラーコード
  //   272 You are not muting the specified user.（実測: HTTP 403 で返る）
  //   34 / 50 ページ・ユーザーが存在しない, 63 凍結済み
  const CLEARED_ERROR_CODES = new Set([272, 34, 50, 63]);

  function isUndoSettled(result) {
    if (!result) return false;
    if (result.success) return true;
    return CLEARED_ERROR_CODES.has(Number(result.code));
  }

  // ---- 設定 ----
  let showBlock = true;
  let showMute = true;
  let confirmBlockFollowing = true;
  let reloadAfterProfileBlock = false;
  let language = 'x';

  // ---- ブロック/ミュート状態の永続化 ----
  // 記録はアカウントで分けない（同じ相手はどのアカウントでも見たくない、という運用）。
  // v1 は 1ユーザー1状態だったが、ブロックとミュートは同時に持てるので {b, m} に変えた。
  const STORAGE_KEY = 'blockedUsersV2';
  const LEGACY_STORAGE_KEY = 'blockedUsers';

  // キーは小文字化した screen_name、値は { b: 0|1, m: 0|1 }
  const blockedUsers = new Map();
  // 自分で書いた内容で onChanged が跳ね返ってきたときの空回りを防ぐ
  let lastWrittenSnapshot = '';
  // まだストレージに書けていないローカル変更のキー。
  // 保存デバウンス中に他タブの内容で上書きされて消えるのを防ぐ
  const pendingSaveKeys = new Set();

  function nameKey(screenName) {
    return String(screenName || '').toLowerCase();
  }

  function normalizeState(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      if (value === 'block') return { b: 1, m: 0 };
      if (value === 'mute') return { b: 0, m: 1 };
      return null;
    }
    const state = { b: value.b ? 1 : 0, m: value.m ? 1 : 0 };
    return (state.b || state.m) ? state : null;
  }

  function normalizeStateMap(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const [name, value] of Object.entries(raw)) {
      const state = normalizeState(value);
      if (!state) continue;
      const key = nameKey(name);
      const prev = out[key];
      out[key] = prev ? { b: prev.b || state.b, m: prev.m || state.m } : state;
    }
    return out;
  }

  function getUserState(screenName) {
    return blockedUsers.get(nameKey(screenName)) || null;
  }

  function stateHas(state, action) {
    if (!state) return false;
    return action === 'block' ? Boolean(state.b) : Boolean(state.m);
  }

  function primaryAction(state) {
    if (!state) return null;
    return state.b ? 'block' : 'mute';
  }

  function setUserState(screenName, action, on) {
    const key = nameKey(screenName);
    const current = blockedUsers.get(key) || { b: 0, m: 0 };
    const next = { b: current.b, m: current.m };
    if (action === 'block') next.b = on ? 1 : 0;
    else next.m = on ? 1 : 0;
    if (next.b || next.m) blockedUsers.set(key, next);
    else blockedUsers.delete(key);
    pendingSaveKeys.add(key);
    saveBlockedUsers();
    return blockedUsers.get(key) || null;
  }

  let initialLoadDone = false;
  function loadBlockedUsers() {
    return store.get([STORAGE_KEY, LEGACY_STORAGE_KEY]).then((data) => {
      blockedUsers.clear();
      let current = (data[STORAGE_KEY] && typeof data[STORAGE_KEY] === 'object') ? data[STORAGE_KEY] : null;

      // v1（値が 'block' / 'mute' の文字列）からの移行を1度だけ行う
      const legacy = data[LEGACY_STORAGE_KEY];
      if (!current && legacy && typeof legacy === 'object') {
        current = normalizeStateMap(legacy);
        store.set({ [STORAGE_KEY]: current });
        store.remove(LEGACY_STORAGE_KEY);
      }

      const normalized = normalizeStateMap(current);
      for (const [key, state] of Object.entries(normalized)) blockedUsers.set(key, state);
      lastWrittenSnapshot = JSON.stringify(Object.fromEntries(blockedUsers));
      initialLoadDone = true;
    });
  }

  let saveTimer = null;
  function saveBlockedUsers() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushBlockedUsers, 150);
  }

  function flushBlockedUsers() {
    saveTimer = null;
    const snapshot = Object.fromEntries(blockedUsers);
    lastWrittenSnapshot = JSON.stringify(snapshot);
    pendingSaveKeys.clear();
    return store.set({ [STORAGE_KEY]: snapshot });
  }

  function countStat(action) {
    store.get('stats').then((data) => {
      const stats = (data.stats && typeof data.stats === 'object') ? data.stats : { blocked: 0, muted: 0 };
      if (action === 'block') stats.blocked = (Number(stats.blocked) || 0) + 1;
      else stats.muted = (Number(stats.muted) || 0) + 1;
      store.set({ stats });
    });
  }

  // ---- アイコン更新（ストレージ or パッシブ監視） ----
  let iconsExtracted = false;

  // ストレージから保存済みアイコンを読み込み
  function loadStoredIcons() {
    return store.get('icons').then((data) => {
      if (data.icons) {
        // 形式が変わったら捨てる。ここで見ていなかったので、定数を上げても効いていなかった
        if (data.icons.version !== ICON_CACHE_VERSION) return;
        if (data.icons.block) BLOCK_ICON = data.icons.block;
        if (data.icons.mute) MUTE_ICON = data.icons.mute;
        loadStoredIconSignatures(data.icons.signatures);
        iconsExtracted = Boolean(BLOCK_ICON && MUTE_ICON);
      }
    });
  }

  // 設定を読み込み
  function loadSettings() {
    return store.get('settings').then((data) => {
      applySettings(data.settings);
    });
  }

  function applySettings(settings) {
    const s = settings || {};
    showBlock = s.showBlock !== false;
    showMute = s.showMute !== false;
    confirmBlockFollowing = s.confirmBlockFollowing !== false;
    reloadAfterProfileBlock = s.reloadAfterProfileBlock === true;
    language = typeof s.language === 'string' ? s.language : 'x';
  }

  // 既存ボタンのアイコンを一括差し替え
  function replaceAllButtonIcons() {
    document.querySelectorAll('.twblock-block:not(.twblock-success)').forEach(btn => {
      if (btn.classList.contains('twblock-loading')) return;
      btn.innerHTML = getIcon('block');
    });
    document.querySelectorAll('.twblock-mute:not(.twblock-success)').forEach(btn => {
      if (btn.classList.contains('twblock-loading')) return;
      btn.innerHTML = getIcon('mute');
    });
  }

  // メニューアイテムからBlock/MuteのSVGを抽出する共通ロジック
  function extractIconsFromMenuItems(menuItems) {
    const snapshot = buildMenuIconSnapshot(menuItems, 'extract');
    let foundBlock = false;
    let foundMute = false;
    let nextBlockIcon = BLOCK_ICON;
    let nextMuteIcon = MUTE_ICON;

    for (const entry of snapshot.entries) {
      if (!entry.iconMarkup) continue;

      if (!foundBlock && entry.signatureMatch === 'block') {
        nextBlockIcon = entry.iconMarkup;
        foundBlock = true;
        entry.matchedBy = 'signature:block';
        rememberIconSignature('block', entry.signature);
      }
      if (!foundMute && entry.signatureMatch === 'mute') {
        nextMuteIcon = entry.iconMarkup;
        foundMute = true;
        entry.matchedBy = 'signature:mute';
        rememberIconSignature('mute', entry.signature);
      }

      if (!foundBlock && entry.labelMatch === 'block') {
        nextBlockIcon = entry.iconMarkup;
        foundBlock = true;
        entry.matchedBy = 'label:block';
        rememberIconSignature('block', entry.signature);
      }
      if (!foundMute && entry.labelMatch === 'mute') {
        nextMuteIcon = entry.iconMarkup;
        foundMute = true;
        entry.matchedBy = 'label:mute';
        rememberIconSignature('mute', entry.signature);
      }
    }

    snapshot.foundBlock = foundBlock;
    snapshot.foundMute = foundMute;
    snapshot.blockSignatureCount = BLOCK_ICON_SIGNATURES.size;
    snapshot.muteSignatureCount = MUTE_ICON_SIGNATURES.size;
    recordIconDebugSnapshot(snapshot);

    const changed = (foundBlock && nextBlockIcon !== BLOCK_ICON) || (foundMute && nextMuteIcon !== MUTE_ICON);
    if (foundBlock) BLOCK_ICON = nextBlockIcon;
    if (foundMute) MUTE_ICON = nextMuteIcon;
    iconsExtracted = Boolean(BLOCK_ICON && MUTE_ICON);
    if (changed) {
      persistIcons();
      replaceAllButtonIcons();
    }
    return foundBlock || foundMute;
  }

  // アクティブ取得: layersを非表示にしてメニューを開き、アイコン抽出後にEscapeで閉じる
  let extractRetries = 0;
  let extractStarted = false;
  function extractIconsOnce() {
    if (iconsExtracted || extractStarted) return;

    // アイコン抽出は caret を自分でクリックし、閉じるために Escape を撃つ。
    // 入力中に走らせると焦点を奪い、Escape が投稿欄に入ってしまう。後回しにする
    if (isComposing()) {
      if (++extractRetries <= 20) setTimeout(extractIconsOnce, 3000);
      return;
    }

    // 自分のツイートのメニューには Block/Mute が無いので、他人のツイートのcaretを選ぶ
    const me = getMyScreenName();
    let caret = null;
    for (const tweet of document.querySelectorAll('article[data-testid="tweet"]')) {
      const author = extractAuthorScreenName(tweet);
      if (author && me && nameKey(author) === nameKey(me)) continue;
      const c = tweet.querySelector('[data-testid="caret"]');
      if (c) { caret = c; break; }
    }
    if (!caret) caret = document.querySelector('[data-testid="caret"]');

    const layers = document.getElementById('layers');
    if (!caret || !layers) {
      if (++extractRetries <= 5) {
        setTimeout(extractIconsOnce, 2000);
      }
      return;
    }

    extractStarted = true;

    // 自分が開ける前から居た子を控えておく（後始末の対象を自分の分だけに絞る）
    const layerChildrenBefore = new Set(Array.from(layers.children));

    // メニューが閉じきるまで layers を隠しておく
    layers.style.visibility = 'hidden';
    let finished = false;
    let hardTimeout = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      mo.disconnect();
      clearTimeout(hardTimeout);
      // Escape が効かずメニューが残っていたら、開けた分だけ畳んでおく。
      // 押していないメニューが出っぱなしになるより良い。
      // 印を付けておき、メニューでなくなった時点で releaseHiddenLayers が必ず戻す
      if (document.querySelectorAll('[role="menuitem"]').length) {
        for (const child of layers.children) {
          if (layerChildrenBefore.has(child)) continue;
          child.style.display = 'none';
          child.setAttribute(HIDDEN_LAYER_ATTR, '1');
        }
      }
      layers.style.visibility = '';
    };

    // X はメニューを開くとメニュー要素にフォーカスを移し、そこで Escape を待っている。
    // document や caret に投げても閉じない（実機で確認済み）
    const closeMenu = () => {
      const target = document.activeElement || document.body;
      const opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
      target.dispatchEvent(new KeyboardEvent('keydown', opts));
      target.dispatchEvent(new KeyboardEvent('keyup', opts));
    };

    let extracted = false;
    const mo = new MutationObserver(() => {
      const menuItems = document.querySelectorAll('[role="menuitem"]');
      if (!extracted) {
        if (menuItems.length === 0) return;
        extracted = true;
        extractIconsFromMenuItems(menuItems);
        closeMenu();
        // フォーカスが移る前に撃ってしまった場合に備えてもう一度
        setTimeout(closeMenu, 300);
        return;
      }
      // 抽出後: メニューが閉じたのを確認してから visibility を戻す
      if (menuItems.length === 0) finish();
    });

    mo.observe(layers, { childList: true, subtree: true });
    caret.click();

    // タイムアウト: 3秒以内に閉じきらなければ強制的に復帰させる
    hardTimeout = setTimeout(() => {
      closeMenu();
      setTimeout(finish, 200);
    }, 3000);
  }

  // 文字を打っている最中か。焦点が投稿欄にあるか、下書きが残っていれば触らない
  function isComposing() {
    const active = document.activeElement;
    if (active && (active.isContentEditable || active.getAttribute('role') === 'textbox')) return true;
    for (const box of document.querySelectorAll('[data-testid^="tweetTextarea_"]')) {
      if (box.textContent && box.textContent.trim()) return true;
    }
    return false;
  }

  // 抽出のために隠した #layers の子を、メニューでなくなったら戻す。
  // X はこのコンテナを後のモーダルに使い回すので、隠しっぱなしにはできない
  function releaseHiddenLayers() {
    document.querySelectorAll('[' + HIDDEN_LAYER_ATTR + ']').forEach((el) => {
      if (el.querySelector('[role="menuitem"]')) return;
      el.style.display = '';
      el.removeAttribute(HIDDEN_LAYER_ATTR);
    });
  }

  // パッシブ監視: ユーザーが⋯メニューを開いた時にアイコンを抽出・更新
  let layersDebounceTimer = null;
  let layersRetries = 0;
  function observeLayers() {
    const layers = document.getElementById('layers');
    if (!layers) {
      // 見つからない環境で永久にタイマーを積まないよう上限を持たせる
      if (++layersRetries <= 30) setTimeout(observeLayers, 1000);
      return;
    }

    const layersObserver = new MutationObserver(() => {
      if (layersDebounceTimer) clearTimeout(layersDebounceTimer);
      layersDebounceTimer = setTimeout(() => {
        layersDebounceTimer = null;
        releaseHiddenLayers();
        const menuItems = document.querySelectorAll('[role="menuitem"]');
        if (menuItems.length > 0) extractIconsFromMenuItems(menuItems);
      }, 300);
    });

    layersObserver.observe(layers, { childList: true, subtree: true });
  }

  /* @twblock:pagescript-start */
  // ---- ページスクリプト注入 ----
  function injectPageScript() {
    if (window.__twblockPageScriptInjected) return;
    window.__twblockPageScriptInjected = true;
    try {
      const s = document.createElement('script');
      s.src = store.getPageScriptUrl();
      s.onload = function () { this.remove(); };
      (document.head || document.documentElement).appendChild(s);
    } catch (err) {
      // 拡張の更新直後など。ボタンは出るが操作は失敗する
      console.warn('[twblock] pageScript injection failed', err);
    }
  }
  /* @twblock:pagescript-end */

  // ---- メッセージブリッジ ----
  const pending = new Map();
  // タイムアウト後に遅れて届いた結果を拾うための記録
  const lateRequests = new Map();
  let reqId = 0;

  async function postRequest(payload, timeoutMs, timeoutValue, onLate) {
    await waitForPageScript();
    return new Promise((resolve) => {
      const id = '__twb_' + ++reqId;
      pending.set(id, resolve);
      window.postMessage(Object.assign({ requestId: id }, payload), '*');
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          if (onLate) {
            // pageScript が死んでいると溜まる一方なので上限を設ける
            if (lateRequests.size >= 50) {
              lateRequests.delete(lateRequests.keys().next().value);
            }
            lateRequests.set(id, onLate);
          }
          resolve(timeoutValue);
        }
      }, timeoutMs);
    });
  }

  function sendAction(action, screenName) {
    return postRequest(
      { type: '__TWBLOCK_ACTION', action, screenName },
      20000,
      { success: false, error: 'TIMEOUT' },
      (result) => {
        // 遅れて返ってきた結果でローカル状態を実態に合わせる。
        // 解除は「もうその状態でない」も達成として扱う
        const undo = action === 'unblock' || action === 'unmute';
        const settled = undo ? isUndoSettled(result) : Boolean(result && result.success);
        if (!settled) return;
        if (action === 'block') setUserState(screenName, 'block', 1);
        else if (action === 'mute') setUserState(screenName, 'mute', 1);
        else if (action === 'unblock') setUserState(screenName, 'block', 0);
        else if (action === 'unmute') setUserState(screenName, 'mute', 0);
        syncButtons(screenName);
        refreshHiddenForUser(screenName);
        // タイムアウト表示のあとで黙って状態が変わると分からないので知らせる
        showToast(msg('toastStateSynced', screenName));
      }
    );
  }

  function checkFollowing(screenName) {
    return postRequest(
      { type: '__TWBLOCK_CHECK_FOLLOWING', screenName },
      8000,
      { following: false, unknown: true }
    );
  }

  let pageScriptReady = false;
  const readyWaiters = [];

  function waitForPageScript() {
    if (pageScriptReady) return Promise.resolve();
    return new Promise((resolve) => {
      readyWaiters.push(resolve);
      // 準備完了通知を取りこぼしても止まらないよう、待つのは3秒まで
      setTimeout(resolve, 3000);
    });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.type === '__TWBLOCK_READY') {
      pageScriptReady = true;
      while (readyWaiters.length) readyWaiters.shift()();
      return;
    }
    if (e.data.type !== '__TWBLOCK_RESULT') return;
    const cb = pending.get(e.data.requestId);
    if (cb) {
      pending.delete(e.data.requestId);
      cb(e.data);
      return;
    }
    const late = lateRequests.get(e.data.requestId);
    if (late) {
      lateRequests.delete(e.data.requestId);
      try { late(e.data); } catch (err) { /* noop */ }
    }
  });

  // ---- screen_name 抽出 ----
  function extractScreenName(el) {
    if (!el) return null;
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

  function getProfilePathInfo() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;

    const screenName = parts[0];
    if (!/^[A-Za-z0-9_]{1,15}$/.test(screenName) || RESERVED_PATHS.has(screenName.toLowerCase())) {
      return null;
    }

    if (parts.length === 1) {
      return { screenName };
    }

    // /user/media や /user/likes も本人のページとして扱う
    if (parts.length === 2 && PROFILE_SUBPATHS.has(parts[1].toLowerCase())) {
      return { screenName };
    }

    return null;
  }

  function getProfileScreenName() {
    const info = getProfilePathInfo();
    return info ? info.screenName : null;
  }

  function isViewingProfileTimeline(screenName) {
    const info = getProfilePathInfo();
    return Boolean(info && nameKey(info.screenName) === nameKey(screenName));
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

  function isMe(screenName) {
    const me = getMyScreenName();
    return Boolean(me && screenName && nameKey(me) === nameKey(screenName));
  }

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
    return store.get('accentColor').then((data) => {
      if (data.accentColor && ACCENT_COLORS.has(data.accentColor)) {
        cachedAccentColor = data.accentColor;
      }
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
            store.set({ accentColor: bg });
          }
          return bg;
        }
      }
    }
    return cachedAccentColor || DEFAULT_ACCENT;
  }

  // ---- トースト通知 ----
  function showToast(message) {
    const existing = document.querySelector('.twblock-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'twblock-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.textContent = message;
    toast.style.backgroundColor = getAccentColor();
    document.body.appendChild(toast);

    setTimeout(() => {
      if (!toast.isConnected) return;
      toast.classList.add('twblock-toast-hide');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ---- 状態バー（非表示バー / プロフィール通知バー 共通） ----
  function makeBarButton(label, extraClass) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'twblock-show-btn' + (extraClass ? ' ' + extraClass : '');
    btn.textContent = label;
    return btn;
  }

  function createStateBar(screenName, options) {
    const bar = document.createElement('div');
    bar.className = 'twblock-hidden-bar' + (options.className ? ' ' + options.className : '');
    bar.setAttribute('data-screen-name', screenName);
    bar._twblockRestore = options.restore || null;
    bar._twblockOptions = options;
    renderStateBar(bar);
    return bar;
  }

  function closeStateBar(bar) {
    if (bar._twblockRestore) {
      try { bar._twblockRestore(); } catch (err) { /* noop */ }
      bar._twblockRestore = null;
    }
    bar.remove();
  }

  function renderStateBar(bar) {
    const screenName = bar.getAttribute('data-screen-name');
    const options = bar._twblockOptions || {};
    const state = getUserState(screenName);
    const action = primaryAction(state);
    if (!action) { closeStateBar(bar); return; }

    const undoAction = action === 'block' ? 'unblock' : 'unmute';
    const statusLabel = action === 'block' ? msg('blockedStatus') : msg('mutedStatus');
    const undoLabel = action === 'block' ? msg('unblockLabel') : msg('unmuteLabel');
    const undoToastKey = action === 'block' ? 'toastUnblocked' : 'toastUnmuted';

    bar.textContent = '';

    // ボタンの並びは「危険なほうが左、戻すほうが右」。
    // ブロック/ミュートは行の右端にあるので、押した直後のカーソルからは
    // 右端のボタンが一番近い。最頻の操作である「戻す」をそこへ置く
    const label = document.createElement('span');
    label.className = 'twblock-hidden-label';
    // プロフィールの通知バーは、その人のページにいるので相手のIDを出さない
    label.textContent = options.nameless ? statusLabel : statusLabel + ' @' + screenName;
    bar.appendChild(label);

    if (options.undo !== false) {
    // ミュート済みからブロックへ切り替え（ボタンの押し間違い救済）。
    // ブロックボタンを隠す設定は「TLを散らかしたくない」であって
    // 「ブロックしない」ではないので、ここには出す
    if (action === 'mute') {
      const upgradeBtn = makeBarButton(msg('switchToBlockLabel'), 'twblock-bar-danger');
      upgradeBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        upgradeBtn.disabled = true;
        upgradeBtn.textContent = '…';

        // 別の場所のバーが古いままだった場合など、すでにブロック済みなら投げ直さない
        if (stateHas(getUserState(screenName), 'block')) {
          refreshHiddenForUser(screenName);
          return;
        }

        if (!(await confirmBlockIfFollowing(screenName))) {
          upgradeBtn.disabled = false;
          upgradeBtn.textContent = msg('switchToBlockLabel');
          return;
        }

        const result = await sendAction('block', screenName);
        if (result.success) {
          setUserState(screenName, 'block', 1);
          countStat('block');
          syncButtons(screenName);
          showToast(msg('toastBlocked', screenName));
          refreshHiddenForUser(screenName);
        } else {
          upgradeBtn.disabled = false;
          upgradeBtn.textContent = msg('switchToBlockLabel');
          showToast(errorMessage(result));
        }
      });
      bar.appendChild(upgradeBtn);
    }

    const undoBtn = makeBarButton(undoLabel);
    undoBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      undoBtn.disabled = true;
      undoBtn.textContent = '…';

      const result = await sendAction(undoAction, screenName);
      if (isUndoSettled(result)) {
        setUserState(screenName, action, 0);
        syncButtons(screenName);
        showToast(result.success ? msg(undoToastKey, screenName) : msg('toastStateSynced', screenName));
        refreshHiddenForUser(screenName);
      } else {
        undoBtn.disabled = false;
        undoBtn.textContent = undoLabel;
        showToast(errorMessage(result));
        appendForceButton(bar, screenName);
      }
    });
    bar.appendChild(undoBtn);
    }

    if (options.reload) {
      const reloadBtn = makeBarButton(msg('reloadLabel'));
      reloadBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.location.reload();
      });
      bar.appendChild(reloadBtn);
    }

  }

  // API側で解除できないときの最後の逃げ道: ローカル記録だけを消して再表示する。
  // ラベルどおり「とにかく出す」ので、block と mute の両方を落とす
  function appendForceButton(bar, screenName) {
    if (bar.querySelector('.twblock-bar-force')) return;
    const forceBtn = makeBarButton(msg('forceShowLabel'), 'twblock-bar-force');
    forceBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setUserState(screenName, 'block', 0);
      setUserState(screenName, 'mute', 0);
      syncButtons(screenName);
      refreshHiddenForUser(screenName);
    });
    bar.appendChild(forceBtn);
  }

  // ---- 畳み/戻し ----
  // 子を配列に控えるのではなく、呼ばれるたびに「いまの子」に対して貼り直す。
  // 画像の遅延ロードで子が増えたり、Reactが中身を作り直したりしても追随できる。
  function setChildrenHidden(el, hidden) {
    for (const child of el.children) {
      if (child.classList && child.classList.contains('twblock-hidden-bar')) continue;
      child.style.display = hidden ? 'none' : '';
    }
  }

  function hideElement(el, screenName) {
    if (!primaryAction(getUserState(screenName))) return;
    setChildrenHidden(el, true);
    el.setAttribute(COLLAPSED_ATTR, '1');
    if (el.querySelector(':scope > .twblock-hidden-bar')) return;

    const bar = createStateBar(screenName, {
      restore: () => {
        setChildrenHidden(el, false);
        el.removeAttribute(COLLAPSED_ATTR);
      },
    });
    el.insertBefore(bar, el.firstChild);
  }

  function unhideElement(el) {
    const bar = el.querySelector(':scope > .twblock-hidden-bar');
    if (bar) { closeStateBar(bar); return; }
    // 自分で畳んだものだけ戻す。そうしないと X が付けた inline style を消してしまう
    if (!el.hasAttribute(COLLAPSED_ATTR)) return;
    setChildrenHidden(el, false);
    el.removeAttribute(COLLAPSED_ATTR);
  }

  function hideTweet(tweet, screenName) {
    hideElement(tweet, screenName);
  }

  function unhideTweet(tweet) {
    unhideElement(tweet);
  }

  function hideQuotedTweet(quotedBlock, screenName) {
    hideElement(quotedBlock, screenName);
  }

  function unhideQuotedTweet(quotedBlock) {
    unhideElement(quotedBlock);
  }

  // 画面に出ている同一ユーザーの投稿をまとめて隠す/戻し、バーの中身も作り直す。
  // 同じ人の投稿は複数箇所に出るので、片方で状態を変えたらもう片方も追随させないと
  // 「ミュート解除を押したのにブロック済みに変わる」ような食い違いが出る。
  function refreshHiddenForUser(screenName) {
    const key = nameKey(screenName);
    const action = primaryAction(getUserState(key));
    const onOwnProfile = isViewingProfileTimeline(key);

    const articles = document.querySelectorAll(
      'article[' + AUTHOR_ATTR + '="' + key + '"], article[' + RETWEETER_ATTR + '="' + key + '"]'
    );
    articles.forEach((tweet) => {
      // タイムラインの仮想化で article が別のツイートに使い回されると属性が古くなる。
      // 別人の投稿を畳まないよう、いま表示されている中身で確かめる
      if (!articleStillBelongsTo(tweet, key)) {
        tweet.removeAttribute(AUTHOR_ATTR);
        tweet.removeAttribute(RETWEETER_ATTR);
        return;
      }
      if (action && !onOwnProfile) hideTweet(tweet, screenName);
      else unhideTweet(tweet);
    });

    document.querySelectorAll('[' + QUOTED_ATTR + '="' + key + '"]').forEach((block) => {
      if (action && !onOwnProfile) hideQuotedTweet(block, screenName);
      else unhideQuotedTweet(block);
    });

    refreshStateBars(key);
  }

  function articleStillBelongsTo(tweet, key) {
    // 畳まれている間は本文が display:none なだけで中身は残っているので判定できる
    const author = extractAuthorScreenName(tweet);
    if (author && nameKey(author) === key) return true;
    const rt = extractRetweetInfo(tweet);
    return Boolean(rt && nameKey(rt.retweeter) === key);
  }

  // 同一ユーザーのバー（非表示バー・プロフィール通知バー）を現在の状態で描き直す
  function refreshStateBars(screenName) {
    const key = nameKey(screenName);
    document.querySelectorAll('.twblock-hidden-bar[data-screen-name]').forEach((bar) => {
      if (nameKey(bar.getAttribute('data-screen-name')) !== key) return;
      renderStateBar(bar);
    });
  }

  // ---- プロフィールでブロックした直後の通知バー ----
  function showProfileNotice(screenName) {
    document.querySelectorAll('.twblock-notice-bar').forEach((el) => el.remove());
    const column = document.querySelector('[data-testid="primaryColumn"]');
    const userName = column && column.querySelector('[data-testid="UserName"]');
    const anchor = userName && userName.parentElement;
    if (!anchor) return;

    const bar = createStateBar(screenName, {
      className: 'twblock-notice-bar',
      // 解除はプロフィールのボタン自体が済み表示になっているので、ここには置かない
      nameless: true,
      undo: false,
      reload: true,
    });
    bar.setAttribute('data-twblock-path', location.pathname);
    // リンクの色は X のテーマ色に合わせる
    bar.style.setProperty('--twblock-accent', getAccentColor());
    anchor.appendChild(bar);
  }

  // ---- ボタン作成 ----
  function createButtons(screenName) {
    if (!showBlock && !showMute) return null;

    const container = document.createElement('div');
    container.className = 'twblock-btn-container';
    container.setAttribute('data-screen-name', screenName);

    if (showBlock) {
      container.appendChild(createButton(screenName, 'block'));
    }
    if (showMute) {
      container.appendChild(createButton(screenName, 'mute'));
    }

    return container;
  }

  function applyButtonState(btn, screenName, action, active) {
    btn._isActive = active;
    btn.classList.toggle('twblock-success', active);
    if (!btn.classList.contains('twblock-loading')) {
      btn.innerHTML = active ? CHECK_ICON : getIcon(action);
    }
    const label = active
      ? (action === 'block' ? msg('blockedStatus') : msg('mutedStatus'))
      : (action === 'block' ? msg('blockLabel') : msg('muteLabel'));
    const text = label + ' @' + screenName;
    btn.title = text;
    btn.setAttribute('aria-label', text);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  // 指定ユーザーの全ボタンを現在の状態に合わせる
  function syncButtons(screenName) {
    const key = nameKey(screenName);
    const state = blockedUsers.get(key);
    document.querySelectorAll('.twblock-btn-container[data-screen-name]').forEach((container) => {
      const name = container.getAttribute('data-screen-name');
      if (nameKey(name) !== key) return;
      syncContainer(container, name, state);
    });
  }

  function syncContainer(container, screenName, state) {
    const s = state !== undefined ? state : getUserState(screenName);
    const blockBtn = container.querySelector('.twblock-block');
    const muteBtn = container.querySelector('.twblock-mute');
    if (blockBtn) applyButtonState(blockBtn, screenName, 'block', stateHas(s, 'block'));
    if (muteBtn) applyButtonState(muteBtn, screenName, 'mute', stateHas(s, 'mute'));
  }

  async function confirmBlockIfFollowing(screenName) {
    if (!confirmBlockFollowing) return true;
    const followResult = await checkFollowing(screenName);
    // 判定できなかったときに素通しすると、設定がレート制限中だけ黙って無効になる
    if (followResult.unknown) return window.confirm(msg('confirmBlockUnknown', screenName));
    if (!followResult.following) return true;
    return window.confirm(msg('confirmBlockFollowing', screenName));
  }

  function createButton(screenName, action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'twblock-btn twblock-' + action;
    applyButtonState(btn, screenName, action, false);

    const undoAction = action === 'block' ? 'unblock' : 'unmute';

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 確認ダイアログを出している間もクリックを受け付けないようにする
      if (btn.disabled || btn._busy) return;
      btn._busy = true;

      const wasActive = Boolean(btn._isActive);
      const currentAction = wasActive ? undoAction : action;

      // フォロー中ユーザーのブロック確認（ローディング表示前に聞く）
      if (action === 'block' && !wasActive) {
        if (!(await confirmBlockIfFollowing(screenName))) {
          btn._busy = false;
          return;
        }
      }

      btn.disabled = true;
      btn.classList.add('twblock-loading');

      const result = await sendAction(currentAction, screenName);

      btn.classList.remove('twblock-loading');
      btn.disabled = false;
      btn._busy = false;

      const settled = wasActive ? isUndoSettled(result) : result.success;
      if (!settled) {
        btn.classList.add('twblock-error');
        showToast(errorMessage(result));
        setTimeout(() => btn.classList.remove('twblock-error'), 3000);
        syncButtons(screenName);
        return;
      }

      setUserState(screenName, action, wasActive ? 0 : 1);
      syncButtons(screenName);

      if (wasActive) {
        showToast(result.success
          ? msg(action === 'block' ? 'toastUnblocked' : 'toastUnmuted', screenName)
          : msg('toastStateSynced', screenName));
        refreshHiddenForUser(screenName);
        return;
      }

      countStat(action);
      showToast(msg(action === 'block' ? 'toastBlocked' : 'toastMuted', screenName));

      const btnContainer = btn.closest('.twblock-btn-container');
      if (action === 'block' && btnContainer && btnContainer.classList.contains('twblock-profile')) {
        // プロフィールでは X 側の表示が古いままになる。強制リロードはせず、
        // 何が起きたかと再読み込み手段を出す（設定でリロードに戻せる）。
        if (reloadAfterProfileBlock) {
          setTimeout(() => window.location.reload(), 300);
          return;
        }
        showProfileNotice(screenName);
        refreshHiddenForUser(screenName);
        return;
      }

      // 該当ユーザーの投稿（引用RT含む）をまとめて畳む
      setTimeout(() => refreshHiddenForUser(screenName), 300);
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
    // リンクの直接の親(flex-column) — ここをflex-rowにしてボタンを横並びにする
    const scLinkParent = link.parentElement;
    return { retweeter: href.substring(1), scLinkParent };
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

  // 何度やっても取れないものを毎パス触り続けないための共通の数え上げ。
  // 上限内なら true（もう一度試してよい）、超えたら false（諦める）
  function countRetry(el) {
    const tries = Number(el.getAttribute(RETRY_ATTR) || 0) + 1;
    if (tries >= MAX_TWEET_RETRIES) {
      el.removeAttribute(RETRY_ATTR);
      return false;
    }
    el.setAttribute(RETRY_ATTR, String(tries));
    return true;
  }

  function isTransparentColor(value) {
    if (!value) return true;
    if (value === 'transparent') return true;
    const m = value.match(/^rgba?\(([^)]+)\)$/);
    if (!m) return false;
    const parts = m[1].split(',');
    return parts.length === 4 && Number(parts[3]) === 0;
  }

  // 行のどこに入れるか。入れ直すときも同じ規則を使う。
  // ヘッダーに Follow ボタンがあるときはその左（UserCell や プロフィールと同じ並び）、
  // 無ければ grok/caret の左
  function headerAnchorNode(row, grokInfo) {
    const follow = row.querySelector('[data-testid$="-follow"], [data-testid$="-unfollow"]');
    if (follow) return follow;
    return (grokInfo && (grokInfo.grokBtn || grokInfo.caret)) || null;
  }

  function placeTweetButtons(grokInfo, buttons) {
    const { row } = grokInfo;
    let anchorChild = null;
    const anchorNode = headerAnchorNode(row, grokInfo);
    for (const child of row.children) {
      if (child.contains(anchorNode)) { anchorChild = child; break; }
    }
    if (anchorChild) {
      row.insertBefore(buttons, anchorChild);
    } else if (grokInfo.grokBtn) {
      row.insertBefore(buttons, row.firstChild);
    } else {
      row.appendChild(buttons);
    }
  }

  // ツイート本体（引用カードでもRT行でもない）のボタン
  function ownHeaderContainer(tweet) {
    let keep = null;
    for (const el of tweet.querySelectorAll('.twblock-btn-container.twblock-tweet')) {
      if (el.classList.contains('twblock-repost')) continue;
      if (el.closest('[' + QUOTED_ATTR + ']')) continue;
      if (el.closest('article') !== tweet) continue;
      if (!keep) keep = el;
      else el.remove();
    }
    return keep;
  }

  // 位置の検算用。getComputedStyle を使わずに grok/caret だけ拾う
  function findGrokRowLite(tweet) {
    return {
      grokBtn: tweet.querySelector('[aria-label^="Grok"]'),
      caret: tweet.querySelector('[data-testid="caret"]'),
    };
  }

  // ヘッダーに Follow ボタンが出ている記事の後始末。
  // 置き場所（行）と並び順（Follow の後・grok の前）を保ち、色を Follow から借りる。
  // 正しく並んでいる間は DOM の比較だけで済ませ、getComputedStyle は呼ばない
  // isNew: Follow ボタンが作られ直した回。X が行を組み替えるのはこの瞬間なので、
  // ここでだけ findGrokRow（getComputedStyle）を回して行を選び直す。
  // それ以外のパスは並び順の比較だけで済ませる
  function fixHeaderPlacement(tweet, followBtn, isNew) {
    const placed = ownHeaderContainer(tweet);
    if (!placed) return;

    const anchorNode = headerAnchorNode(placed.parentElement, findGrokRowLite(tweet));
    const next = placed.nextElementSibling;
    const ordered = Boolean(anchorNode && next && next.contains(anchorNode));
    if (isNew || !ordered) {
      const info = findGrokRow(tweet);
      if (info) placeTweetButtons(info, placed);
    }

    // 作り直された回も読み直す。Follow→Following で色が変わるし、
    // 画面の向きが変わると次の大きさも変わる
    if (isNew || !placed.style.getPropertyValue('--twblock-follow-tone')) {
      // Follow は塗り、Following は輪郭なので、塗りがあれば背景色・無ければ文字色を借りる
      const cs = getComputedStyle(followBtn);
      const tone = isTransparentColor(cs.backgroundColor) ? cs.color : cs.backgroundColor;
      if (tone) placed.style.setProperty('--twblock-follow-tone', tone);
      // 同じ getComputedStyle から大きさも見る。PC の狭い窓の Follow は 32px の
      // pill だが、スマホでは 24px で出る。24px に丸を付けると X の grok や ⋯ より
      // 大きい輪ができるので、pill のときだけ丸で囲う。
      // min-height は指定値なのでレイアウトを起こさない。X が置いていないときだけ
      // height を読む
      const minH = parseFloat(cs.minHeight);
      const height = minH > 0 ? minH : parseFloat(cs.height);
      placed.classList.toggle('twblock-pill', height >= 30);
    }
  }

  function hasOwnContainer(row) {
    return Boolean(row.querySelector(':scope > .twblock-btn-container'));
  }

  function showAnyButton() {
    return showBlock || showMute;
  }

  // ---- ボタン挿入: タイムラインツイート ----
  function processTweets() {
    const tweets = document.querySelectorAll(
      'article[data-testid="tweet"]:not([' + PROCESSED + '])'
    );

    tweets.forEach((tweet) => {
      // 内部DOMが未レンダリングならスキップ（次回再試行）
      if (!tweet.querySelector('[data-testid="User-Name"]') ||
          !tweet.querySelector('[data-testid="caret"]')) return;

      try {
        const rtInfo = extractRetweetInfo(tweet);

        // RT者のボタンを"reposted"行に挿入
        if (rtInfo && !isMe(rtInfo.retweeter) && rtInfo.scLinkParent && !hasOwnContainer(rtInfo.scLinkParent)) {
          const rtButtons = createButtons(rtInfo.retweeter);
          if (rtButtons) {
            rtButtons.classList.add('twblock-tweet');
            rtButtons.classList.add('twblock-repost');
            rtInfo.scLinkParent.classList.add('twblock-repost-row');
            rtInfo.scLinkParent.appendChild(rtButtons);
            syncContainer(rtButtons, rtInfo.retweeter);
            // RT者を対象に操作したときも、この記事を畳めるようにする
            tweet.setAttribute(RETWEETER_ATTR, nameKey(rtInfo.retweeter));
          }
        }

        const authorName = extractAuthorScreenName(tweet) || extractScreenName(tweet);
        if (!authorName || isMe(authorName)) {
          tweet.setAttribute(PROCESSED, '1');
          processQuotedTweet(tweet);
          return;
        }

        tweet.setAttribute(AUTHOR_ATTR, nameKey(authorName));

        // 元投稿者のボタンをgrok/caret行に挿入
        const grokInfo = findGrokRow(tweet);
        if (grokInfo && !hasOwnContainer(grokInfo.row)) {
          const buttons = createButtons(authorName);
          if (buttons) {
            buttons.classList.add('twblock-tweet');
            buttons.style.marginLeft = 'auto';
            buttons.style.paddingLeft = '4px';
            placeTweetButtons(grokInfo, buttons);
            syncContainer(buttons, authorName);
          }
        }

        // アクションバーのレイアウトが未確定だと findGrokRow が null を返す。
        // ここで処理済みにするとそのツイートだけ永久にボタンが出ないので、数回は次パスに回す。
        const settled = Boolean(grokInfo) || !showAnyButton();
        if (settled) {
          tweet.setAttribute(PROCESSED, '1');
          tweet.removeAttribute(RETRY_ATTR);
        } else if (!countRetry(tweet)) {
          tweet.setAttribute(PROCESSED, '1');
        }

        // ブロック/ミュート済みユーザーのツイートを自動非表示
        const blockedAction = primaryAction(getUserState(authorName));
        if (blockedAction && !isViewingProfileTimeline(authorName)) {
          hideTweet(tweet, authorName);
        }

        processQuotedTweet(tweet);
      } catch (err) {
        console.warn('[twblock] processTweets', err);
        // 途中で失敗したら挿入済みのものを撤去して次パスでやり直す。
        // 引用ツイート側に立てた印も落とさないと、そこだけ二度と処理されない。
        // ただし毎回同じ所で落ちる相手には諦めて、出したり消したりを繰り返さない
        tweet.querySelectorAll('.twblock-btn-container').forEach((node) => node.remove());
        if (!countRetry(tweet)) {
          tweet.setAttribute(PROCESSED, '1');
          return;
        }
        tweet.removeAttribute(PROCESSED);
        tweet.querySelectorAll('[' + PROCESSED + ']').forEach((node) => node.removeAttribute(PROCESSED));
      }
    });
  }

  // ---- ボタン挿入: 引用ツイート ----
  function processQuotedTweet(parentTweet) {
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
      if (!qtScreenName || isMe(qtScreenName)) return;

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

      block.setAttribute(PROCESSED, '1');
      block.setAttribute(QUOTED_ATTR, nameKey(qtScreenName));

      if (!hasOwnContainer(targetRow)) {
        const buttons = createButtons(qtScreenName);
        if (buttons) {
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
          syncContainer(buttons, qtScreenName);
        }
      }

      // ブロック/ミュート済みユーザーの引用ツイートを自動非表示
      const blockedAction = primaryAction(getUserState(qtScreenName));
      if (blockedAction && !isViewingProfileTimeline(qtScreenName)) {
        hideQuotedTweet(block, qtScreenName);
      }
    });
  }

  // ---- ボタン挿入: 全Followボタン共通処理 ----
  function processFollowButtons() {
    const followBtns = document.querySelectorAll(
      '[data-testid$="-follow"], [data-testid$="-unfollow"], [data-testid$="-unblock"]'
    );

    followBtns.forEach((btn) => {
      // data-testid は "<ユーザーID>-follow" 形式。値ごと印にしておくと、
      // X が同じDOMノードを別ユーザーに使い回したときに作り直せる
      const stamp = btn.getAttribute('data-testid') || '1';

      // 狭い画面では X がヘッダーに Follow ボタンを足し、そのとき caret/grok を
      // 1段内側の行に包み直す。先に入れたボタンは外側の行（align-items:start,
      // 高さ40px）に取り残されて 6px 浮くので、置き場所と並び順をここで保つ。
      // X は後からこの行を作り直して並べ替えるので、印が付いていても毎回見る
      const ownerTweet = btn.closest('article[data-testid="tweet"]');
      if (ownerTweet) {
        const isNew = btn.getAttribute(PROCESSED) !== stamp;
        btn.setAttribute(PROCESSED, stamp);
        fixHeaderPlacement(ownerTweet, btn, isNew);
        return;
      }

      if (btn.getAttribute(PROCESSED) === stamp) return;

      const hoverCard = btn.closest('[data-testid="HoverCard"]');
      const userCell = btn.closest('[data-testid="UserCell"]');
      const listItem = btn.closest('[role="listitem"]');
      const placement = btn.closest('[data-testid="placementTracking"]');
      // 一覧の行を「プロフィールのFollowボタン」と誤認すると、
      // 行のユーザーではなくプロフィール主に対してブロックが飛ぶ。
      // UserCell がまだ付いていない瞬間があっても取り違えないよう、条件を厚くする。
      const isProfile = Boolean(
        placement && !userCell && !hoverCard && !listItem && getProfileScreenName()
      );

      let screenName;
      if (isProfile) {
        screenName = getProfileScreenName();
      } else {
        const container = userCell || hoverCard || listItem || btn.parentElement;
        screenName = extractScreenName(container);
      }
      if (!screenName) {
        // 描画途中で名前が取れないことがあるので数回は再試行し、それ以上は打ち切る
        if (!countRetry(btn)) btn.setAttribute(PROCESSED, stamp);
        return;
      }
      btn.setAttribute(PROCESSED, stamp);
      if (isMe(screenName)) {
        btn.removeAttribute(RETRY_ATTR);
        return;
      }

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
      if (!targetRow) {
        // 後から flex 行になることがあるので数回は待つが、無限には試さない
        if (!countRetry(btn)) return;
        btn.removeAttribute(PROCESSED);
        return;
      }

      // 挿入位置の基準になる targetRow の直接の子を求める
      let followChild = null;
      for (const child of targetRow.children) {
        if (child.contains(btn)) { followChild = child; break; }
      }
      if (!followChild) {
        if (!countRetry(btn)) return;
        btn.removeAttribute(PROCESSED);
        return;
      }
      // ここまで来たら行は確定した。次に作り直されたときのために数え直す
      btn.removeAttribute(RETRY_ATTR);

      // 重複防止: この「単位」の中のコンテナは1つに畳む。
      // X は再レンダリングでFollowボタンのネスト段数を変えることがあり、
      // 行単位のガードでは前回挿入分を見落として二重になる（Issue #14）。
      const scope = isProfile ? document : (userCell || hoverCard || listItem || targetRow);
      const selector = isProfile
        ? '.twblock-btn-container.twblock-profile'
        : '.twblock-btn-container';
      let reuse = null;
      scope.querySelectorAll(selector).forEach((existing) => {
        if (!reuse && nameKey(existing.getAttribute('data-screen-name')) === nameKey(screenName)) {
          reuse = existing;
        } else {
          existing.remove();
        }
      });

      let buttons = reuse;
      if (!buttons) {
        buttons = createButtons(screenName);
        if (!buttons) return;
      }
      buttons.classList.remove('twblock-profile', 'twblock-sidebar', 'twblock-hovercard');
      buttons.classList.add(isProfile ? 'twblock-profile' : 'twblock-sidebar');
      if (hoverCard) buttons.classList.add('twblock-hovercard');

      // React管理下のFollowボタンは動かさない（reparentするとReactのDOM差分が壊れる）
      if (buttons.parentElement !== targetRow || buttons.nextElementSibling !== followChild) {
        targetRow.insertBefore(buttons, followChild);
      }
      syncContainer(buttons, screenName);
    });
  }

  // ---- ボタン挿入: 検索候補(typeahead)のユーザー ----
  function processTypeahead() {
    const items = document.querySelectorAll(
      '[data-testid="typeaheadRecentSearchesItem"]:not([' + PROCESSED + ']), [data-testid="typeaheadResult"]:not([' + PROCESSED + '])'
    );

    items.forEach((item) => {
      // ユーザー項目のみ（検索クエリは除外）。描画途中もあるので数回は再試行する
      if (!item.querySelector('img')) {
        if (!countRetry(item)) item.setAttribute(PROCESSED, '1');
        return;
      }

      const screenName = extractScreenName(item);
      if (!screenName) {
        if (!countRetry(item)) item.setAttribute(PROCESSED, '1');
        return;
      }
      item.removeAttribute(RETRY_ATTR);
      item.setAttribute(PROCESSED, '1');
      if (isMe(screenName)) return;

      // item > div > div(flex/row) > div(textArea) > div(flex/row): [名前] [Xボタン]
      const container = item.children[0]?.children[0];
      if (!container) return;
      const textArea = container.children[1];
      if (!textArea) return;
      const row = textArea.children[0];
      if (!row || row.querySelector('.twblock-btn-container')) return;

      const buttons = createButtons(screenName);
      if (!buttons) return;
      buttons.classList.add('twblock-typeahead');

      // Xボタン(最後の子)の前に挿入 — insertBefore の基準は直接の子でなければならない
      let anchorChild = null;
      const xBtn = row.querySelector('button');
      if (xBtn) {
        for (const child of row.children) {
          if (child === xBtn || child.contains(xBtn)) { anchorChild = child; break; }
        }
      }
      if (anchorChild) {
        row.insertBefore(buttons, anchorChild);
      } else {
        row.appendChild(buttons);
      }
      syncContainer(buttons, screenName);
    });
  }

  // ---- 設定変更・状態変更時の作り直し ----
  function rescanAll() {
    document.querySelectorAll('.twblock-btn-container').forEach((el) => el.remove());
    // 通知バーは畳みと無関係なので巻き添えにしない（再読み込み導線が消えてしまう）
    document.querySelectorAll('.twblock-hidden-bar:not(.twblock-notice-bar)')
      .forEach((bar) => closeStateBar(bar));
    document.querySelectorAll('[' + PROCESSED + ']').forEach((el) => el.removeAttribute(PROCESSED));
    document.querySelectorAll('[' + RETRY_ATTR + ']').forEach((el) => el.removeAttribute(RETRY_ATTR));
    processAll();
  }

  // ---- メイン処理 ----
  function processAll() {
    lastPassAt = now();
    try { processTweets(); } catch (err) { console.warn('[twblock] processTweets', err); }
    try { processFollowButtons(); } catch (err) { console.warn('[twblock] processFollowButtons', err); }
    try { processTypeahead(); } catch (err) { console.warn('[twblock] processTypeahead', err); }
    // 描画途中で取れなかった要素は、次の変化を待たずに自分で拾い直す。
    // （以前は X が出し続ける無関係な変化がフォールバックを兼ねていた）
    if (document.querySelector('[' + RETRY_ATTR + ']')) schedulePass(RETRY_PASS_DELAY);
  }

  // ---- 変化の取捨とパスの間引き ----
  // X はいいね数のアニメーション（span[app-text-transition-container]）だけで
  // 1秒に200回近く childList を動かす。全部に反応すると processAll が毎フレーム走り、
  // その仕事がキー入力と同じフレームに乗る。実測: 何もしていない画面で 44回/秒。
  // 仕事があるのは「data-testid を持つ要素が増えた」ときだけなので、そこで切る。
  function isRelevant(records) {
    for (let i = 0; i < records.length; i++) {
      const added = records[i].addedNodes;
      for (let j = 0; j < added.length; j++) {
        const node = added[j];
        if (node.nodeType !== 1) continue;
        if (node.hasAttribute('data-testid')) return true;
        if (node.firstElementChild && node.querySelector('[data-testid]')) return true;
      }
    }
    return false;
  }

  const MIN_PASS_INTERVAL = 100;
  const RETRY_PASS_DELAY = 250;
  const now = () => (window.performance && performance.now ? performance.now() : Date.now());
  let rafScheduled = false;
  let trailingTimer = null;
  let lastPassAt = 0;

  function schedulePass(minDelay) {
    if (rafScheduled || trailingTimer) return;
    const wait = Math.max(MIN_PASS_INTERVAL - (now() - lastPassAt), minDelay || 0);
    if (wait <= 0) {
      // 直前に走っていなければ次の描画フレームで即処理（ツイートと同フレームにボタン表示）
      rafScheduled = true;
      requestAnimationFrame(() => {
        rafScheduled = false;
        processAll();
      });
      return;
    }
    trailingTimer = setTimeout(() => {
      trailingTimer = null;
      processAll();
    }, wait);
  }

  const observer = new MutationObserver((records) => {
    if (!isRelevant(records)) return;
    schedulePass(0);
  });

  let lastUrl = location.href;
  function checkUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // 別のページへ移ったら、前のプロフィールで出した通知バーは持ち越さない
      document.querySelectorAll('.twblock-notice-bar').forEach((el) => {
        if (el.getAttribute('data-twblock-path') !== location.pathname) el.remove();
      });
      setTimeout(processAll, 500);
    }
    // アカウント切替で「自分」が変わったら覚え直す
    const navLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const href = navLink && navLink.getAttribute('href');
    if (href && myScreenName && href.replace('/', '') !== myScreenName) {
      myScreenName = null;
      rescanAll();
    }
  }

  // ---- ストレージ変更のリアルタイム反映 ----
  store.onChanged((changes) => {
    if (changes.settings) {
      applySettings(changes.settings.newValue);
      // 言語が変わっていれば表を読み直してから作り直す
      applyLocale().then(() => rescanAll());
    }
    if (changes.icons) {
      const newIcons = changes.icons.newValue || {};
      if (newIcons.block) BLOCK_ICON = newIcons.block;
      if (newIcons.mute) MUTE_ICON = newIcons.mute;
      loadStoredIconSignatures(newIcons.signatures);
      iconsExtracted = Boolean(BLOCK_ICON && MUTE_ICON);
      replaceAllButtonIcons();
    }
    if (changes[STORAGE_KEY]) {
      // 初回読み込みの応答待ち中に来た変更は、読み込み結果に上書きされてしまう。
      // 読み込みが終わってから拾い直す
      if (!initialLoadDone) return;
      const next = changes[STORAGE_KEY].newValue || {};
      const snapshot = JSON.stringify(next);
      if (snapshot !== lastWrittenSnapshot) {
        lastWrittenSnapshot = snapshot;
        const merged = normalizeStateMap(next);
        // まだ書けていないローカル変更は他タブの内容より優先する。
        // ここで潰すと「ブロックした直後に投稿が戻る」ことになる
        for (const key of pendingSaveKeys) {
          const local = blockedUsers.get(key);
          if (local) merged[key] = local;
          else delete merged[key];
        }
        blockedUsers.clear();
        for (const [key, state] of Object.entries(merged)) blockedUsers.set(key, state);
        if (pendingSaveKeys.size) saveBlockedUsers();
        rescanAll();
      }
    }
  });

  // ---- 初期化 ----
  async function init() {
    injectCSS();
    loadIconDebugFlag();
    installIconDebugHooks();
    injectPageScript();
    await loadStoredIcons();
    await loadSettings();
    // 文言は設定を読んだ後に決める（Xの言語に合わせる設定があるため）
    await applyLocale();
    await loadStoredAccentColor();
    await loadBlockedUsers();
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
