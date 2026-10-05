// x-web harness, live mode: passive tap (MAIN world, document_start, x.com).
//
// Remembers the GraphQL requests the classic x.com app itself makes: the
// operation's persisted id, its feature switches and field toggles, and the
// request headers (bearer, client headers), plus the JSON it got back. Live
// mode reuses these to make its own reads and seeds its data with the
// responses. Read-only: requests are passed through untouched and responses
// are cloned. Nothing is sent anywhere.
(function () {
  'use strict';
  if (window.__xwhTap) return;
  const tap = window.__xwhTap = { ops: {}, responses: [], headers: null };
  const RE = /\/i\/api\/graphql\/([^/?]+)\/(\w+)/;
  const MAX_RESPONSES = 60;

  function parseJson(s) { try { return JSON.parse(s); } catch (err) { return undefined; } }

  function record(url, method, headers, body) {
    const m = String(url).match(RE);
    if (!m) return null;
    const [, id, name] = m;
    let features;
    let fieldToggles;
    let variables;
    if (method === 'POST' && body) {
      const b = parseJson(body) || {};
      features = b.features; fieldToggles = b.fieldToggles; variables = b.variables;
    } else {
      const u = new URL(url, location.href);
      features = parseJson(u.searchParams.get('features') || 'null');
      fieldToggles = parseJson(u.searchParams.get('fieldToggles') || 'null');
      variables = parseJson(u.searchParams.get('variables') || 'null');
    }
    tap.ops[name] = { id, method, features: features || {}, fieldToggles: fieldToggles || null };
    if (headers && headers.authorization) {
      tap.headers = {
        authorization: headers.authorization,
        'x-twitter-auth-type': headers['x-twitter-auth-type'] || 'OAuth2Session',
        'x-twitter-active-user': headers['x-twitter-active-user'] || 'yes',
        'x-twitter-client-language': headers['x-twitter-client-language'] || 'en',
      };
    }
    return { name, variables };
  }
  function keep(rec, json) {
    if (!rec || !json || typeof json !== 'object') return;
    tap.responses.push({ name: rec.name, variables: rec.variables, json, at: Date.now() });
    if (tap.responses.length > MAX_RESPONSES) tap.responses.shift();
  }
  function lower(h) {
    const o = {};
    if (!h) return o;
    if (typeof Headers !== 'undefined' && h instanceof Headers) { h.forEach((v, k) => { o[k.toLowerCase()] = v; }); return o; }
    for (const k of Object.keys(h)) o[k.toLowerCase()] = h[k];
    return o;
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (RE.test(url)) {
        const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        const rec = record(url, method, lower((init && init.headers) || (input && input.headers)), init && typeof init.body === 'string' ? init.body : null);
        p.then((r) => r.clone().json().then((j) => keep(rec, j)).catch(() => {})).catch(() => {});
      }
    } catch (err) { /* never break the app */ }
    return p;
  };

  const XO = XMLHttpRequest.prototype;
  const open = XO.open;
  const setHeader = XO.setRequestHeader;
  const send = XO.send;
  XO.open = function (method, url) {
    this.__xwh = RE.test(String(url)) ? { method: String(method).toUpperCase(), url: String(url), headers: {} } : null;
    return open.apply(this, arguments);
  };
  XO.setRequestHeader = function (k, v) {
    if (this.__xwh) this.__xwh.headers[String(k).toLowerCase()] = v;
    return setHeader.apply(this, arguments);
  };
  XO.send = function (body) {
    const x = this.__xwh;
    if (x) {
      try {
        const rec = record(x.url, x.method, x.headers, typeof body === 'string' ? body : null);
        this.addEventListener('load', () => {
          try { keep(rec, this.responseType === 'json' ? this.response : parseJson(this.responseText)); } catch (err) { /* ignore */ }
        });
      } catch (err) { /* ignore */ }
    }
    return send.apply(this, arguments);
  };
})();
