#!/usr/bin/env node
'use strict';

// x-web harness, fixture mode.
//
// Boots X's real x-web client (the saved bundle, see fetch-assets.js) through
// our own entry (xweb/entry.js) on https://x.com/... URLs, in a fresh Chrome
// profile with the unpacked extension installed, so content.js runs exactly
// as on x.com. x-web's GraphQL is answered in the page by runtime/resolver.js
// from fake data (data/fixtures.js -> data/xweb-graph.js). Every other request
// is served by puppeteer interception from local files; anything else is
// aborted and fails the run, and Chrome's DNS is pointed at nothing, so no
// request can reach X.
//
//   node tests/xweb-harness/run.js                         every shot at 1280px and 420px
//   node tests/xweb-harness/run.js --shot following        one shot (see --list)
//   node tests/xweb-harness/run.js --width 420
//   node tests/xweb-harness/run.js --no-extension          x-web alone (baseline)
//   node tests/xweb-harness/run.js --extension-path DIR    another build of the extension (e.g. before/after)
//   node tests/xweb-harness/run.js --out DIR               default tests/xweb-harness/out
//   node tests/xweb-harness/run.js --dump-ops DIR          save the GraphQL ASTs x-web sent
//   node tests/xweb-harness/run.js --list
//
// Library use (tests/dom.test.js):
//   const H = require('./xweb-harness/run.js');
//   const browser = await H.launch();
//   const { page } = await H.openShot(browser, 'following', { width: 420 });
//   const report = await H.measure(page);

const fs = require('fs');
const path = require('path');
const { buildEntry, buildHtml, STYLES_FILE } = require('./xweb/entry.js');

const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');
const CACHE = path.join(HERE, '.cache');
const BUNDLE = path.join(CACHE, 'bundle');
const FONTS = path.join(CACHE, 'fonts');
const DESKTOP = { width: 1280, height: 900 };
// Tall enough that x-web's virtualized timelines render every fixture entry.
const SHOT_HEIGHT = 2400;

const PAGE_SCRIPTS = ['runtime/resolver.js', 'data/fixtures.js', 'data/xweb-graph.js'];

// ---------------------------------------------------------------- shots
// id -> { path(fx), loggedOut, hover?(selector) }
function shotTable() {
  const fx = require('./data/fixtures.js').build({ loggedIn: true });
  const I = fx.ids;
  const T = (k) => fx.tweets[I[k]];
  const S = [
    { id: 'home', path: '/home' },
    { id: 'profile', path: '/fake_alice', loggedOutToo: true },
    { id: 'profile-self', path: '/fake_me' },
    { id: 'profile-blocked', path: '/fake_frank' },
    { id: 'profile-protected', path: '/fake_erin' },
    { id: 'following', path: '/fake_me/following' },
    { id: 'followers', path: '/fake_me/followers' },
    { id: 'verified-followers', path: '/fake_me/verified_followers' },
    { id: 'following-other', path: '/fake_alice/following' },
    { id: 'tweet-detail', path: '/fake_alice/status/' + T('focal').id, loggedOutToo: true },
    { id: 'search-top', path: '/search?q=fake&src=typed_query' },
    { id: 'search-people', path: '/search?q=fake&src=typed_query&f=user' },
    { id: 'notifications', path: '/notifications' },
    { id: 'blocked', path: '/settings/blocked/all' },
    { id: 'muted', path: '/settings/muted/all' },
    { id: 'connect', path: '/i/connect_people' },
    // the real hover card: hover a tweet author's avatar on a profile
    { id: 'hovercard', path: '/fake_alice', hover: 'a[href="/fake_ivan"] img, a[href="/fake_heidi"] img', loggedOutToo: true },
  ];
  const out = [];
  for (const s of S) {
    out.push(Object.assign({}, s, { loggedOut: false }));
    if (s.loggedOutToo) out.push(Object.assign({}, s, { id: s.id + '--logged-out', loggedOut: true }));
  }
  return out;
}

function resolveShot(id) {
  const shot = shotTable().find((s) => s.id === id);
  if (!shot) throw new Error('unknown shot ' + id + ' (try --list)');
  return shot;
}

// ---------------------------------------------------------------- assets
function bundleReady() {
  return fs.existsSync(path.join(BUNDLE, 'entry-client-logged-out-CTyqM7Ot.js')) && fs.existsSync(path.join(BUNDLE, STYLES_FILE));
}

const PALETTE = ['#1d9bf0', '#f91880', '#00ba7c', '#7856ff', '#ff7a00', '#ffd400', '#536471', '#0f1419'];
function placeholderSvg(u) {
  let hash = 0;
  for (const ch of u.pathname) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const color = PALETTE[hash % PALETTE.length];
  if (/profile_images/.test(u.pathname)) {
    const id = (u.pathname.match(/\/(\d+)_/) || [])[1] || '?';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><rect width="400" height="400" fill="${color}"/><text x="200" y="250" font-family="Arial" font-size="150" fill="#fff" text-anchor="middle">${id.slice(-2)}</text></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="500" viewBox="0 0 1500 500"><rect width="1500" height="500" fill="${color}"/><text x="750" y="280" font-family="Arial" font-size="60" fill="#fff" text-anchor="middle">fake image</text></svg>`;
}

function bootScript(loggedIn) {
  return `(function(){
  var fx = XWH.fixtures.build({ loggedIn: ${loggedIn} });
  var graph = XWH_GRAPH.build(fx);
  XWH_RT.root = graph.root;
  XWH_RT.graph = graph;
  XWH_RT.viewer = ${loggedIn} ? XWH_GRAPH.viewerOf(fx) : null;
  XWH_RT.installFetch();
})();`;
}

// ---------------------------------------------------------------- browser
function helpers() { return require(path.join(ROOT, 'tests', 'helpers.js')); }

async function launch(opts) {
  opts = opts || {};
  const puppeteer = helpers().loadPuppeteer();
  const chrome = helpers().findChrome();
  if (!puppeteer || !chrome) throw new Error('puppeteer-core or Chrome not available');
  if (!bundleReady()) throw new Error('x-web bundle missing: run `node tests/xweb-harness/fetch-assets.js` once (see README)');
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: opts.headless === false ? false : true,
    pipe: true,
    enableExtensions: opts.extension !== false,
    args: [
      '--no-sandbox',
      // Even a request that escaped interception would resolve nowhere.
      '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost',
      '--no-first-run', '--no-default-browser-check', '--disable-sync',
      '--disable-background-networking', '--disable-component-update',
      '--disable-domain-reliability', '--disable-client-side-phishing-detection',
      '--lang=en-US',
    ],
  });
  if (opts.extension !== false) browser.__xwhExtensionId = await browser.installExtension(opts.extensionPath || ROOT);
  return browser;
}

const entryCache = {};
function entryFor(loggedIn) {
  const k = loggedIn ? 'in' : 'out';
  if (!entryCache[k]) entryCache[k] = buildEntry(BUNDLE, { loggedIn });
  return entryCache[k];
}

// Shift Date so that the page starts at `now` and then runs normally.
function clockScript(now) {
  const RealDate = Date;
  const offset = now - RealDate.now();
  function FakeDate(...a) {
    if (!new.target) return new RealDate(RealDate.now() + offset).toString();
    return a.length ? new RealDate(...a) : new RealDate(RealDate.now() + offset);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => RealDate.now() + offset;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  Object.setPrototypeOf(FakeDate, RealDate);
  window.Date = FakeDate;
}

// Serve one page. Returns { page, unserved, served(), rt() }.
async function openPage(browser, urlPath, opts) {
  opts = opts || {};
  const loggedIn = opts.loggedIn !== false;
  const width = opts.width || DESKTOP.width;
  const page = await browser.newPage();
  await page.setViewport({ width, height: opts.height || SHOT_HEIGHT, deviceScaleFactor: 1 });
  // Pin the clock to the fixtures' "now" so relative times are stable.
  await page.evaluateOnNewDocument(clockScript, require('./data/fixtures.js').NOW);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  // Cookies are shared by every page of the browser: a logged-out page must drop the session.
  if (!loggedIn) {
    await page.deleteCookie({ name: 'twid', domain: '.x.com' }, { name: 'ct0', domain: '.x.com' });
  } else {
    await page.setCookie(
      { name: 'twid', value: 'u%3D1001', domain: '.x.com', path: '/', secure: true },
      { name: 'ct0', value: 'xwh-fake-csrf', domain: '.x.com', path: '/', secure: true });
  }
  const scripts = PAGE_SCRIPTS.map((f) => fs.readFileSync(path.join(HERE, f), 'utf8')).concat([bootScript(loggedIn)]);
  const fx = require('./data/fixtures.js').build({ loggedIn });
  const viewer = loggedIn ? require('./data/xweb-graph.js').viewerOf(fx) : null;
  const html = buildHtml({ viewer, scripts });
  const entry = entryFor(loggedIn);
  const unserved = [];
  const apiCalls = [];
  const telemetry = [];
  const cors = { 'access-control-allow-origin': '*' };

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const raw = req.url();
    let u;
    try { u = new URL(raw); } catch (err) { unserved.push(raw); return req.abort(); }
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'chrome-extension:') return req.continue();
    const host = u.hostname;
    if ((host === 'x.com' || host === 'twitter.com') && req.resourceType() === 'document') {
      return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    }
    if (host === 'abs.twimg.com' && u.pathname === '/x-web/x-web/xwh-entry.js') {
      return req.respond({ status: 200, contentType: 'text/javascript', headers: cors, body: entry });
    }
    if (host === 'abs.twimg.com' && u.pathname.startsWith('/x-web/x-web/')) {
      const f = path.join(BUNDLE, path.basename(u.pathname));
      if (fs.existsSync(f)) {
        const ext = path.extname(f);
        const type = { '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' }[ext] || 'application/octet-stream';
        return req.respond({ status: 200, contentType: type, headers: cors, body: fs.readFileSync(f) });
      }
      // an image asset that fetch-assets.js has not cached: placeholder
      if (/.(png|svg|webp|jpe?g|gif)$/.test(u.pathname)) return req.respond({ status: 200, contentType: 'image/svg+xml', headers: cors, body: placeholderSvg(u) });
    }
    if (host === 'abs.twimg.com' && u.pathname.startsWith('/fonts/')) {
      const f = path.join(FONTS, path.basename(u.pathname));
      if (fs.existsSync(f)) return req.respond({ status: 200, contentType: 'font/woff2', headers: cors, body: fs.readFileSync(f) });
      return req.respond({ status: 404, headers: cors, body: '' });
    }
    if (host === 'pbs.twimg.com' || host === 'video.twimg.com' || host === 'ton.twimg.com' || (host === 'abs.twimg.com' && /^\/(sticky|images|emoji|hashflags)\//.test(u.pathname))) {
      return req.respond({ status: 200, contentType: 'image/svg+xml', headers: cors, body: placeholderSvg(u) });
    }
    if ((host === 'x.com' || host === 'twitter.com') && u.pathname.startsWith('/i/api/')) {
      // The extension's own block/mute/lookup calls: record, answer locally, never forward.
      apiCalls.push({ method: req.method(), url: raw, body: req.postData() || null });
      return req.respond({ status: 200, contentType: 'application/json', body: '{}' });
    }
    if (host === 'x.com' && /^\/(favicon\.ico|manifest\.json|apple-touch-icon\.png)$/.test(u.pathname)) return req.respond({ status: 204, body: '' });
    // x-web telemetry that does not go through window.fetch (Sentry's own
    // transport, scribe beacons): swallowed here, nothing is forwarded.
    if (/(^|\.)sentry\.io$/.test(host) || host === 'api.x.com' || host === 'api.twitter.com') {
      telemetry.push(req.method() + ' ' + u.origin + u.pathname);
      if (req.method() === 'OPTIONS') {
        return req.respond({ status: 204, headers: { 'access-control-allow-origin': 'https://x.com', 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': req.headers()['access-control-request-headers'] || 'content-type' } });
      }
      return req.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': 'https://x.com', 'access-control-allow-credentials': 'true' }, body: '{}' });
    }
    // Third-party sign-in SDKs the logged-out shell loads: empty scripts.
    if (host === 'accounts.google.com' || host === 'appleid.cdn-apple.com') return req.respond({ status: 200, contentType: 'text/javascript', body: '' });
    unserved.push(req.method() + ' ' + raw);
    return req.abort('blockedbyclient');
  });

  await page.goto('https://x.com' + urlPath, { waitUntil: 'load' });
  await waitIdle(page, opts.timeout || 15000);
  return { page, unserved, apiCalls, telemetry };
}

// Idle = the router has settled, no GraphQL request is being answered, none was
// answered for 300ms, and the network (x-web's lazily loaded chunks, images) has
// been quiet for 400ms; repeated until all hold at once. Then fonts.
async function waitIdle(page, timeout) {
  const until = Date.now() + timeout;
  const rtIdle = () => page.waitForFunction(() => {
    const RT = window.XWH_RT;
    if (!RT || !RT.router) return false;
    const st = RT.router.state;
    if (st.status !== 'idle' || st.isLoading || RT.pending > 0) return false;
    const n = RT.served.length;
    if (RT.__lastN !== n) { RT.__lastN = n; RT.__lastAt = performance.now(); return false; }
    return performance.now() - RT.__lastAt > 300;
  }, { timeout: Math.max(until - Date.now(), 1), polling: 50 });
  for (;;) {
    await rtIdle();
    const before = await page.evaluate(() => window.XWH_RT.served.length);
    await page.waitForNetworkIdle({ idleTime: 400, timeout: Math.max(until - Date.now(), 1) });
    const again = await page.evaluate(() => ({ n: window.XWH_RT.served.length, pending: window.XWH_RT.pending }));
    if (again.n === before && again.pending === 0) break;
    if (Date.now() > until) throw new Error('waitIdle: page kept loading for ' + timeout + 'ms');
  }
  await page.evaluate(() => document.fonts && document.fonts.ready);
}

function settle(page, ms) {
  return page.evaluate((t) => new Promise((r) => setTimeout(() => requestAnimationFrame(() => r()), t)), ms);
}

async function openShot(browser, id, opts) {
  opts = opts || {};
  const shot = resolveShot(id);
  const res = await openPage(browser, shot.path, Object.assign({}, opts, { loggedIn: !shot.loggedOut }));
  if (shot.hover) {
    const el = await res.page.$(shot.hover);
    if (el) {
      await el.hover();
      await settle(res.page, 700);
      await waitIdle(res.page, 5000).catch(() => {});
    } else {
      res.hoverMissing = true;
    }
  }
  await settle(res.page, opts.extensionWait == null ? 1000 : opts.extensionWait);
  return Object.assign(res, { shot });
}

// Where did the extension draw, relative to x-web's own controls?
// For each .twblock-btn-container: its box, the nearest x-web control it is
// meant to sit beside (⋯ in a post header, Follow/Following in a user row,
// profile header or hover card), vertical-centre offset, gap, overlap, clipping.
async function measure(page) {
  return page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; };
    const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const isFollowish = (b) => /^(follow|following|follow back|pending|unblock|blocked|unmute|edit profile|cancel)/i.test((b.textContent || '').trim());
    const rows = [];
    for (const c of document.querySelectorAll('.twblock-btn-container')) {
      if (!c.getClientRects().length) continue; // in a hidden column (e.g. the sidebar at phone width)
      const art = c.closest('article');
      let anchor = null;
      let kind = 'other';
      if (art) {
        kind = art.parentElement && art.parentElement.closest('article') ? 'quote' : 'post';
        anchor = [...art.querySelectorAll('svg[data-icon="icon-more"]')].map((s) => s.closest('button')).find((b) => b && b.closest('article') === art) || null;
      }
      if (!anchor) {
        // nearest Follow-like button that shares an ancestor within 5 levels
        let p = c.parentElement;
        for (let i = 0; i < 5 && p && !anchor; i++, p = p.parentElement) {
          anchor = [...p.querySelectorAll('button, a[role="button"], a[href="/settings/profile"]')].find((b) => !c.contains(b) && isFollowish(b)) || null;
        }
        if (anchor && kind === 'other') kind = 'follow-row';
      }
      const cb = box(c);
      const row = { kind, screenName: c.getAttribute('data-screen-name'), classes: c.className, box: cb, buttons: [...c.querySelectorAll('button')].map(box) };
      if (anchor) {
        const ab = box(anchor);
        row.anchor = { text: (anchor.getAttribute('aria-label') || anchor.textContent || '').trim().slice(0, 30), box: ab };
        row.dyCenter = Math.round((cb.y + cb.h / 2) - (ab.y + ab.h / 2));
        row.gapX = cb.x + cb.w <= ab.x ? ab.x - (cb.x + cb.w) : (ab.x + ab.w <= cb.x ? cb.x - (ab.x + ab.w) : 0);
        row.overlapsAnchor = overlap(cb, ab);
      }
      let p = c.parentElement;
      while (p && p !== document.body) {
        const s = getComputedStyle(p);
        if (/(hidden|clip)/.test(s.overflow + s.overflowX + s.overflowY)) {
          const pb = box(p);
          if (cb.x < pb.x || cb.x + cb.w > pb.x + pb.w + 1 || cb.y < pb.y || cb.y + cb.h > pb.y + pb.h + 1) { row.clippedBy = String(p.className).slice(0, 80); break; }
        }
        p = p.parentElement;
      }
      row.offscreen = cb.x < 0 || cb.x + cb.w > innerWidth;
      rows.push(row);
    }
    const bars = [...document.querySelectorAll('.twblock-hidden-bar')].map((b) => ({ text: b.textContent.trim().slice(0, 80), box: box(b) }));
    const RT = window.XWH_RT || {};
    return {
      url: location.pathname + location.search,
      route: RT.router ? RT.router.state.matches.map((m) => m.routeId + (m.status !== 'success' ? ':' + m.status : '')) : null,
      containers: rows,
      hiddenBars: bars,
      graphql: (RT.served || []).map((s) => s.name),
      misses: RT.misses,
      runtimeLog: RT.log,
    };
  });
}

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
  const a = { widths: [DESKTOP.width, 420], out: path.join(HERE, 'out'), extension: true };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--shot' || k === '--screen') a.shot = argv[++i];
    else if (k === '--width') a.widths = [Number(argv[++i])];
    else if (k === '--out') a.out = path.resolve(argv[++i]);
    else if (k === '--no-extension') a.extension = false;
    else if (k === '--extension-path') a.extensionPath = path.resolve(argv[++i]);
    else if (k === '--dump-ops') a.dumpOps = path.resolve(argv[++i]);
    else if (k === '--list') a.list = true;
    else if (k === '--headful') a.headful = true;
    else throw new Error('unknown arg ' + k);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  const table = shotTable();
  if (args.list) { table.forEach((s) => console.log(s.id.padEnd(30) + s.path)); return; }
  const ids = args.shot
    ? table.filter((s) => s.id === args.shot || s.id === args.shot + '--logged-out').map((s) => s.id)
    : table.map((s) => s.id);
  if (!ids.length) throw new Error('no shot matches ' + args.shot);
  fs.mkdirSync(args.out, { recursive: true });
  const browser = await launch({ extension: args.extension, extensionPath: args.extensionPath, headless: !args.headful });
  const summary = [];
  let failures = 0;
  try {
    for (const id of ids) {
      for (const width of args.widths) {
        const t0 = Date.now();
        const name = id + '@' + width;
        let res;
        try {
          res = await openShot(browser, id, { width });
        } catch (err) {
          failures++;
          console.error(name + ': ' + err.message);
          continue;
        }
        const { page, unserved, apiCalls, telemetry } = res;
        await page.screenshot({ path: path.join(args.out, name + '.png'), fullPage: true });
        fs.writeFileSync(path.join(args.out, name + '.html'), await page.evaluate(() => '<!DOCTYPE html>\n' + document.documentElement.outerHTML));
        const m = await measure(page);
        fs.writeFileSync(path.join(args.out, name + '.json'), JSON.stringify(Object.assign({ shot: id, width, apiCalls, unserved, telemetry, hoverMissing: res.hoverMissing || false }, m), null, 2));
        if (args.dumpOps) {
          fs.mkdirSync(args.dumpOps, { recursive: true });
          const ops = await page.evaluate(() => Object.entries(window.XWH_RT.ops).filter(([k, v]) => k === v.params.name).map(([k, v]) => [k, JSON.stringify(v)]));
          for (const [k, v] of ops) fs.writeFileSync(path.join(args.dumpOps, k + '.json'), v);
        }
        if (unserved.length) { failures++; console.error('UNSERVED REQUESTS on ' + name + ':\n  ' + unserved.join('\n  ')); }
        summary.push({ name, path: res.shot.path, ms: Date.now() - t0, route: (m.route || []).slice(-1)[0], gql: m.graphql.length, buttons: m.containers.length, bars: m.hiddenBars.length, unserved: unserved.length });
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.table(summary);
  console.log('output: ' + args.out);
  if (failures) { console.error(`FAIL: ${failures} problem(s) above`); process.exit(1); }
}

module.exports = { launch, openPage, openShot, measure, settle, waitIdle, shotTable, DESKTOP };

if (require.main === module) {
  main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
}
