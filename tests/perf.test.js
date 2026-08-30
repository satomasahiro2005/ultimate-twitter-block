#!/usr/bin/env node
'use strict';

// X が出し続ける無関係なDOM変化に対して、拡張が1秒に何回スキャンし直すかを測る。
//
//   node tests/perf.test.js [userscript.js]
//
// 実測（x.com/home, 2026-08-30）: いいね数のアニメーション span[app-text-transition-container]
// だけで childList が 4秒に 8,940 件動く。observer がそれ全部に反応すると
// processAll が毎フレーム走り、その仕事がキー入力と同じフレームに乗る。
//
// 回数の数え方: 「行が見つからない Follow ボタン」を1つ置いておく。旧実装はこれを
// 毎パス触り直す（data-twblock を付けて外す）ので、属性の書き換え回数がパス数になる。
// 新実装では (1) 無関係な変化ではパスが走らない (2) 取れない相手は数回で諦める の
// 両方が効くので、この数は数回で止まる。旧実装との比較で見ること。

const fs = require('fs');
const path = require('path');

const { ROOT, findChrome, loadPuppeteer, startServer } = require('./helpers');
const USERSCRIPT = process.argv[2] || path.join(ROOT, 'userscripts', 'twitter-block.user.js');
const MEASURE_MS = Number(process.env.MEASURE_MS || 3000);
const MAX_PASSES_PER_SEC = Number(process.env.MAX_PASSES_PER_SEC || 15);


(async () => {
  const puppeteer = loadPuppeteer();
  const chromePath = findChrome();
  if (!puppeteer || !chromePath) {
    if (process.env.REQUIRE_BROWSER) {
      console.error('REQUIRE_BROWSER is set but puppeteer-core or Chrome is not available');
      process.exit(1);
    }
    console.log('SKIP: puppeteer-core or Chrome not available');
    process.exit(0);
  }

  const script = fs.readFileSync(USERSCRIPT, 'utf8');
  const server = await startServer();
  const port = server.address().port;
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-sandbox'] });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 900 });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });

    await page.evaluate(() => {
      history.replaceState({}, '', '/home');
      document.cookie = 'twid=u%3D2001261086327328768';
      document.cookie = 'ct0=testcsrftoken';
      window.fetch = () => Promise.resolve({
        ok: true, status: 200, clone() { return this; },
        json: () => Promise.resolve({ ok: 1 }), text: () => Promise.resolve(''),
      });
    });

    // X のいいね数アニメーションを再現する（span を足しては消すだけの無関係な変化）
    await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'churn';
      host.innerHTML = '<span app-text-transition-container><span>113%</span></span>';
      document.body.appendChild(host);
      const box = host.firstElementChild;
      window.__churn = 0;
      window.__churnTimer = setInterval(() => {
        const s = document.createElement('span');
        s.textContent = String(Math.random()).slice(2, 6) + '%';
        box.appendChild(s);
        if (box.children.length > 2) box.firstElementChild.remove();
        window.__churn += 2;
      }, 5);

      // 行が flex にならない Follow ボタン（＝拡張が挿入先を見つけられない相手）
      const decoy = document.createElement('div');
      decoy.id = 'decoy';
      decoy.style.cssText = 'position:fixed;left:-9999px;top:0;display:block';
      decoy.innerHTML =
        '<div style="display:block"><div style="display:block">' +
        '<span>@decoyuser</span><div data-testid="9999-follow" style="display:block">Follow</div>' +
        '</div></div>';
      document.body.appendChild(decoy);
    });

    await page.evaluate(script);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 800)));

    const result = await page.evaluate((ms) => new Promise((resolve) => {
      const btn = document.querySelector('[data-testid="9999-follow"]');
      const state = { attrWrites: 0, churn: 0 };
      const mo = new MutationObserver((rs) => { state.attrWrites += rs.length; });
      mo.observe(btn, { attributes: true, attributeFilter: ['data-twblock', 'data-twblock-retry'] });
      const churn0 = window.__churn;
      const t0 = performance.now();
      setTimeout(() => {
        mo.disconnect();
        clearInterval(window.__churnTimer);
        const dur = performance.now() - t0;
        state.churn = window.__churn - churn0;
        resolve({ dur: Math.round(dur), attrWrites: state.attrWrites, churn: state.churn });
      }, ms);
    }), MEASURE_MS);

    // 属性の書き換えは1パスにつき2回（付ける/外す）
    const passes = result.attrWrites / 2;
    const perSec = +(passes / (result.dur / 1000)).toFixed(1);
    const churnPerSec = Math.round(result.churn / (result.dur / 1000));
    console.log(`userscript: ${path.relative(ROOT, USERSCRIPT) || USERSCRIPT}`);
    console.log(`無関係なDOM変化: ${churnPerSec}/秒`);
    console.log(`拡張の再スキャン: ${perSec}/秒 (${passes} passes / ${result.dur}ms)`);
    const ok = perSec <= MAX_PASSES_PER_SEC;
    console.log(`${ok ? 'PASS' : 'FAIL'}  無関係な変化で再スキャンが走り続けない (<= ${MAX_PASSES_PER_SEC}/秒)`);

    // 毎パス隠し直さない代わりに、畳んだ中身は CSS でも隠れていること。
    // 画像の遅延ロードのように後から足される子が、ここで漏れると本文が見えてしまう
    const collapse = await page.evaluate(() => {
      const box = document.createElement('div');
      box.setAttribute('data-twblock-collapsed', '1');
      const bar = document.createElement('div');
      bar.className = 'twblock-hidden-bar';
      bar.textContent = 'bar';
      const late = document.createElement('div');
      late.textContent = 'あとから足された中身';
      box.appendChild(bar);
      box.appendChild(late);
      document.body.appendChild(box);
      return {
        lateHidden: getComputedStyle(late).display === 'none',
        barShown: getComputedStyle(bar).display !== 'none',
      };
    });
    console.log(`${collapse.lateHidden ? 'PASS' : 'FAIL'}  畳んだ後に足された子もCSSで隠れる`);
    console.log(`${collapse.barShown ? 'PASS' : 'FAIL'}  バー自体は隠れない`);

    process.exitCode = (ok && collapse.lateHidden && collapse.barShown) ? 0 : 1;
  } finally {
    await browser.close();
    server.close();
  }
})();
