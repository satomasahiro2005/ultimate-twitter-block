// ==UserScript==
// @name         Ultimate Twitter Block
// @namespace    twitter-block-userscript
// @version      2.2.1
// @description  Add one-click block/mute buttons to tweets, profiles, and search suggestions on Twitter/X
// @author       nemut.ai
// @match        https://x.com/*
// @match        https://twitter.com/*
// @updateURL    https://raw.githubusercontent.com/satomasahiro2005/ultimate-twitter-block/main/userscripts/twitter-block.user.js
// @downloadURL  https://raw.githubusercontent.com/satomasahiro2005/ultimate-twitter-block/main/userscripts/twitter-block.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  if (window.__twblockInjected) return;
  window.__twblockInjected = true;

  const PROCESSED = 'data-twblock';
  const RESERVED_PATHS = new Set([
    'home', 'explore', 'search', 'notifications', 'messages',
    'settings', 'i', 'compose', 'login', 'logout', 'signup',
    'tos', 'privacy', 'about', 'help', 'jobs', 'download',
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
  const BLOCK_ICON_SIGNATURES = new Set(['498278e7']);
  const MUTE_ICON_SIGNATURES = new Set(['d3853445']);
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
    '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" fill="currentColor"/></svg>';

  function escapeAttr(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

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
    getIconSignatureSet(action).add(signature);
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
    chrome.storage.local.set({
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

  function recordIconDebugSnapshot(snapshot) {
    iconDebugHistory.push(snapshot);
    if (iconDebugHistory.length > MAX_ICON_DEBUG_HISTORY) {
      iconDebugHistory.shift();
    }
    if (iconDebugEnabled) logIconDebugSnapshot(snapshot);
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
  // ---- i18n ----
  const _lang = (navigator.language || '').toLowerCase();
  const _L = _lang.startsWith('ja') ? 'ja' : (_lang.startsWith('zh') ? 'zh_CN' : 'en');
  const _M = {"en":{"extName":"Ultimate Twitter Block","extDescription":"Add one-click block & mute buttons to every tweet, retweet, quote tweet, and profile on Twitter/X. Native UI design.","blockLabel":"Block","muteLabel":"Mute","blockedStatus":"Blocked","mutedStatus":"Muted","unblockLabel":"Unblock","unmuteLabel":"Unmute","toastBlocked":"Blocked @$1","toastMuted":"Muted @$1","toastUnblocked":"Unblocked @$1","toastUnmuted":"Unmuted @$1","errorTimeout":"Timed out","errorOccurred":"An error occurred","popupDescription":"One-click block & mute from tweets and profiles","settingsLabel":"Settings","sectionButtons":"Button Display","showBlockButton":"Show block button","showMuteButton":"Show mute button","confirmBlockFollowingLabel":"Confirm before blocking followed users","confirmBlockFollowing":"You are following @$1. Block anyway?","sectionStats":"Statistics","statsBlockedLabel":"Blocked","statsMutedLabel":"Muted","resetStats":"Reset Statistics","sectionReset":"Reset","resetHint":"Reset all data (statistics, icons, settings) to defaults","fullReset":"Full Reset Extension","confirmReset":"Reset all data (statistics and settings)?","supportLabel":"Support"},"ja":{"extName":"Ultimate Twitter Block","extDescription":"Twitter/Xのタイムラインにワンクリックのブロック＆ミュートボタンを追加。ツイート・RT・引用RT・プロフィールに対応。","blockLabel":"ブロック","muteLabel":"ミュート","blockedStatus":"ブロック済み","mutedStatus":"ミュート済み","unblockLabel":"ブロック解除","unmuteLabel":"ミュート解除","toastBlocked":"@$1 をブロックしました","toastMuted":"@$1 をミュートしました","toastUnblocked":"@$1 のブロックを解除しました","toastUnmuted":"@$1 のミュートを解除しました","errorTimeout":"タイムアウトしました","errorOccurred":"エラーが発生しました","popupDescription":"ツイートやプロフィールに表示されるボタンでワンクリックブロック＆ミュート","settingsLabel":"設定","sectionButtons":"ボタン表示","showBlockButton":"ブロックボタンを表示","showMuteButton":"ミュートボタンを表示","confirmBlockFollowingLabel":"フォロー中のユーザーをブロックする前に確認する","confirmBlockFollowing":"@$1 はフォロー中です。ブロックしますか？","sectionStats":"統計","statsBlockedLabel":"ブロック","statsMutedLabel":"ミュート","resetStats":"統計をリセット","sectionReset":"リセット","resetHint":"統計・アイコン・設定をすべて初期状態に戻します","fullReset":"拡張機能を完全リセット","confirmReset":"すべてのデータ（統計・設定）をリセットしますか？","supportLabel":"サポート"},"zh_CN":{"extName":"Ultimate Twitter Block","extDescription":"在 Twitter/X 上为每条推文、转发、引用推文和个人资料添加一键屏蔽与隐藏按钮。原生界面风格。","blockLabel":"屏蔽","muteLabel":"隐藏","blockedStatus":"已屏蔽","mutedStatus":"已隐藏","unblockLabel":"取消屏蔽","unmuteLabel":"取消隐藏","toastBlocked":"已屏蔽 @$1","toastMuted":"已隐藏 @$1","toastUnblocked":"已对 @$1 取消屏蔽","toastUnmuted":"已对 @$1 取消隐藏","errorTimeout":"请求超时","errorOccurred":"发生错误","popupDescription":"在推文和个人资料中一键屏蔽与隐藏","settingsLabel":"设置","sectionButtons":"按钮显示","showBlockButton":"显示屏蔽按钮","showMuteButton":"显示隐藏按钮","confirmBlockFollowingLabel":"屏蔽已关注用户前先确认","confirmBlockFollowing":"你已关注 @$1。仍要屏蔽吗？","sectionStats":"统计","statsBlockedLabel":"屏蔽","statsMutedLabel":"隐藏","resetStats":"重置统计","sectionReset":"重置","resetHint":"将统计、图标和设置恢复为默认值","fullReset":"完全重置扩展","confirmReset":"要重置所有数据（统计和设置）吗？","supportLabel":"支持"}};
  function _i18n(key) { return (_M[_L] || _M.en)[key] || key; }
  const i18n = {};
  function cacheI18n() {
    const keys = [
      'blockLabel', 'muteLabel', 'blockedStatus', 'mutedStatus',
      'unblockLabel', 'unmuteLabel', 'errorTimeout', 'errorOccurred',
    ];
    for (const k of keys) i18n[k] = _i18n(k);
  }
  function msg(key, sub) {
    if (sub != null) {
      const s = _i18n(key);
      return s.replace(/\$1/g, sub);
    }
    return i18n[key] || _i18n(key) || key;
  }
  // ---- 設定 ----
  let showBlock = true;
  let showMute = true;
  let confirmBlockFollowing = false;

  // ---- ブロック/ミュート済みユーザーの永続化 ----
  const blockedUsers = new Map(); // screenName → 'block' | 'mute'

  function loadBlockedUsers() {
    return new Promise((resolve) => {
      chrome.storage.local.get('blockedUsers', (data) => {
        if (data.blockedUsers) {
          for (const [k, v] of Object.entries(data.blockedUsers)) {
            blockedUsers.set(k, v);
          }
        }
        resolve();
      });
    });
  }

  function saveBlockedUsers() {
    chrome.storage.local.set({ blockedUsers: Object.fromEntries(blockedUsers) });
  }

  function addBlockedUser(screenName, action) {
    blockedUsers.set(screenName, action);
    saveBlockedUsers();
  }

  function removeBlockedUser(screenName, action) {
    if (blockedUsers.get(screenName) === action) {
      blockedUsers.delete(screenName);
      saveBlockedUsers();
    }
  }

  // ---- アイコン更新（ストレージ or パッシブ監視） ----
  let iconsExtracted = false;

  // ストレージから保存済みアイコンを読み込み
  function loadStoredIcons() {
    return new Promise((resolve) => {
      try {
        const stored = JSON.parse(localStorage.getItem('twblock_icons'));
        if (stored && stored.version === ICON_CACHE_VERSION) {
          if (stored.block) BLOCK_ICON = stored.block;
          if (stored.mute) MUTE_ICON = stored.mute;
          iconsExtracted = Boolean(BLOCK_ICON && MUTE_ICON);
        }
      } catch {}
      resolve();
    });
  }

  // 設定を読み込み
  function loadSettings() {
    return new Promise((resolve) => {
      try {
        const stored = JSON.parse(localStorage.getItem('twblock_settings'));
        if (stored) {
          showBlock = stored.showBlock !== false;
          showMute = stored.showMute !== false;
          confirmBlockFollowing = stored.confirmBlockFollowing === true;
        }
      } catch {}
      resolve();
    });
  }

  // 既存ボタンのアイコンを一括差し替え
  function replaceAllButtonIcons() {
    document.querySelectorAll('.twblock-block:not(.twblock-success)').forEach(btn => {
      btn.innerHTML = getIcon('block');
    });
    document.querySelectorAll('.twblock-mute:not(.twblock-success)').forEach(btn => {
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

    if (foundBlock || foundMute) {
      if (foundBlock) BLOCK_ICON = nextBlockIcon;
      if (foundMute) MUTE_ICON = nextMuteIcon;
      iconsExtracted = Boolean(BLOCK_ICON && MUTE_ICON);
      persistIcons();
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
      setTimeout(() => {
        const menuItems = document.querySelectorAll('[role="menuitem"]');
        if (menuItems.length > 0) extractIconsFromMenuItems(menuItems);
      }, 300);
    });

    layersObserver.observe(layers, { childList: true, subtree: true });
  }
  // ---- ページスクリプト注入（@grant none: ページコンテキストで直接実行） ----
  function injectPageScript() {
    (function () {
  'use strict';

  let capturedHeaders = null;

  function captureHeaders(headers) {
    if (!headers) return;
    const normalized = {};
    for (const [key, value] of Object.entries(headers)) {
      normalized[String(key).toLowerCase()] = value;
    }
    if (!normalized.authorization || !normalized['x-csrf-token']) return;
    capturedHeaders = {
      authorization: normalized.authorization,
      'x-csrf-token': normalized['x-csrf-token'],
      'x-twitter-active-user': normalized['x-twitter-active-user'] || 'yes',
      'x-twitter-auth-type': normalized['x-twitter-auth-type'] || 'OAuth2Session',
      'x-twitter-client-language': normalized['x-twitter-client-language'] || document.documentElement.lang || 'en',
    };
  }

  // Twitterのfetchをインターセプトして認証ヘッダーを取得
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const [url, options] = args;
    if (typeof url === 'string' && url.includes('/i/api/')) {
      if (options && options.headers) {
        const headers =
          options.headers instanceof Headers
            ? Object.fromEntries(options.headers.entries())
            : options.headers;
        captureHeaders(headers);
      }
    }
    return originalFetch.apply(this, args);
  };

  // フォールバック: XMLHttpRequestもインターセプト
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._twblockUrl = url;
    this._twblockHeaders = {};
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._twblockHeaders) {
      this._twblockHeaders[name.toLowerCase()] = value;
    }
    return origSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this._twblockUrl && this._twblockUrl.includes('/i/api/')) {
      captureHeaders(this._twblockHeaders);
    }
    return origSend.apply(this, args);
  };

  // ct0 cookieからCSRFトークンを取得
  function getCsrfToken() {
    const match = document.cookie.match(/ct0=([^;]+)/);
    return match ? match[1] : null;
  }

  // 公開ベアラートークン（Twitter Web Appに埋め込まれている固定値）
  const BEARER_TOKEN =
    'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs' +
    '%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  function getHeaders() {
    if (capturedHeaders) return { ...capturedHeaders };
    const csrf = getCsrfToken();
    if (csrf) {
      return {
        authorization: 'Bearer ' + decodeURIComponent(BEARER_TOKEN),
        'x-csrf-token': csrf,
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-client-language': document.documentElement.lang || 'en',
      };
    }
    return null;
  }

  // ブロック/ミュートAPIを呼び出す
  async function performAction(action, screenName) {
    const headers = getHeaders();
    if (!headers) {
      return { success: false, error: 'NO_AUTH', message: '認証情報が取得できません。ページを操作してから再試行してください。' };
    }

    const endpoints = {
      block: 'https://x.com/i/api/1.1/blocks/create.json',
      unblock: 'https://x.com/i/api/1.1/blocks/destroy.json',
      mute: 'https://x.com/i/api/1.1/mutes/users/create.json',
      unmute: 'https://x.com/i/api/1.1/mutes/users/destroy.json',
    };

    const url = endpoints[action];
    if (!url) {
      return { success: false, error: 'INVALID_ACTION', message: '不明なアクション: ' + action };
    }

    try {
      const response = await originalFetch(url, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        credentials: 'include',
        body: 'screen_name=' + encodeURIComponent(screenName),
      });

      if (response.ok) {
        const data = await response.json();
        return { success: true, data };
      }

      // 403: CSRFトークン失効 → ct0 cookieから再取得してリトライ
      if (response.status === 403) {
        const freshCsrf = getCsrfToken();
        if (freshCsrf && freshCsrf !== headers['x-csrf-token']) {
          const retryResponse = await originalFetch(url, {
            method: 'POST',
            headers: {
              ...headers,
              'x-csrf-token': freshCsrf,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            credentials: 'include',
            body: 'screen_name=' + encodeURIComponent(screenName),
          });
          if (retryResponse.ok) {
            capturedHeaders = { ...headers, 'x-csrf-token': freshCsrf };
            const data = await retryResponse.json();
            return { success: true, data };
          }
        }
        return { success: false, error: 'FORBIDDEN', message: 'セッションが期限切れです。ページを再読み込みしてください。' };
      }

      if (response.status === 429) {
        return { success: false, error: 'RATE_LIMITED', message: 'レート制限に達しました。しばらく待ってから再試行してください。' };
      }

      return { success: false, error: 'HTTP_' + response.status, message: await response.text() };
    } catch (err) {
      return { success: false, error: 'NETWORK', message: err.message };
    }
  }

  // フォロー状態を確認するAPI
  async function checkFollowing(screenName) {
    const headers = getHeaders();
    if (!headers) {
      return { following: false };
    }

    try {
      const url = 'https://x.com/i/api/1.1/friendships/show.json?source_screen_name=&target_screen_name=' + encodeURIComponent(screenName);
      const response = await originalFetch(url, {
        method: 'GET',
        headers: { ...headers },
        credentials: 'include',
      });

      if (response.ok) {
        const data = await response.json();
        return { following: data.relationship?.source?.following === true };
      }
      return { following: false };
    } catch (err) {
      return { following: false };
    }
  }

  // content.jsからのメッセージを受信
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.type === '__TWBLOCK_ACTION') {
      const { action, screenName, requestId } = event.data;
      const result = await performAction(action, screenName);
      window.postMessage(
        { type: '__TWBLOCK_RESULT', requestId, ...result },
        '*'
      );
    }
    if (event.data && event.data.type === '__TWBLOCK_CHECK_FOLLOWING') {
      const { screenName, requestId } = event.data;
      const result = await checkFollowing(screenName);
      window.postMessage(
        { type: '__TWBLOCK_RESULT', requestId, ...result },
        '*'
      );
    }
  });

  // 準備完了を通知
  window.postMessage({ type: '__TWBLOCK_READY' }, '*');
})();
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
    if (e.source !== window || !e.data) return;
    if (e.data.type !== '__TWBLOCK_RESULT') return;
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

  function getProfilePathInfo() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;

    const screenName = parts[0];
    if (!/^[A-Za-z0-9_]{1,15}$/.test(screenName) || RESERVED_PATHS.has(screenName.toLowerCase())) {
      return null;
    }

    if (parts.length === 1) {
      return { screenName, section: null };
    }

    if (parts.length === 2 && PROFILE_SUBPATHS.has(parts[1].toLowerCase())) {
      return { screenName, section: parts[1].toLowerCase() };
    }

    return null;
  }

  function getProfileScreenName() {
    const info = getProfilePathInfo();
    return info ? info.screenName : null;
  }

  function isViewingProfileTimeline(screenName) {
    const info = getProfilePathInfo();
    return Boolean(info && info.screenName.toLowerCase() === screenName.toLowerCase());
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
      try {
        const stored = localStorage.getItem('twblock_accentColor');
        if (stored && ACCENT_COLORS.has(stored)) {
          cachedAccentColor = stored;
        }
      } catch {}
      resolve();
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
            localStorage.setItem('twblock_accentColor', bg);
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
        removeBlockedUser(screenName, action);
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
          addBlockedUser(screenName, action);
          showToast(msg(action === 'block' ? 'toastBlocked' : 'toastMuted', screenName));

          const btnContainer = btn.closest('.twblock-btn-container');
          if (action === 'block' && btnContainer && btnContainer.classList.contains('twblock-profile')) {
            setTimeout(() => window.location.reload(), 300);
            return;
          }

          // 引用ツイート内のボタンなら引用部分にバー表示
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
          removeBlockedUser(screenName, action);
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
        const authorName = extractAuthorScreenName(tweet) || extractScreenName(tweet);
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

        // ブロック/ミュート済みユーザーのツイートを自動非表示
        const blockedAction = blockedUsers.get(authorName);
        if (blockedAction) {
          const activeBtn = tweet.querySelector('.twblock-' + blockedAction + ':not(.twblock-success)');
          if (activeBtn) {
            activeBtn._isActive = true;
            activeBtn.classList.add('twblock-success');
            activeBtn.innerHTML = CHECK_ICON;
          }
          if (!isViewingProfileTimeline(authorName)) {
            hideTweet(tweet, authorName, blockedAction);
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

      // ブロック/ミュート済みユーザーの引用ツイートを自動非表示
      const blockedAction = blockedUsers.get(qtScreenName);
      if (blockedAction) {
        const activeBtn = buttons.querySelector('.twblock-' + blockedAction + ':not(.twblock-success)');
        if (activeBtn) {
          activeBtn._isActive = true;
          activeBtn.classList.add('twblock-success');
          activeBtn.innerHTML = CHECK_ICON;
        }
        if (!isViewingProfileTimeline(qtScreenName)) {
          hideQuotedTweet(block, qtScreenName, blockedAction);
        }
      }
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

      if (isProfile) {
        // プロフィールではFollowボタンをreparentするとReactが壊れるため
        // twblockボタンのみをFollowの前に挿入する
        targetRow.insertBefore(buttons, followChild);
      } else {
        // sidebar / UserCellではラッパーでまとめてgapで間隔を確保
        const wrapper = document.createElement('div');
        wrapper.className = 'twblock-follow-wrapper';
        targetRow.insertBefore(wrapper, followChild);
        wrapper.appendChild(buttons);
        wrapper.appendChild(followChild);
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
  // ---- CSS注入 ----
  function injectCSS() {
    const style = document.createElement('style');
    style.textContent = "/* ========== Ultimate Twitter Block ========== */\r\n\r\n/* Followボタン + twblockボタンのラッパー */\r\n.twblock-follow-wrapper {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 4px;\r\n  flex-shrink: 0;\r\n}\r\n\r\n/* ラッパー内のFollowボタン親のmargin-leftをリセット */\r\n.twblock-follow-wrapper > :not(.twblock-btn-container) {\r\n  margin-left: 0 !important;\r\n}\r\n\r\n/* ボタンコンテナ（共通） */\r\n.twblock-btn-container {\r\n  display: flex;\r\n  align-items: center;\r\n  gap: 0;\r\n  flex-shrink: 0;\r\n}\r\n\r\n/* ツイートヘッダー: Grok/caret行内に配置 (Grok/caretと同サイズ) */\r\n.twblock-btn-container.twblock-tweet {\r\n  flex: 0 0 auto;\r\n  gap: 8px;\r\n}\r\n\r\n.twblock-btn-container.twblock-tweet .twblock-btn {\r\n  width: 20px;\r\n  height: 20px;\r\n  position: relative;\r\n  overflow: visible;\r\n}\r\n\r\n.twblock-btn-container.twblock-tweet .twblock-btn::before {\r\n  content: '';\r\n  position: absolute;\r\n  top: 50%;\r\n  left: 50%;\r\n  width: 34px;\r\n  height: 34px;\r\n  margin: -17px;\r\n  border-radius: 50%;\r\n  transition: background-color 0.15s ease;\r\n}\r\n\r\n.twblock-btn-container.twblock-tweet .twblock-btn svg {\r\n  width: 18.75px;\r\n  height: 18.75px;\r\n  position: relative;\r\n}\r\n\r\n/* ツイートボタン: ホバー背景は::beforeで表示、ボタン自体は透明 */\r\n.twblock-btn-container.twblock-tweet .twblock-block:hover:not(:disabled),\r\n.twblock-btn-container.twblock-tweet .twblock-mute:hover:not(:disabled) {\r\n  background-color: transparent;\r\n}\r\n\r\n.twblock-btn-container.twblock-tweet .twblock-block:hover:not(:disabled)::before {\r\n  background-color: rgba(244, 33, 46, 0.1);\r\n}\r\n\r\n.twblock-btn-container.twblock-tweet .twblock-mute:hover:not(:disabled)::before {\r\n  background-color: rgba(255, 173, 31, 0.1);\r\n}\r\n\r\n.twblock-btn-container.twblock-tweet .twblock-success:hover {\r\n  background-color: transparent !important;\r\n}\r\n\r\n.twblock-btn-container.twblock-tweet .twblock-success:hover::before {\r\n  background-color: rgba(244, 33, 46, 0.1);\r\n}\r\n\r\n/* RT(\"reposted\")行のpadding-top:12pxを上下に分散 */\r\n.twblock-repost-row .r-ttdzmv {\r\n  padding-top: 6px;\r\n  padding-bottom: 6px;\r\n}\r\n\r\n/* RT(\"reposted\")行の親をflex-rowに変更して横並びにする */\r\n.twblock-repost-row {\n  flex-direction: row !important;\n  align-items: center;\n  gap: 4px;\n}\n\n.twblock-attribution-row {\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  flex-wrap: wrap;\n}\n\r\n/* RT(\"reposted\")行: テキスト(16px/20px line-height)とアイコンの中心を揃える */\r\n.twblock-btn-container.twblock-repost {\r\n  gap: 4px;\r\n  margin-top: -2px;\r\n  margin-bottom: -2px;\r\n}\r\n\r\n.twblock-btn-container.twblock-repost .twblock-btn::before {\r\n  display: none;\r\n}\r\n\r\n/* プロフィール: Followボタンと同じ高さ(36px)の丸ボタン */\r\n.twblock-btn-container.twblock-profile {\r\n  gap: 8px;\r\n  align-self: flex-start;\r\n  margin-right: 8px;\r\n}\r\n\r\n.twblock-btn-container.twblock-profile .twblock-btn {\r\n  width: 36px;\r\n  height: 36px;\r\n  border-radius: 50%;\r\n  border: 1px solid light-dark(rgb(207, 217, 222), rgb(83, 100, 113));\r\n  color: light-dark(rgb(15, 20, 26), rgb(230, 233, 234));\r\n}\r\n\r\n.twblock-btn-container.twblock-profile .twblock-btn svg {\r\n  width: 20px;\r\n  height: 20px;\r\n}\r\n\r\n/* 検索候補(typeahead): Xボタンの左に配置 */\r\n.twblock-btn-container.twblock-typeahead {\r\n  gap: 4px;\r\n  flex-shrink: 0;\r\n  margin-left: auto;\r\n}\r\n\r\n.twblock-btn-container.twblock-typeahead .twblock-btn {\r\n  width: 20px;\r\n  height: 20px;\r\n}\r\n\r\n.twblock-btn-container.twblock-typeahead .twblock-btn svg {\r\n  width: 18px;\r\n  height: 18px;\r\n}\r\n\r\n/* サイドバー / フォロー一覧: 32px丸ボタン */\r\n.twblock-btn-container.twblock-sidebar {\r\n  gap: 4px;\r\n  flex-shrink: 0;\r\n}\r\n\r\n.twblock-btn-container.twblock-sidebar .twblock-btn {\r\n  width: 32px;\r\n  height: 32px;\r\n  border-radius: 50%;\r\n  border: 1px solid light-dark(rgb(207, 217, 222), rgb(83, 100, 113));\r\n  color: light-dark(rgb(15, 20, 26), rgb(230, 233, 234));\r\n}\r\n\r\n.twblock-btn-container.twblock-sidebar .twblock-btn svg {\r\n  width: 18px;\r\n  height: 18px;\r\n}\r\n\r\n/* ホバーカード */\r\n.twblock-btn-container.twblock-hovercard {\r\n  margin-right: 8px;\r\n}\r\n\r\n\r\n/* 個別ボタン（デフォルト: 34x34, アイコン20x20） */\r\n.twblock-btn {\r\n  display: inline-flex;\r\n  align-items: center;\r\n  justify-content: center;\r\n  width: 34px;\r\n  height: 34px;\r\n  border-radius: 50%;\r\n  border: none;\r\n  background: transparent;\r\n  cursor: pointer;\r\n  padding: 0;\r\n  transition: background-color 0.15s ease, color 0.15s ease;\r\n  color: light-dark(rgb(83, 100, 113), rgb(113, 118, 123));\r\n  outline: none;\r\n}\r\n\r\n.twblock-btn:focus-visible {\r\n  box-shadow: 0 0 0 2px rgb(29, 155, 240);\r\n}\r\n\r\n.twblock-btn svg {\r\n  width: 20px;\r\n  height: 20px;\r\n  fill: currentColor;\r\n  pointer-events: none;\r\n}\r\n\r\n/* ブロックボタン: ホバーで赤 */\r\n.twblock-block:hover:not(:disabled) {\r\n  background-color: rgba(244, 33, 46, 0.1);\r\n  color: rgb(244, 33, 46);\r\n}\r\n\r\n/* ミュートボタン: ホバーでオレンジ */\r\n.twblock-mute:hover:not(:disabled) {\r\n  background-color: rgba(255, 173, 31, 0.1);\r\n  color: rgb(255, 173, 31);\r\n}\r\n\r\n/* ローディング状態 */\r\n.twblock-loading {\r\n  opacity: 0.5;\r\n  pointer-events: none;\r\n}\r\n\r\n.twblock-loading svg {\r\n  animation: twblock-spin 0.8s linear infinite;\r\n}\r\n\r\n@keyframes twblock-spin {\r\n  from { transform: rotate(0deg); }\r\n  to { transform: rotate(360deg); }\r\n}\r\n\r\n/* 成功状態: 緑 (クリックで解除可能) */\r\n.twblock-success {\r\n  color: rgb(0, 186, 124) !important;\r\n}\r\n\r\n.twblock-success:hover {\r\n  background-color: rgba(244, 33, 46, 0.1) !important;\r\n  color: rgb(244, 33, 46) !important;\r\n}\r\n\r\n/* エラー状態 */\r\n.twblock-error {\r\n  color: rgb(244, 33, 46) !important;\r\n  animation: twblock-shake 0.3s ease;\r\n}\r\n\r\n@keyframes twblock-shake {\r\n  0%, 100% { transform: translateX(0); }\r\n  25% { transform: translateX(-3px); }\r\n  75% { transform: translateX(3px); }\r\n}\r\n\r\n/* ---- ブロック/ミュート後の非表示バー ---- */\r\n.twblock-hidden-bar {\r\n  display: flex;\r\n  align-items: center;\r\n  justify-content: center;\r\n  gap: 12px;\r\n  padding: 12px 16px;\r\n  border-bottom: 1px solid light-dark(rgb(239, 243, 244), rgb(47, 51, 54));\r\n  font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, Helvetica, Arial, sans-serif;\r\n}\r\n\r\n.twblock-hidden-label {\r\n  color: rgb(113, 118, 123);\r\n  font-size: 14px;\r\n}\r\n\r\n.twblock-show-btn {\r\n  background: none;\r\n  border: 1px solid light-dark(rgb(207, 217, 222), rgb(83, 100, 113));\r\n  border-radius: 16px;\r\n  color: light-dark(rgb(15, 20, 26), rgb(239, 243, 244));\r\n  font-size: 13px;\r\n  padding: 4px 14px;\r\n  cursor: pointer;\r\n  transition: background-color 0.15s ease;\r\n}\r\n\r\n.twblock-show-btn:hover {\r\n  background-color: light-dark(rgba(15, 20, 25, 0.1), rgba(239, 243, 244, 0.1));\r\n}\r\n\r\n/* ---- トースト通知 ---- */\r\n.twblock-toast {\r\n  position: fixed;\r\n  bottom: 40px;\r\n  left: 50%;\r\n  transform: translateX(-50%);\r\n  background: rgb(29, 155, 240);\r\n  color: rgb(255, 255, 255);\r\n  padding: 12px 24px;\r\n  border-radius: 4px;\r\n  font-size: 15px;\r\n  font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", Roboto, sans-serif;\r\n  z-index: 10000;\r\n  animation: twblock-toast-in 0.3s ease;\r\n}\r\n\r\n.twblock-toast-hide {\r\n  opacity: 0;\r\n  transition: opacity 0.3s ease;\r\n}\r\n\r\n@keyframes twblock-toast-in {\r\n  from { opacity: 0; transform: translateX(-50%) translateY(10px); }\r\n  to { opacity: 1; transform: translateX(-50%) translateY(0); }\r\n}\r\n\r\n";
    document.head.appendChild(style);
  }


// ---- 初期化 ----
  async function init() {
    injectCSS();
    cacheI18n();
    loadIconDebugFlag();
    installIconDebugHooks();
    injectPageScript();
    await loadStoredIcons();
    await loadSettings();
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
