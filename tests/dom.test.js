#!/usr/bin/env node
'use strict';

// 実ブラウザ(Chrome)上で、ビルド済みユーザースクリプトを X 風のDOMに当てて回帰を見る。
//
//   node tests/dom.test.js
//
// puppeteer-core と Chrome が要る。見つからない場合はスキップ扱いで exit 0。
// ユーザースクリプト版と拡張版は content.js を共有しているので、
// ここで通ることは拡張側のロジックが通ることでもある（ストレージ層だけが別）。

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const USERSCRIPT = path.join(ROOT, 'userscripts', 'twitter-block.user.js');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (err) { /* noop */ }
  }
  return null;
}

function loadPuppeteer() {
  const candidates = [
    'puppeteer-core',
    path.join(process.env.USERPROFILE || process.env.HOME || '', 'node_modules', 'puppeteer-core'),
  ];
  for (const id of candidates) {
    try { return require(id); } catch (err) { /* noop */ }
  }
  return null;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && !ok ? '  -> ' + detail : ''}`);
}

function startServer() {
  const server = http.createServer((req, res) => {
    const file = path.join(__dirname, 'fixture.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  server.on('error', (err) => {
    console.error('fixture server error: ' + err.message);
    process.exit(1);
  });
  // ポートは OS に選ばせる（固定だと他のプロセスと衝突する）
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

(async () => {
  const puppeteer = loadPuppeteer();
  const chromePath = findChrome();
  if (!puppeteer || !chromePath) {
    // CI ではスキップを緑にしない（環境構築が壊れても気づけなくなる）
    if (process.env.REQUIRE_BROWSER) {
      console.error('REQUIRE_BROWSER is set but puppeteer-core or Chrome is not available');
      process.exit(1);
    }
    console.log('SKIP: puppeteer-core or Chrome not available');
    process.exit(0);
  }
  if (!fs.existsSync(USERSCRIPT)) {
    console.error('build first: node build.js userscript');
    process.exit(1);
  }

  const script = fs.readFileSync(USERSCRIPT, 'utf8');
  const server = await startServer();
  const port = server.address().port;
  const browser = await puppeteer.launch({ executablePath: chromePath, headless: 'new', args: ['--no-sandbox'] });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 900 });

    // confirm() が出たら記録して承諾する（放置するとページが固まる）
    const dialogs = [];
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.accept();
    });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });

    // x.com のふりをする: URL・cookie・fetch を差し替えてから注入する
    await page.evaluate(() => {
      history.replaceState({}, '', '/me_myself/followers');
      document.cookie = 'twid=u%3D2001261086327328768';
      document.cookie = 'ct0=testcsrftoken';
      window.__apiCalls = [];
      window.__apiReply = { success: true };
      // friendships/show は別枠。既定は「フォローしていない」= 確認ダイアログ無し
      window.__followReply = { relationship: { source: { following: false } } };
      window.fetch = function (url, options) {
        const href = String(url);
        window.__apiCalls.push({ url: href, method: (options && options.method) || 'GET' });
        if (href.includes('friendships/show.json')) {
          const f = window.__followReply;
          if (f === null) {
            return Promise.resolve({
              ok: false, status: 429, clone() { return this; },
              json: () => Promise.resolve({ errors: [{ code: 88 }] }), text: () => Promise.resolve(''),
            });
          }
          return Promise.resolve({
            ok: true, status: 200, clone() { return this; },
            json: () => Promise.resolve(f), text: () => Promise.resolve(''),
          });
        }
        const reply = window.__apiReply;
        return Promise.resolve({
          ok: reply.status ? reply.status < 400 : true,
          status: reply.status || 200,
          clone() { return this; },
          json: () => Promise.resolve(reply.body === undefined ? { ok: 1 } : reply.body),
          text: () => Promise.resolve(''),
        });
      };
    });

    await page.evaluate(script);
    await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));

    // ---------------------------------------------------------------
    // 1. Issue #14: フォロワー一覧の二重挿入
    //    X が再レンダリングで Follow ボタンのネスト段数を変えるのを再現する
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.reset();
      const root = document.getElementById('root');
      // 1周目: Follow ボタンが rowOuter の直下（浅い形）
      root.appendChild(window.buildUserCell('alice', { nested: false, testid: '1-follow' }));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));

    const afterFirst = await page.evaluate(() =>
      document.querySelectorAll('[data-testid="UserCell"] .twblock-btn-container').length);
    check('UserCell: 1周目でコンテナが1つ挿入される', afterFirst === 1, `got ${afterFirst}`);

    // 2周目: React が作り直して、今度は1段深い形で描画する
    await page.evaluate(() => {
      const cell = document.querySelector('[data-testid="UserCell"]');
      const rowOuter = cell.firstElementChild;
      // 既存の followChild を消して、深い形の行を足す（Reactの作り直しを模す）
      [...rowOuter.children].forEach((child) => {
        if (child.querySelector('[data-testid$="-follow"]')) child.remove();
      });
      const rowInner = document.createElement('div');
      rowInner.className = 'row';
      const followChild = document.createElement('div');
      followChild.className = 'col ml12';
      const btn = document.createElement('button');
      btn.setAttribute('data-testid', '1-follow');
      btn.textContent = 'Follow';
      followChild.appendChild(btn);
      rowInner.appendChild(followChild);
      rowOuter.appendChild(rowInner);
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));

    const afterSecond = await page.evaluate(() => {
      const cell = document.querySelector('[data-testid="UserCell"]');
      const containers = cell.querySelectorAll('.twblock-btn-container');
      const follow = cell.querySelector('[data-testid$="-follow"]');
      const container = containers[0];
      return {
        count: containers.length,
        // reparent していないこと: Follow ボタンはコンテナの中に入っていない
        followInsideContainer: Boolean(container && container.contains(follow)),
        // 正しい位置（Followボタンの直前）にいること
        adjacent: Boolean(container && container.nextElementSibling &&
          container.nextElementSibling.contains(follow)),
      };
    });
    check('Issue #14: ネスト段数が変わってもコンテナは1つのまま', afterSecond.count === 1, `got ${afterSecond.count}`);
    check('Issue #14: Follow ボタンを包み直していない', afterSecond.followInsideContainer === false);
    check('Issue #14: コンテナが Follow ボタンの直前にある', afterSecond.adjacent === true);

    // Follow → Following の差し替え（Reactが新しいボタン要素を作る）でも増えない
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="1-follow"]');
      const parent = btn.parentElement;
      btn.remove();
      const next = document.createElement('button');
      next.setAttribute('data-testid', '1-unfollow');
      next.textContent = 'Following';
      parent.appendChild(next);
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
    const afterToggle = await page.evaluate(() =>
      document.querySelectorAll('[data-testid="UserCell"] .twblock-btn-container').length);
    check('Issue #14: Follow→Following の差し替えでも増えない', afterToggle === 1, `got ${afterToggle}`);

    // ブロック済みプロフィールの -unblock ボタンにもボタンが付く
    await page.evaluate(() => {
      window.reset();
      document.getElementById('root').appendChild(
        window.buildUserCell('carol', { testid: '3-unblock', label: 'Blocked' }));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
    const unblockAnchored = await page.evaluate(() =>
      document.querySelectorAll('[data-testid="UserCell"] .twblock-btn-container').length);
    check('ブロック済み行(-unblock)にもボタンが出る', unblockAnchored === 1, `got ${unblockAnchored}`);

    // Verified Followers / Following の行は justify-content: space-between。
    // Followボタンと別のflexアイテムになるので、余白を山分けされて真ん中に飛びやすい
    await page.evaluate(() => {
      window.reset();
      document.getElementById('root').appendChild(
        window.buildUserCell('dora', { spaceBetween: true, testid: '4-follow' }));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
    const spaced = await page.evaluate(() => {
      const cell = document.querySelector('[data-testid="UserCell"]');
      const cont = cell.querySelector('.twblock-btn-container');
      const follow = cell.querySelector('[data-testid$="-follow"]');
      const c = cont.getBoundingClientRect();
      const f = follow.parentElement.getBoundingClientRect();
      return { count: cell.querySelectorAll('.twblock-btn-container').length, gap: Math.round(f.left - c.right) };
    });
    check('space-between の行でもボタンが1つ', spaced.count === 1, `got ${spaced.count}`);
    check('space-between の行でもFollowボタンの隣に並ぶ',
      spaced.gap >= 0 && spaced.gap <= 8, `gap=${spaced.gap}px`);

    // ---------------------------------------------------------------
    // 2. ツイート: 二重挿入しない / RT行と本文行が別々に付く
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.reset();
      const root = document.getElementById('root');
      root.appendChild(window.buildTweet('bob'));
      root.appendChild(window.buildTweet('dave', { retweeter: 'erin' }));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
    const tweetState = await page.evaluate(() => {
      const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
      return arts.map((a) => [...a.querySelectorAll('.twblock-btn-container')]
        .map((c) => c.getAttribute('data-screen-name')));
    });
    check('ツイート: 著者ボタンが1つ', JSON.stringify(tweetState[0]) === '["bob"]', JSON.stringify(tweetState[0]));
    check('RT: RT者と著者の2つ', JSON.stringify(tweetState[1]) === '["erin","dave"]', JSON.stringify(tweetState[1]));

    // 同じDOMをもう一度 processAll に通しても増えない
    await page.evaluate(() => {
      document.querySelectorAll('[data-twblock]').forEach((el) => el.removeAttribute('data-twblock'));
      document.getElementById('root').appendChild(document.createComment('poke'));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
    const tweetAfterRescan = await page.evaluate(() => {
      const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
      return arts.map((a) => a.querySelectorAll('.twblock-btn-container').length);
    });
    check('ツイート: 再スキャンしても二重にならない',
      JSON.stringify(tweetAfterRescan) === '[1,2]', JSON.stringify(tweetAfterRescan));

    // ---------------------------------------------------------------
    // 3. ミュート → 非表示バー → ブロックへ切り替え
    // ---------------------------------------------------------------
    await page.evaluate(() => { window.__apiReply = { success: true, body: { ok: 1 } }; });
    await page.evaluate(() => {
      const btn = document.querySelector('article[data-twblock-author="bob"] .twblock-mute');
      btn.click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));

    const muted = await page.evaluate(() => {
      const art = document.querySelector('article[data-twblock-author="bob"]');
      const bar = art.querySelector(':scope > .twblock-hidden-bar');
      return {
        hasBar: Boolean(bar),
        buttons: bar ? [...bar.querySelectorAll('button')].map((b) => b.textContent) : [],
        contentHidden: art.children[1] ? art.children[1].style.display === 'none' : false,
        stored: JSON.parse(localStorage.getItem('twblock_blockedUsersV2') || '{}'),
        muteCall: window.__apiCalls.some((c) => c.url.includes('mutes/users/create.json')),
      };
    });
    check('ミュート: 非表示バーが出る', muted.hasBar);
    check('ミュート: 本文が隠れる', muted.contentHidden);
    check('ミュート: mutes/users/create.json を叩いた', muted.muteCall);
    check('要望: バーに「ブロックに切替」が出る', muted.buttons.length >= 2, JSON.stringify(muted.buttons));
    check('保存: mute 状態が記録される',
      Boolean(muted.stored.bob && muted.stored.bob.m === 1), JSON.stringify(muted.stored));

    // 「ブロックに切替」を押す
    await page.evaluate(() => {
      const bar = document.querySelector('article[data-twblock-author="bob"] > .twblock-hidden-bar');
      const buttons = [...bar.querySelectorAll('button')];
      buttons[1].click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
    const escalated = await page.evaluate(() => {
      const art = document.querySelector('article[data-twblock-author="bob"]');
      const bar = art.querySelector(':scope > .twblock-hidden-bar');
      const stored = JSON.parse(localStorage.getItem('twblock_blockedUsersV2') || '{}');
      return {
        label: bar ? bar.querySelector('.twblock-hidden-label').textContent : null,
        blockCall: window.__apiCalls.some((c) => c.url.includes('blocks/create.json')),
        state: stored.bob,
        blockBtnActive: Boolean(art.querySelector('.twblock-block.twblock-success')),
      };
    });
    check('要望: 切替で blocks/create.json を叩く', escalated.blockCall);
    check('要望: block と mute が両方立つ',
      escalated.state && escalated.state.b === 1 && escalated.state.m === 1, JSON.stringify(escalated.state));
    check('要望: バーの表示がブロック済みに変わる',
      Boolean(escalated.label && !/Muted|ミュート済み/.test(escalated.label)), escalated.label);
    check('要望: ツイート側のブロックボタンも済み表示になる', escalated.blockBtnActive);

    // ---------------------------------------------------------------
    // 4. Issue #15: 解除APIが「もうその状態じゃない」(code 272)を返しても解除できる
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.__apiReply = { status: 403, body: { errors: [{ code: 272, message: 'You are not muting the specified user.' }] } };
    });
    await page.evaluate(() => {
      const bar = document.querySelector('article[data-twblock-author="bob"] > .twblock-hidden-bar');
      bar.querySelector('button').click();  // ブロック解除
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
    const afterStuckUndo = await page.evaluate(() => {
      const art = document.querySelector('article[data-twblock-author="bob"]');
      const stored = JSON.parse(localStorage.getItem('twblock_blockedUsersV2') || '{}');
      return {
        state: stored.bob,
        barLabel: (() => {
          const bar = art.querySelector(':scope > .twblock-hidden-bar');
          return bar ? bar.querySelector('.twblock-hidden-label').textContent : null;
        })(),
      };
    });
    check('Issue #15: 403/code272 でもブロック状態が解除される',
      afterStuckUndo.state && afterStuckUndo.state.b === 0, JSON.stringify(afterStuckUndo.state));
    check('Issue #15: ミュートだけ残るのでバーはミュート表示に戻る',
      Boolean(afterStuckUndo.barLabel), afterStuckUndo.barLabel);

    // ミュート側も解除して、本文が戻ることを確認
    await page.evaluate(() => {
      const bar = document.querySelector('article[data-twblock-author="bob"] > .twblock-hidden-bar');
      bar.querySelector('button').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
    const fullyCleared = await page.evaluate(() => {
      const art = document.querySelector('article[data-twblock-author="bob"]');
      const stored = JSON.parse(localStorage.getItem('twblock_blockedUsersV2') || '{}');
      return {
        hasBar: Boolean(art.querySelector(':scope > .twblock-hidden-bar')),
        contentShown: art.children[0] ? art.children[0].style.display !== 'none' : false,
        entry: stored.bob,
      };
    });
    check('Issue #15: 全部解除でバーが消える', fullyCleared.hasBar === false);
    check('Issue #15: 本文が戻る', fullyCleared.contentShown);
    check('Issue #15: ローカル記録が消える', !fullyCleared.entry);

    // ---------------------------------------------------------------
    // 5. プロフィールでブロック: リロードせず通知バーを出す
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.__apiReply = { success: true, body: { ok: 1 } };
      window.__reloaded = false;
      window.reset();
      document.getElementById('root').appendChild(window.buildProfile('frank'));
      history.replaceState({}, '', '/frank');
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
    const profileHasButtons = await page.evaluate(() =>
      document.querySelectorAll('.twblock-btn-container.twblock-profile').length);
    check('プロフィール: ボタンが1つ出る', profileHasButtons === 1, `got ${profileHasButtons}`);

    // X が後からボタンを足しても「X のボタン群 → こちら → Follow」の並びが崩れないこと。
    // Followの直前に挿しているだけだと、後から生えたものがこちらとFollowの間に割り込む
    const beforeLate = await page.evaluate(() => {
      const cont = document.querySelector('.twblock-btn-container.twblock-profile');
      const row = cont.parentElement;
      return [...row.children].map((c) => ({ el: c, x: c.getBoundingClientRect().left }))
        .sort((a, b) => a.x - b.x)
        .map((o) => o.el.getAttribute('data-testid')
          || (String(o.el.className).includes('twblock') ? 'OURS' : '?')).join(' ');
    });
    await page.evaluate(() => window.addLateProfileButton());
    await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
    const afterLate = await page.evaluate(() => {
      const cont = document.querySelector('.twblock-btn-container.twblock-profile');
      const row = cont.parentElement;
      const visual = [...row.children].map((c) => ({ el: c, x: c.getBoundingClientRect().left }))
        .sort((a, b) => a.x - b.x)
        .map((o) => o.el.getAttribute('data-testid')
          || (String(o.el.className).includes('twblock') ? 'OURS' : '?')).join(' ');
      const dom = [...row.children].map((c) => c.getAttribute('data-testid')
        || (String(c.className).includes('twblock') ? 'OURS' : '?')).join(' ');
      return { visual, dom };
    });
    check('プロフィール: 後から足されたボタンが割り込んでも並びが変わらない',
      afterLate.visual === 'userActions lateGiftButton OURS placementTracking',
      `DOM=[${afterLate.dom}] 見た目=[${afterLate.visual}] 元=[${beforeLate}]`);

    let reloaded = false;
    page.on('framenavigated', () => { reloaded = true; });
    await page.evaluate(() => {
      document.querySelector('.twblock-btn-container.twblock-profile .twblock-block').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1200)));
    const profileAfter = await page.evaluate(() => {
      const notice = document.querySelector('.twblock-notice-bar');
      return {
        hasNotice: Boolean(notice),
        buttons: notice ? [...notice.querySelectorAll('button')].map((b) => b.textContent) : [],
        label: notice ? notice.querySelector('.twblock-hidden-label').textContent : null,
        stillOnProfile: location.pathname === '/frank',
      };
    });
    check('プロフィール: 通知バーに相手のIDは出さない（本人のページなので）',
      Boolean(profileAfter.label) && !profileAfter.label.includes('@'), profileAfter.label);
    check('要望: プロフィールのブロックでリロードしない', reloaded === false && profileAfter.stillOnProfile);
    check('要望: 代わりに通知バーが出る', profileAfter.hasNotice);
    check('要望: 通知バーはリロードだけ（解除はプロフィールのボタン側にある）',
      profileAfter.buttons.length === 1, JSON.stringify(profileAfter.buttons));

    // ミュートでは通知バーを出さない（X側の表示が変わらないので出す意味がない）
    await page.evaluate(() => {
      document.querySelector('.twblock-notice-bar').remove();
      window.reset();
      document.getElementById('root').appendChild(window.buildProfile('grace'));
      history.replaceState({}, '', '/grace');
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));
    await page.evaluate(() => {
      document.querySelector('.twblock-btn-container.twblock-profile .twblock-mute').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
    const muteOnProfile = await page.evaluate(() => ({
      notice: Boolean(document.querySelector('.twblock-notice-bar')),
      muted: Boolean(document.querySelector('.twblock-btn-container.twblock-profile .twblock-mute.twblock-success')),
    }));
    check('プロフィールのミュートでは通知バーを出さない', muteOnProfile.notice === false);
    check('プロフィールのミュートはボタンだけ済み表示になる', muteOnProfile.muted);

    // ---------------------------------------------------------------
    // 6. 解除が別の理由で失敗したときの逃げ道
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.__apiReply = { success: true, body: { ok: 1 } };
      window.reset();
      history.replaceState({}, '', '/home');
      document.getElementById('root').appendChild(window.buildTweet('heidi'));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
    await page.evaluate(() => {
      document.querySelector('article[data-twblock-author="heidi"] .twblock-mute').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
    // 解除だけ 429（レート制限）で失敗させる
    await page.evaluate(() => { window.__apiReply = { status: 429, body: { errors: [{ code: 88 }] } }; });
    await page.evaluate(() => {
      document.querySelector('article[data-twblock-author="heidi"] > .twblock-hidden-bar button').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
    const stuck = await page.evaluate(() => {
      const art = document.querySelector('article[data-twblock-author="heidi"]');
      const bar = art.querySelector(':scope > .twblock-hidden-bar');
      return {
        stillHidden: Boolean(bar),
        hasForce: Boolean(bar && bar.querySelector('.twblock-bar-force')),
        stored: JSON.parse(localStorage.getItem('twblock_blockedUsersV2') || '{}').heidi,
      };
    });
    check('失敗時: バーは残り、状態も消えない', stuck.stillHidden && Boolean(stuck.stored));
    check('失敗時: 「強制的に表示」が出る', stuck.hasForce);

    await page.evaluate(() => {
      document.querySelector('article[data-twblock-author="heidi"] .twblock-bar-force').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
    const forced = await page.evaluate(() => {
      const art = document.querySelector('article[data-twblock-author="heidi"]');
      return {
        hasBar: Boolean(art.querySelector(':scope > .twblock-hidden-bar')),
        contentShown: art.children[0] ? art.children[0].style.display !== 'none' : false,
        stored: JSON.parse(localStorage.getItem('twblock_blockedUsersV2') || '{}').heidi,
      };
    });
    check('失敗時: 強制表示でローカル記録だけ消えて本文が戻る',
      !forced.hasBar && forced.contentShown && !forced.stored,
      JSON.stringify(forced));

    // ---------------------------------------------------------------
    // 7. 一覧の行をプロフィールと取り違えない
    //    （UserCell がまだ付いていない瞬間でも、行のユーザーに対して動くこと）
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.reset();
      history.replaceState({}, '', '/frank/followers');
      const li = document.createElement('div');
      li.setAttribute('role', 'listitem');
      const cell = window.buildUserCell('ivan', { testid: '7-follow' });
      // UserCell の印だけまだ付いていない状態を作る
      cell.removeAttribute('data-testid');
      // Follow ボタンを placementTracking で包む（プロフィールと同じ形）
      const followChild = cell.querySelector('[data-testid="7-follow"]').parentElement;
      followChild.setAttribute('data-testid', 'placementTracking');
      li.appendChild(cell);
      document.getElementById('root').appendChild(li);
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));
    const listMisread = await page.evaluate(() => {
      const c = document.querySelector('.twblock-btn-container');
      return {
        name: c ? c.getAttribute('data-screen-name') : null,
        isProfileClass: Boolean(c && c.classList.contains('twblock-profile')),
      };
    });
    check('一覧の行をプロフィール主と取り違えない', listMisread.name === 'ivan', JSON.stringify(listMisread));
    check('一覧の行に twblock-profile が付かない', listMisread.isProfileClass === false);

    // ---------------------------------------------------------------
    // 8. 同じユーザーの投稿が2箇所にあるとき、両方のバーが追随する
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.__apiReply = { success: true, body: { ok: 1 } };
      window.reset();
      history.replaceState({}, '', '/home');
      const root = document.getElementById('root');
      root.appendChild(window.buildTweet('judy'));
      root.appendChild(window.buildTweet('judy'));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));
    await page.evaluate(() => {
      document.querySelectorAll('article[data-twblock-author="judy"] .twblock-mute')[0].click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
    const bothMuted = await page.evaluate(() =>
      [...document.querySelectorAll('article[data-twblock-author="judy"] > .twblock-hidden-bar')].length);
    check('同一ユーザー: 2枚とも畳まれる', bothMuted === 2, `got ${bothMuted}`);

    await page.evaluate(() => {
      const bar = document.querySelectorAll('article[data-twblock-author="judy"] > .twblock-hidden-bar')[0];
      [...bar.querySelectorAll('button')][1].click();  // ブロックに切替
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1000)));
    const barsAfterEscalate = await page.evaluate(() => {
      const bars = [...document.querySelectorAll('article[data-twblock-author="judy"] > .twblock-hidden-bar')];
      return {
        labels: bars.map((b) => b.querySelector('.twblock-hidden-label').textContent),
        buttonCounts: bars.map((b) => b.querySelectorAll('button').length),
        blockCalls: window.__apiCalls.filter((c) => c.url.includes('blocks/create.json')).length,
      };
    });
    const sameLabel = new Set(barsAfterEscalate.labels).size === 1;
    check('同一ユーザー: もう片方のバーも「ブロック済み」に追随する',
      sameLabel, JSON.stringify(barsAfterEscalate.labels));
    check('同一ユーザー: 追随後のバーから「切替」が消える',
      barsAfterEscalate.buttonCounts.every((n) => n === 1), JSON.stringify(barsAfterEscalate.buttonCounts));

    // 古いバーの切替を押してもブロックAPIを二度投げない（統計の二重加算防止）
    const statsBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('twblock_stats') || '{}'));
    await page.evaluate(() => {
      const bars = [...document.querySelectorAll('article[data-twblock-author="judy"] > .twblock-hidden-bar')];
      const btns = [...bars[1].querySelectorAll('button')];
      if (btns[1]) btns[1].click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));
    const statsAfter = await page.evaluate(() => ({
      stats: JSON.parse(localStorage.getItem('twblock_stats') || '{}'),
      blockCalls: window.__apiCalls.filter((c) => c.url.includes('blocks/create.json')).length,
    }));
    check('同一ユーザー: ブロックが二重にカウントされない',
      (statsAfter.stats.blocked || 0) === (statsBefore.blocked || 0),
      JSON.stringify(statsAfter));

    // ---------------------------------------------------------------
    // 9. block と mute の両方が立っている状態での「強制的に表示」
    // ---------------------------------------------------------------
    await page.evaluate(() => { window.__apiReply = { status: 500, body: {} }; });
    await page.evaluate(() => {
      const bar = document.querySelector('article[data-twblock-author="judy"] > .twblock-hidden-bar');
      bar.querySelector('button').click();  // ブロック解除 → 500 で失敗
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
    await page.evaluate(() => {
      document.querySelector('article[data-twblock-author="judy"] .twblock-bar-force').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));
    const forcedBoth = await page.evaluate(() => {
      const arts = [...document.querySelectorAll('article[data-twblock-author="judy"]')];
      return {
        bars: arts.filter((a) => a.querySelector(':scope > .twblock-hidden-bar')).length,
        shown: arts.every((a) => a.children[0] && a.children[0].style.display !== 'none'),
        stored: JSON.parse(localStorage.getItem('twblock_blockedUsersV2') || '{}').judy,
      };
    });
    check('強制表示: block と mute の両方が落ちて本文が戻る',
      forcedBoth.bars === 0 && forcedBoth.shown && !forcedBoth.stored,
      JSON.stringify(forcedBoth));

    // ---------------------------------------------------------------
    // 10. プロフィール通知バーが、同じページで解除したときに消える
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.__apiReply = { success: true, body: { ok: 1 } };
      window.reset();
      document.getElementById('root').appendChild(window.buildProfile('karl'));
      history.replaceState({}, '', '/karl');
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));
    await page.evaluate(() => {
      document.querySelector('.twblock-btn-container.twblock-profile .twblock-block').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1000)));
    const noticeShown = await page.evaluate(() => Boolean(document.querySelector('.twblock-notice-bar')));
    check('プロフィール: 通知バーが出る（再確認）', noticeShown);

    await page.evaluate(() => {
      document.querySelector('.twblock-btn-container.twblock-profile .twblock-block').click();  // 解除
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1000)));
    const noticeGone = await page.evaluate(() => ({
      notice: Boolean(document.querySelector('.twblock-notice-bar')),
      stored: JSON.parse(localStorage.getItem('twblock_blockedUsersV2') || '{}').karl,
    }));
    check('プロフィール: 解除したら通知バーも消える',
      noticeGone.notice === false && !noticeGone.stored, JSON.stringify(noticeGone));

    // ---------------------------------------------------------------
    // 11. 「フォロー中の相手をブロックする前に確認」
    // ---------------------------------------------------------------
    check('確認: フォローしていない相手では確認を出さない', dialogs.length === 0, JSON.stringify(dialogs));

    async function blockFresh(name, followReply) {
      await page.evaluate((n, f) => {
        window.__apiReply = { success: true, body: { ok: 1 } };
        window.__followReply = f;
        window.reset();
        history.replaceState({}, '', '/home');
        document.getElementById('root').appendChild(window.buildTweet(n));
      }, name, followReply);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
      await page.evaluate((n) => {
        document.querySelector('article[data-twblock-author="' + n + '"] .twblock-block').click();
      }, name);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 1200)));
    }

    dialogs.length = 0;
    await blockFresh('leo', { relationship: { source: { following: true } } });
    check('確認: フォロー中の相手では確認が出る', dialogs.length === 1, JSON.stringify(dialogs));

    dialogs.length = 0;
    await blockFresh('mona', null);  // friendships/show が 429
    check('確認: フォロー判定に失敗したときも確認が出る（黙って素通ししない）',
      dialogs.length === 1, JSON.stringify(dialogs));

    await page.evaluate(() => { window.__followReply = { relationship: { source: { following: false } } }; });

    // ---------------------------------------------------------------
    // 11b. 表示言語の設定
    // ---------------------------------------------------------------
    async function labelWith(settings, htmlLang) {
      await page.evaluate((s, lang) => {
        document.documentElement.lang = lang;
        localStorage.setItem('twblock_settings', JSON.stringify(s));
        window.dispatchEvent(new StorageEvent('storage', {
          key: 'twblock_settings', newValue: JSON.stringify(s),
        }));
      }, settings, htmlLang);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));
      await page.evaluate(() => {
        window.reset();
        history.replaceState({}, '', '/home');
        document.getElementById('root').appendChild(window.buildTweet('lang_probe'));
      });
      await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
      return page.evaluate(() => {
        const btn = document.querySelector('article[data-twblock-author="lang_probe"] .twblock-block');
        return btn ? btn.getAttribute('aria-label') : null;
      });
    }

    const base = { showBlock: true, showMute: true, confirmBlockFollowing: false };
    const jaFixed = await labelWith(Object.assign({}, base, { language: 'ja' }), 'en');
    check('言語: 日本語を指定するとXが英語でも日本語になる',
      Boolean(jaFixed && jaFixed.indexOf('ブロック') === 0), jaFixed);

    const enFixed = await labelWith(Object.assign({}, base, { language: 'en' }), 'ja');
    check('言語: Englishを指定するとXが日本語でも英語になる',
      Boolean(enFixed && enFixed.indexOf('Block') === 0), enFixed);

    const followSiteEn = await labelWith(Object.assign({}, base, { language: 'x' }), 'en');
    check('言語: Xに合わせる → Xが英語なら英語',
      Boolean(followSiteEn && followSiteEn.indexOf('Block') === 0), followSiteEn);

    const followSiteJa = await labelWith(Object.assign({}, base, { language: 'x' }), 'ja');
    check('言語: Xに合わせる → Xが日本語なら日本語',
      Boolean(followSiteJa && followSiteJa.indexOf('ブロック') === 0), followSiteJa);

    // ブラウザに合わせる = X の言語が変わっても文言が動かないこと
    const browserOnJa = await labelWith(Object.assign({}, base, { language: 'browser' }), 'ja');
    const browserOnEn = await labelWith(Object.assign({}, base, { language: 'browser' }), 'en');
    check('言語: ブラウザに合わせる → Xの言語が変わっても文言が動かない',
      Boolean(browserOnJa) && browserOnJa === browserOnEn,
      `X=ja:[${browserOnJa}] X=en:[${browserOnEn}]`);

    await page.evaluate(() => {
      document.documentElement.lang = 'en';
      const s = { showBlock: true, showMute: true, confirmBlockFollowing: true, language: 'en' };
      localStorage.setItem('twblock_settings', JSON.stringify(s));
      window.dispatchEvent(new StorageEvent('storage', { key: 'twblock_settings', newValue: JSON.stringify(s) }));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));

    // ---------------------------------------------------------------
    // 12. リポスト行のボタンで押したときも投稿が畳まれる
    // ---------------------------------------------------------------
    await page.evaluate(() => {
      window.__apiReply = { success: true, body: { ok: 1 } };
      window.reset();
      history.replaceState({}, '', '/home');
      const root = document.getElementById('root');
      root.appendChild(window.buildTweet('nina', { retweeter: 'oscar' }));
      root.appendChild(window.buildTweet('paul', { retweeter: 'oscar' }));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));
    await page.evaluate(() => {
      document.querySelector('.twblock-repost[data-screen-name="oscar"] .twblock-mute').click();
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 1000)));
    const repostHidden = await page.evaluate(() => {
      const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
      return {
        bars: arts.filter((a) => a.querySelector(':scope > .twblock-hidden-bar')).length,
        hidden: arts.filter((a) => a.children[1] && a.children[1].style.display === 'none').length,
        stored: JSON.parse(localStorage.getItem('twblock_blockedUsersV2') || '{}').oscar,
      };
    });
    check('リポスト: RT者をミュートしたらその投稿が畳まれる',
      repostHidden.bars === 2 && Boolean(repostHidden.stored), JSON.stringify(repostHidden));

    // 別人の投稿は畳まれない（属性の取り違えが無いこと）
    await page.evaluate(() => {
      const root = document.getElementById('root');
      root.appendChild(window.buildTweet('quinn'));
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
    const otherUntouched = await page.evaluate(() => {
      const art = document.querySelector('article[data-twblock-author="quinn"]');
      return Boolean(art && !art.querySelector(':scope > .twblock-hidden-bar'));
    });
    check('リポスト: 無関係な投稿は畳まれない', otherUntouched);


  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
