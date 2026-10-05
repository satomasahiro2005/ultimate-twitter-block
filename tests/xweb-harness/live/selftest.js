#!/usr/bin/env node
'use strict';

// Offline end-to-end test of live mode. A fake "classic" x.com (fake main.js
// with fake operation ids and bearer, fake twid/ct0 cookies, classic-shaped
// GraphQL responses built from the fixtures by classic-fake.js) stands in for
// the real site. Chrome gets both extensions: Ultimate Twitter Block and the
// live dev extension. The test switches the tab to x-web exactly as the
// toolbar button does, then navigates inside x-web so the on-demand reads run,
// then switches back. Nothing reaches the network.
//
//   node tests/xweb-harness/live/selftest.js [--out DIR]

const fs = require('fs');
const path = require('path');
const H = require('../run.js');
const fake = require('./classic-fake.js');
const { build } = require('./build.js');

const HERE = path.join(__dirname, '..');
const FONTS = path.join(HERE, '.cache', 'fonts');

const CLASSIC_HTML = `<!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Home / X (fake classic)</title></head>
<body style="margin:0;font-family:Arial"><div id="react-root"><nav style="padding:12px;border-bottom:1px solid #ccc">
<a data-testid="AppTabBar_Profile_Link" href="/fake_me">Profile</a> &middot; fake classic app</nav><div id="classic-marker">classic</div></div>
<script src="https://abs.twimg.com/responsive-web/client-web/main.fake0001.js"></script></body></html>`;

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const out = outIdx > 0 ? path.resolve(process.argv[outIdx + 1]) : path.join(HERE, 'out', 'live-selftest');
  fs.mkdirSync(out, { recursive: true });
  const ext = build();
  const browser = await H.launch({ extension: true });
  const devId = await browser.installExtension(ext);
  const failures = [];
  const ok = (name, cond, detail) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (cond ? '' : '  -> ' + detail)); if (!cond) failures.push(name); };
  const gql = [];
  const unserved = [];
  const telemetry = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1600 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.setCookie({ name: 'twid', value: 'u%3D1001', domain: '.x.com', path: '/', secure: true },
      { name: 'ct0', value: 'fakecsrf', domain: '.x.com', path: '/', secure: true });
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'chrome-extension:') return req.continue();
      if (u.hostname === 'x.com' && req.resourceType() === 'document') return req.respond({ status: 200, contentType: 'text/html', body: CLASSIC_HTML });
      if (u.hostname === 'x.com' && /^\/(favicon\.ico|manifest\.json)$/.test(u.pathname)) return req.respond({ status: 204, body: '' });
      const m = u.pathname.match(/^\/i\/api\/graphql\/fake(\w+)Id\/(\w+)$/);
      if (u.hostname === 'x.com' && m) {
        const h = req.headers();
        const vars = req.method() === 'POST' ? JSON.parse(req.postData()).variables : JSON.parse(u.searchParams.get('variables'));
        gql.push(m[2]);
        if (!/^Bearer AAAAAAAAAAAAAAAAAAAAAFAKE/.test(h.authorization || '') || h['x-csrf-token'] !== 'fakecsrf') failures.push('bad headers on ' + m[2]);
        const body = fake.respond(m[2], vars);
        return req.respond({ status: body ? 200 : 404, contentType: 'application/json', body: JSON.stringify(body || {}) });
      }
      if (u.hostname === 'x.com' && u.pathname.startsWith('/i/api/')) return req.respond({ status: 200, contentType: 'application/json', body: '{}' });
      if (u.hostname === 'abs.twimg.com' && /main\.fake0001\.js$/.test(u.pathname)) return req.respond({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: fake.fakeMainJs() });
      if (u.hostname === 'abs.twimg.com' && u.pathname.startsWith('/fonts/')) {
        const f = path.join(FONTS, path.basename(u.pathname));
        return fs.existsSync(f) ? req.respond({ status: 200, contentType: 'font/woff2', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(f) }) : req.respond({ status: 404, body: '' });
      }
      if (/(^|\.)twimg\.com$/.test(u.hostname)) return req.respond({ status: 200, contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' }, body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#7856ff"/></svg>' });
      // x-web telemetry: the dev extension blocks it with a DNR rule; puppeteer's
      // interception sees it first, so abort it here the same way
      if (/(^|.)sentry.io$/.test(u.hostname) || /^(api.x.com|accounts.google.com|appleid.cdn-apple.com)$/.test(u.hostname)) { telemetry.push(u.hostname); return req.abort('blockedbyclient'); }
      unserved.push(req.method() + ' ' + req.url());
      return req.abort('blockedbyclient');
    });

    await page.goto('https://x.com/home', { waitUntil: 'load' });
    ok('classic page loads with the tap', await page.evaluate(() => Boolean(window.__xwhTap && document.getElementById('classic-marker'))), 'no tap');

    const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://' + devId), { timeout: 10000 });
    const sw = await target.worker();
    const toggle = () => sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://x.com/*' });
      await self.xwhToggle(tab.id);
      return tab.id;
    });

    // ---- switch to x-web
    await toggle();
    await page.waitForFunction(() => window.XWH_RT && window.XWH_RT.router, { timeout: 20000 });
    await H.waitIdle(page, 20000);
    await H.settle(page, 1200);
    const home = await page.evaluate(() => ({
      classicGone: !document.getElementById('classic-marker'),
      route: window.XWH_RT.router.state.matches.map((m) => m.routeId).pop(),
      posts: document.querySelectorAll('[data-timeline-entry] > article').length,
      buttons: document.querySelectorAll('.twblock-btn-container').length,
      own: [...document.querySelectorAll('[data-timeline-entry]')].filter((e) => (e.getAttribute('data-href') || '').startsWith('/fake_me/status/')).map((e) => e.querySelectorAll('.twblock-btn-container').length),
      errors: window.XWH_RT.model.errors || [],
      served: window.XWH_RT.served.map((x) => x.name),
    }));
    await page.screenshot({ path: path.join(out, 'live-home@1280.png'), fullPage: false });
    ok('x-web replaced the classic app', home.classicGone && home.route === '/home', JSON.stringify(home));
    ok('home timeline came from the classic HomeTimeline read', home.posts >= 8 && gql.includes('HomeTimeline'), JSON.stringify({ home, gql }));
    ok('the block extension draws on it (not on own posts)', home.buttons >= 8 && home.own.every((n) => n === 0), JSON.stringify(home));

    // ---- navigate inside x-web: on-demand reads
    for (const [to, op, shot] of [['/fake_me/following', 'Following', 'following'], ['/fake_alice', 'UserTweets', 'profile'], ['/notifications', 'NotificationsTimeline', 'notifications']]) {
      await page.evaluate((p) => window.XWH_RT.router.navigate({ to: p }), to);
      await H.waitIdle(page, 20000);
      await H.settle(page, 1200);
      const r = await page.evaluate(() => ({
        path: location.pathname,
        cells: [...document.querySelectorAll('main [data-timeline-entry]')].length,
        buttons: [...document.querySelectorAll('main .twblock-btn-container')].length,
      }));
      await page.screenshot({ path: path.join(out, 'live-' + shot + '@1280.png'), fullPage: false });
      ok('navigate ' + to + ': read ' + op + ' on demand and render', r.path === to && gql.includes(op) && r.cells > 0 && r.buttons > 0, JSON.stringify({ r, gql }));
    }

    // ---- switch back
    await toggle();
    await page.waitForFunction(() => document.getElementById('classic-marker'), { timeout: 20000 });
    ok('switching back restores the classic app', await page.evaluate(() => !window.XWH_RT), 'x-web still there');
  } catch (err) {
    failures.push(String(err && err.stack || err));
    console.error(err);
  } finally {
    await browser.close();
  }
  // every operation the fake knows is a query; anything else would be a write
  const writes = gql.filter((n) => fake.OPS.indexOf(n) < 0);
  ok('only reads were sent', writes.length === 0, writes.join(','));
  ok('no unserved requests', unserved.length === 0, unserved.join(', '));
  console.log('graphql reads: ' + gql.join(', '));
  console.log('output: ' + out);
  if (failures.length) { console.error('FAIL: ' + failures.length); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
