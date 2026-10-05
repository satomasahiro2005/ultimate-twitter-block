// x-web harness, live mode: runs once in the logged-in classic tab (MAIN world)
// when you switch to x-web. Gathers what the x-web page will need:
//   - the classic app's GraphQL operations (from the tap, then main.js) and its bearer
//   - the viewer, and everything the tap already saw (seeded into the model)
// Only reads. Also unregisters x.com's service worker so the next load comes
// from the network (where the dev extension holds back the classic app); x.com
// registers it again on the next normal visit.
// Evaluates to a Promise of { discovered, model, path }.
(async function collect() {
  'use strict';
  const X = window.XWH;
  const tap = window.__xwhTap || { ops: {}, responses: [], headers: null };

  // ---- operations: tap first (exact ids + features the app used), then main.js
  const ops = {};
  for (const [name, op] of Object.entries(tap.ops)) ops[name] = Object.assign({ type: 'query' }, op);
  let bearer = null;
  if (tap.headers && tap.headers.authorization) bearer = tap.headers.authorization.replace(/^Bearer\s+/i, '');
  const featureValues = {};
  try {
    const fs = window.__INITIAL_STATE__ && window.__INITIAL_STATE__.featureSwitch;
    const cfg = Object.assign({}, fs && fs.defaultConfig, fs && fs.user && fs.user.config);
    for (const k of Object.keys(cfg)) if (typeof cfg[k].value === 'boolean') featureValues[k] = cfg[k].value;
  } catch (err) { /* optional */ }
  const scripts = [...document.querySelectorAll('script[src]')].map((s) => s.src)
    .concat(performance.getEntriesByType('resource').map((e) => e.name))
    .filter((u, i, a) => /abs\.twimg\.com\/responsive-web\/.*\.js(\?|$)/.test(u) && a.indexOf(u) === i);
  const opRe = /queryId:"([^"]+)",operationName:"(\w+)",operationType:"(\w+)",metadata:\{featureSwitches:\[([^\]]*)\],fieldToggles:\[([^\]]*)\]/g;
  for (const src of scripts) {
    let text;
    try { text = await (await fetch(src)).text(); } catch (err) { continue; }
    if (!bearer) { const b = text.match(/AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%]+/); if (b) bearer = decodeURIComponent(b[0]); }
    let m;
    while ((m = opRe.exec(text))) {
      if (ops[m[2]]) { ops[m[2]].type = m[3]; continue; }
      const toggles = m[5] ? JSON.parse('[' + m[5] + ']') : [];
      ops[m[2]] = {
        id: m[1], type: m[3],
        features: m[4] ? JSON.parse('[' + m[4] + ']') : [],
        fieldToggles: toggles.length ? Object.fromEntries(toggles.map((t) => [t, false])) : null,
      };
    }
  }
  const discovered = { ops, bearer, headers: tap.headers, featureValues };

  // ---- model: viewer + whatever the classic app already fetched
  const model = X.reader.ensureShape({ viewerId: null });
  const twid = (document.cookie.match(/(?:^|; )twid=([^;]*)/) || [])[1];
  model.viewerId = twid ? decodeURIComponent(twid).replace(/^u=/, '') : null;
  X.reader.seed(model, tap.responses);
  const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  const me = link ? link.getAttribute('href').replace(/^\//, '') : null;
  if (!model.users[model.viewerId] && me) {
    const read = X.reader.makeReader(discovered, model);
    try { await read('user', { screenName: me }); } catch (err) { model.errors = [String(err.message || err)]; }
  }

  try {
    const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
    await Promise.all(regs.map((r) => r.unregister()));
  } catch (err) { /* ignore */ }

  return { discovered, model: JSON.parse(JSON.stringify(model)), path: location.pathname + location.search };
})();
