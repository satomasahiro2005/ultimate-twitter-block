(function () {
  'use strict';

  if (window.__twblockPageScriptLoaded) return;
  window.__twblockPageScriptLoaded = true;

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

  const API_BASE = 'https://x.com/i/api/1.1/';

  // レスポンス本文から Twitter API の errors[].code を取り出す。
  // 表示用の文言は content.js 側で i18n から解決するので、ここでは返さない。
  async function readErrorCode(response) {
    try {
      const data = await response.clone().json();
      if (data && Array.isArray(data.errors) && data.errors.length) {
        const code = Number(data.errors[0].code);
        return Number.isFinite(code) ? code : null;
      }
    } catch (err) {
      // JSON以外のエラー本文は無視する
    }
    return null;
  }

  async function apiPost(url, body, headers) {
    return originalFetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      credentials: 'include',
      body,
    });
  }

  // ブロック/ミュートAPIを呼び出す
  async function performAction(action, screenName) {
    const headers = getHeaders();
    if (!headers) {
      return { success: false, error: 'NO_AUTH' };
    }

    const endpoints = {
      block: API_BASE + 'blocks/create.json',
      unblock: API_BASE + 'blocks/destroy.json',
      mute: API_BASE + 'mutes/users/create.json',
      unmute: API_BASE + 'mutes/users/destroy.json',
    };

    const url = endpoints[action];
    if (!url) {
      return { success: false, error: 'INVALID_ACTION' };
    }

    const body = 'screen_name=' + encodeURIComponent(screenName);

    try {
      const response = await apiPost(url, body, headers);

      if (response.ok) {
        const data = await response.json().catch(() => null);
        return { success: true, data };
      }

      let last = response;
      let code = await readErrorCode(response);

      // 403: CSRFトークン失効 → ct0 cookieから再取得してリトライ。
      // ct0 が変わっていないときは再送しないので、code 272 のような
      // 「APIとしての明示的な拒否」で余計なリクエストは飛ばない。
      if (response.status === 403) {
        const freshCsrf = getCsrfToken();
        if (freshCsrf && freshCsrf !== headers['x-csrf-token']) {
          const retryHeaders = { ...headers, 'x-csrf-token': freshCsrf };
          const retryResponse = await apiPost(url, body, retryHeaders);
          if (retryResponse.ok) {
            capturedHeaders = retryHeaders;
            const data = await retryResponse.json().catch(() => null);
            return { success: true, data };
          }
          // 判定材料は「最後に返ってきた応答」で上書きする。
          // 1回目がHTMLエラーページで2回目が code 272、のような組み合わせを取りこぼさない
          last = retryResponse;
          code = await readErrorCode(retryResponse);
        }
      }

      if (last.status === 429) {
        return { success: false, error: 'RATE_LIMITED', code };
      }

      // 401 は実質「ログインが切れている」なので 403 と同じ案内にする
      if (last.status === 403 || last.status === 401) {
        return { success: false, error: 'FORBIDDEN', code };
      }

      return { success: false, error: 'HTTP_' + last.status, code };
    } catch (err) {
      return { success: false, error: 'NETWORK', code: null };
    }
  }

  // フォロー状態を確認するAPI
  // 判定できなかったときは following:false ではなく unknown:true を返す。
  // false を返すと「フォロー中の相手をブロックする前に確認」が黙って無効になる
  async function checkFollowing(screenName) {
    const headers = getHeaders();
    if (!headers) {
      return { following: false, unknown: true };
    }

    try {
      const url = API_BASE + 'friendships/show.json?source_screen_name=&target_screen_name=' + encodeURIComponent(screenName);
      const response = await originalFetch(url, {
        method: 'GET',
        headers: { ...headers },
        credentials: 'include',
      });

      if (response.ok) {
        const data = await response.json().catch(() => null);
        const source = data && data.relationship && data.relationship.source;
        if (!source) return { following: false, unknown: true };
        return { following: source.following === true };
      }
      return { following: false, unknown: true };
    } catch (err) {
      return { following: false, unknown: true };
    }
  }

  // content.jsからのメッセージを受信
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data.requestId !== 'string') return;

    let result = null;
    if (data.type === '__TWBLOCK_ACTION') {
      result = await performAction(data.action, data.screenName);
    } else if (data.type === '__TWBLOCK_CHECK_FOLLOWING') {
      result = await checkFollowing(data.screenName);
    } else {
      return;
    }

    window.postMessage(
      { type: '__TWBLOCK_RESULT', requestId: data.requestId, ...result },
      '*'
    );
  });

  // 準備完了を通知
  window.postMessage({ type: '__TWBLOCK_READY' }, '*');
})();
