(function () {
  'use strict';

  let capturedHeaders = null;
  const statusAuthorMap = new Map();
  const pendingStatusAuthorWaiters = new Map();
  let statusAuthorUpdateScheduled = false;

  function scheduleStatusAuthorUpdate() {
    if (statusAuthorUpdateScheduled) return;
    statusAuthorUpdateScheduled = true;
    setTimeout(() => {
      statusAuthorUpdateScheduled = false;
      window.postMessage({ type: '__TWBLOCK_STATUS_AUTHORS_UPDATED' }, '*');
    }, 0);
  }

  function notifyStatusAuthorResolved(statusId, screenName) {
    const waiters = pendingStatusAuthorWaiters.get(statusId);
    if (!waiters) return;
    pendingStatusAuthorWaiters.delete(statusId);
    for (const resolve of waiters) resolve(screenName);
  }

  function rememberStatusAuthor(statusId, screenName) {
    if (!/^\d+$/.test(statusId) || !/^[A-Za-z0-9_]{1,15}$/.test(screenName)) {
      return false;
    }
    if (statusAuthorMap.get(statusId) === screenName) {
      return false;
    }
    statusAuthorMap.set(statusId, screenName);
    notifyStatusAuthorResolved(statusId, screenName);
    scheduleStatusAuthorUpdate();
    return true;
  }

  function extractTweetScreenName(node) {
    return (
      node?.user?.screen_name ||
      node?.core?.user_results?.result?.legacy?.screen_name ||
      node?.core?.user_results?.result?.screen_name ||
      null
    );
  }

  function extractTweetIds(node) {
    const ids = [
      node?.rest_id,
      node?.legacy?.id_str,
      node?.id_str,
    ];
    return ids.filter((id, index) => typeof id === 'string' && /^\d+$/.test(id) && ids.indexOf(id) === index);
  }

  function isTweetLikeNode(node) {
    return Boolean(
      node &&
      typeof node === 'object' &&
      (
        node.__typename === 'Tweet' ||
        node.__typename === 'TweetWithVisibilityResults' ||
        node.user ||
        node.core?.user_results ||
        node.legacy?.conversation_id_str ||
        node.legacy?.user_id_str ||
        node.legacy?.full_text
      )
    );
  }

  function indexStatusAuthors(payload) {
    if (!payload || typeof payload !== 'object') return;

    const stack = [payload];
    const seen = new Set();

    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);

      if (isTweetLikeNode(node)) {
        const screenName = extractTweetScreenName(node);
        if (screenName) {
          for (const statusId of extractTweetIds(node)) {
            rememberStatusAuthor(statusId, screenName);
          }
        }
      }

      if (Array.isArray(node)) {
        for (const value of node) {
          if (value && typeof value === 'object') stack.push(value);
        }
        continue;
      }

      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') stack.push(value);
      }
    }
  }

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

  function maybeIndexApiResponse(url, response) {
    if (typeof url !== 'string' || !url.includes('/i/api/') || !response?.ok) {
      return;
    }

    const contentType = response.headers?.get('content-type') || '';
    if (!contentType.includes('application/json')) return;

    response.clone().json()
      .then((data) => { indexStatusAuthors(data); })
      .catch(() => {});
  }

  function waitForStatusAuthor(statusId, timeoutMs) {
    if (statusAuthorMap.has(statusId)) {
      return Promise.resolve(statusAuthorMap.get(statusId));
    }

    return new Promise((resolve) => {
      const waiters = pendingStatusAuthorWaiters.get(statusId) || [];
      waiters.push(resolve);
      pendingStatusAuthorWaiters.set(statusId, waiters);

      setTimeout(() => {
        const current = pendingStatusAuthorWaiters.get(statusId);
        if (!current) return;
        const index = current.indexOf(resolve);
        if (index >= 0) current.splice(index, 1);
        if (current.length === 0) {
          pendingStatusAuthorWaiters.delete(statusId);
        }
        resolve(null);
      }, timeoutMs);
    });
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
    const responsePromise = originalFetch.apply(this, args);
    responsePromise.then((response) => {
      maybeIndexApiResponse(url, response);
    }).catch(() => {});
    return responsePromise;
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

      this.addEventListener('loadend', () => {
        try {
          const contentType = this.getResponseHeader('content-type') || '';
          if (!contentType.includes('application/json')) return;
          if (this.responseType === 'json' && this.response) {
            indexStatusAuthors(this.response);
            return;
          }
          if (this.responseType && this.responseType !== '' && this.responseType !== 'text') return;
          if (typeof this.responseText !== 'string' || !this.responseText) return;
          indexStatusAuthors(JSON.parse(this.responseText));
        } catch (err) {
          // Ignore non-JSON or inaccessible responses.
        }
      }, { once: true });
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

  async function resolveTweetAuthor(statusId) {
    if (statusAuthorMap.has(statusId)) {
      return { screenName: statusAuthorMap.get(statusId) };
    }

    const waitedScreenName = await waitForStatusAuthor(statusId, 1500);
    if (waitedScreenName) {
      return { screenName: waitedScreenName };
    }

    const headers = getHeaders();
    if (!headers || !statusId) {
      return { screenName: null };
    }

    const url =
      'https://x.com/i/api/1.1/statuses/show.json?id=' +
      encodeURIComponent(statusId);

    try {
      const response = await originalFetch(url, {
        method: 'GET',
        headers: { ...headers },
        credentials: 'include',
      });

      if (response.ok) {
        const data = await response.json();
        const screenName = data.user?.screen_name || null;
        if (screenName) {
          rememberStatusAuthor(statusId, screenName);
        }
        return { screenName };
      }

      if (response.status === 403) {
        const freshCsrf = getCsrfToken();
        if (freshCsrf && freshCsrf !== headers['x-csrf-token']) {
          const retryResponse = await originalFetch(url, {
            method: 'GET',
            headers: {
              ...headers,
              'x-csrf-token': freshCsrf,
            },
            credentials: 'include',
          });
          if (retryResponse.ok) {
            capturedHeaders = { ...headers, 'x-csrf-token': freshCsrf };
            const data = await retryResponse.json();
            const screenName = data.user?.screen_name || null;
            if (screenName) {
              rememberStatusAuthor(statusId, screenName);
            }
            return { screenName };
          }
        }
      }

      return { screenName: null };
    } catch (err) {
      return { screenName: null };
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
    if (event.data && event.data.type === '__TWBLOCK_RESOLVE_STATUS_AUTHOR') {
      const { statusId, requestId } = event.data;
      const result = await resolveTweetAuthor(statusId);
      window.postMessage(
        { type: '__TWBLOCK_RESULT', requestId, ...result },
        '*'
      );
    }
  });

  // 準備完了を通知
  window.postMessage({ type: '__TWBLOCK_READY' }, '*');
})();
